import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"

import { parseArgs } from "../lib/args.js"
import { resolvePackageJson } from "../lib/resolve-schemas.js"
import type { CommandContext, CommandResult } from "../types.js"

const MANAGED_PROFILE_FILENAME = "managed-profile.json"
const FRAMEWORK_PACKAGE = "@voyant-travel/framework"

interface DoctorIssue {
  message: string
  details?: string[]
}

/**
 * The slice of `@voyant-travel/framework/profile` the doctor uses. Loaded
 * dynamically from the DEPLOYMENT's installed framework (not bundled by the CLI),
 * so validation runs against the exact framework version the deployment ships.
 */
export interface FrameworkProfileApi {
  validateVoyantProject(input: unknown): {
    ok: boolean
    issues: ReadonlyArray<{ path: string; message: string }>
  }
  getVoyantProjectMigrationMetadata(project: unknown): {
    moduleSources: ReadonlyArray<{ packageName: string; priority: number }>
  }
  resolveActiveModuleIds(project: unknown): string[]
}

/** The framework loaded from the deployment, with its installed version. */
export interface LoadedFramework {
  api: FrameworkProfileApi
  version: string | null
}

/** Injection seam for tests. */
export interface ManagedDbDoctorDeps {
  /** Load the deployment's framework/profile API + version, or null when absent. */
  loadFramework: (cwd: string) => Promise<LoadedFramework | null>
  resolvePackageJson: typeof resolvePackageJson
}

/**
 * Load `@voyant-travel/framework/profile` from the deployment at `cwd` via the
 * package's own `exports` map (works for the framework's import-only ESM export,
 * which `require.resolve` would reject). Returns null when the framework is not
 * installed or its `./profile` entry can't be located.
 */
export async function loadDeploymentFramework(
  cwd: string,
  resolvePkgJson: typeof resolvePackageJson = resolvePackageJson,
): Promise<LoadedFramework | null> {
  const pkgJsonPath = resolvePkgJson(FRAMEWORK_PACKAGE, cwd)
  if (!pkgJsonPath) return null
  let pkg: { version?: string; exports?: Record<string, unknown> }
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"))
  } catch {
    return null
  }
  const profileExport = pkg.exports?.["./profile"]
  const entryRel =
    typeof profileExport === "string"
      ? profileExport
      : ((profileExport as { import?: string } | undefined)?.import ?? null)
  if (!entryRel) return null
  const entryPath = join(dirname(pkgJsonPath), entryRel)
  try {
    const api = (await import(pathToFileURL(entryPath).href)) as unknown as FrameworkProfileApi
    return { api, version: typeof pkg.version === "string" ? pkg.version : null }
  } catch {
    return null
  }
}

/**
 * Resolve the managed-profile snapshot to doctor: an explicit `--snapshot <path>`,
 * else `managed-profile.json` at the cwd. Returns `null` when neither is present,
 * so the caller falls back to the source-backed (drizzle.config) doctor.
 */
export function resolveManagedSnapshotPath(
  cwd: string,
  snapshotFlag: string | boolean | undefined,
): string | null {
  if (typeof snapshotFlag === "string" && snapshotFlag.length > 0) {
    return isAbsolute(snapshotFlag) ? snapshotFlag : resolvePath(cwd, snapshotFlag)
  }
  const candidate = join(cwd, MANAGED_PROFILE_FILENAME)
  return existsSync(candidate) ? candidate : null
}

/**
 * `voyant db doctor` for a SOURCE-FREE managed profile: no `drizzle.config`, no
 * `voyant.config.ts` — the input is a serialized `managed-profile.json` snapshot
 * (`defineVoyantProject(...)`). Static, DB-free, report-by-default (exit 0);
 * `--fail-on-drift` gates CI.
 *
 * Runs against the DEPLOYMENT's installed framework (loaded from `cwd`) and
 * verifies the managed migration path will apply cleanly:
 *  1. the snapshot is a valid Voyant project (the deployment framework's validator)
 *  2. the installed `@voyant-travel/framework` matches the snapshot's
 *     `frameworkVersion` — the composed API graph and shipped migration bundle
 *     are version-pinned, so drift here means the wrong bundle
 *  3. every declared custom-source module resolves to an installed package and,
 *     if schema-owning, ships a committed `migrations/` folder — the same
 *     `[framework, ...customModules]` the managed migrate booter applies (voyant#3069)
 */
export async function managedDbDoctorCommand(
  ctx: CommandContext,
  options: { snapshotPath: string } & Partial<ManagedDbDoctorDeps>,
): Promise<CommandResult> {
  const { snapshotPath } = options
  const resolvePkgJson = options.resolvePackageJson ?? resolvePackageJson
  const loadFramework =
    options.loadFramework ?? ((cwd) => loadDeploymentFramework(cwd, resolvePkgJson))
  const { flags } = parseArgs(ctx.argv)
  const failOnDrift = flags["fail-on-drift"] === true

  const issues: DoctorIssue[] = []
  const notes: string[] = []

  let snapshot: unknown
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"))
  } catch (err) {
    ctx.stderr(`Could not read managed profile snapshot at ${snapshotPath}: ${reason(err)}\n`)
    return 1
  }

  const framework = await loadFramework(ctx.cwd)
  if (!framework) {
    issues.push({
      message: `${FRAMEWORK_PACKAGE} is not installed here — cannot validate the managed profile.`,
      details: ["Run from the deployment root where the framework is installed."],
    })
    printReport(ctx, { snapshotPath, issues, notes, failOnDrift })
    return failOnDrift ? 1 : 0
  }
  const { api, version } = framework

  // 1. snapshot validity — an invalid snapshot can't be reasoned about further.
  const validation = api.validateVoyantProject(snapshot)
  if (!validation.ok) {
    issues.push({
      message: "Managed profile snapshot is invalid:",
      details: validation.issues.map((i) => `${i.path}: ${i.message}`),
    })
    printReport(ctx, { snapshotPath, issues, notes, failOnDrift })
    return failOnDrift ? 1 : 0
  }
  const project = snapshot as { profile: string; schemaVersion: string; frameworkVersion: string }
  notes.push(`Snapshot: valid "${project.profile}" profile (schema ${project.schemaVersion}).`)

  // 2. framework version consistency
  if (version && version !== project.frameworkVersion) {
    issues.push({
      message: `Framework version drift: snapshot pins ${project.frameworkVersion}, installed ${FRAMEWORK_PACKAGE} is ${version}.`,
      details: [
        "Regenerate the snapshot against the installed framework, or install the pinned version.",
      ],
    })
  } else if (version) {
    notes.push(`Framework: installed ${FRAMEWORK_PACKAGE}@${version} matches the snapshot.`)
  }

  // 3. custom-source module migrations (the managed booter's [framework, ...customModules])
  let moduleSources: ReadonlyArray<{ packageName: string; priority: number }> = []
  try {
    moduleSources = api.getVoyantProjectMigrationMetadata(project).moduleSources
  } catch (err) {
    issues.push({ message: `Could not derive migration metadata: ${reason(err)}` })
  }
  if (moduleSources.length === 0) {
    notes.push("Custom modules: none declared — standard framework bundle only.")
  }
  for (const { packageName, priority } of moduleSources) {
    const status = moduleMigrationStatus(packageName, ctx.cwd, resolvePkgJson)
    if (status === "missing") {
      issues.push({
        message: `Custom module "${packageName}" (priority ${priority}) is declared but not installed — its migrations cannot run.`,
      })
    } else if (status === "schema-less") {
      notes.push(`Custom module "${packageName}": installed, owns no schema (no migrations/).`)
    } else {
      notes.push(
        `Custom module "${packageName}": ships ${status} migration(s) (priority ${priority}).`,
      )
    }
  }

  // 4. resolved module subset (informational)
  try {
    notes.push(
      `Modules: ${api.resolveActiveModuleIds(project).length} active in the resolved subset.`,
    )
  } catch {
    // resolveActiveModuleIds throws only on an invalid project, already reported above.
  }

  printReport(ctx, { snapshotPath, issues, notes, failOnDrift })
  return failOnDrift && issues.length > 0 ? 1 : 0
}

/**
 * Whether a declared custom module is installed and ships committed migrations —
 * mirrors the collector's null-vs-source decision (`migrations/meta/_journal.json`
 * present) without loading the SQL. Returns the migration count, `"schema-less"`
 * (installed, no migrations/), or `"missing"` (not installed).
 */
function moduleMigrationStatus(
  packageName: string,
  cwd: string,
  resolvePkgJson: typeof resolvePackageJson,
): number | "schema-less" | "missing" {
  const pkgJsonPath = resolvePkgJson(packageName, cwd)
  if (!pkgJsonPath) return "missing"
  const journalPath = join(dirname(pkgJsonPath), "migrations", "meta", "_journal.json")
  if (!existsSync(journalPath)) return "schema-less"
  try {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries?: unknown[] }
    return Array.isArray(journal.entries) ? journal.entries.length : 0
  } catch {
    return 0
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function printReport(
  ctx: CommandContext,
  args: { snapshotPath: string; issues: DoctorIssue[]; notes: string[]; failOnDrift: boolean },
): void {
  ctx.stdout("voyant db doctor (managed profile)\n")
  ctx.stdout(`  snapshot: ${args.snapshotPath}\n\n`)

  for (const note of args.notes) ctx.stdout(`  OK    ${note}\n`)
  for (const issue of args.issues) {
    ctx.stdout(`  WARN  ${issue.message}\n`)
    for (const detail of issue.details ?? []) ctx.stdout(`          - ${detail}\n`)
  }

  if (args.issues.length === 0) {
    ctx.stdout("\nNo drift detected.\n")
    return
  }
  ctx.stdout(
    `\n${args.issues.length} issue(s) reported. ` +
      (args.failOnDrift
        ? "Exiting non-zero (--fail-on-drift).\n"
        : "Report mode exits 0; pass --fail-on-drift to gate CI.\n"),
  )
}
