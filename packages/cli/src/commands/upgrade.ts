/**
 * `voyant upgrade [--to <version>] [--dry-run] [--package <name>]`
 *
 * Bumps the deployment's framework BOM — `@voyant-travel/framework` — to one
 * version, then installs. The BOM's pinned `dependencies` transitively resolve
 * the whole tested runtime set, so a deployment tracks a single version instead
 * of a per-package matrix (consolidated-deployments RFC, Workstream A). This is
 * the first step of the upgrade path: `voyant upgrade && voyant db migrate &&
 * voyant doctor`.
 *
 * It edits the nearest `package.json`, replacing the BOM's version range, and
 * runs the detected package manager's install. `--to` pins an explicit version
 * (default: the latest published); `--dry-run` reports without writing.
 */
import { execFileSync, spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, parse as parsePath } from "node:path"

import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import {
  authoringGraphSelections,
  diffGraphSelections,
  resolvedGraphSelections,
} from "../lib/graph-diff.js"
import { detectPackageManager, readProjectManifest } from "../lib/package-lifecycle.js"
import {
  createPackageLifecyclePlan,
  renderPackageLifecyclePlan,
} from "../lib/package-lifecycle-plan.js"
import { type AuthoringProjectConfig, parseProjectConfig } from "../lib/project-config.js"
import { type ResolvedProjectGraph, resolveProject } from "../lib/project-resolution.js"
import type { CommandContext, CommandResult } from "../types.js"

const BOM_PACKAGE = "@voyant-travel/framework"

/** Injectable side effects (network/install) so the command is unit-testable. */
export interface UpgradeDeps {
  /** Resolve a package's latest published version; `null` if unavailable. */
  resolveLatestVersion?: (pkg: string) => string | null
  /** Run the package manager's install in `cwd`; resolves to its exit code. */
  runInstall?: (cwd: string, manager: string) => Promise<number>
  /** Resolve graph snapshots around the requested dependency change when supported. */
  resolveGraphPlan?: (
    input: UpgradeGraphPlanInput,
  ) => Promise<UpgradeGraphPlanSnapshots> | UpgradeGraphPlanSnapshots
}

export interface UpgradeGraphPlanInput {
  cwd: string
  packageName: string
  beforeVersion: string
  afterVersion: string
}

export interface UpgradeGraphPlanSnapshots {
  before: ResolvedProjectGraph | null
  after: ResolvedProjectGraph | null
}

export async function upgradeCommand(
  ctx: CommandContext,
  deps: UpgradeDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, { booleanFlags: ["dry-run", "plan"] })
  const pkgName = getStringFlag(args, "package") ?? args.positionals[0] ?? BOM_PACKAGE
  const explicit = getStringFlag(args, "to")
  const planOnly = getBooleanFlag(args, "dry-run", "plan")

  const pkgPath = findNearestPackageJson(ctx.cwd)
  if (!pkgPath) {
    ctx.stderr("voyant upgrade: no package.json found from the current directory.\n")
    return 1
  }

  const manifest = readProjectManifest(pkgPath)
  const targetDeps =
    (manifest.dependencies?.[pkgName] && manifest.dependencies) ||
    (manifest.devDependencies?.[pkgName] && manifest.devDependencies) ||
    null
  if (!targetDeps) {
    ctx.stderr(`voyant upgrade: ${pkgName} is not a dependency in ${pkgPath}.\n`)
    return 1
  }

  const current = targetDeps[pkgName] as string
  if (current.startsWith("workspace:")) {
    if (planOnly) {
      const dir = dirname(pkgPath)
      ctx.stdout(
        renderPackageLifecyclePlan(
          createPackageLifecyclePlan({
            operation: "upgrade",
            packageManager: detectPackageManager(dir, manifest),
          }),
        ),
      )
      return 0
    }
    ctx.stdout(
      `voyant upgrade: ${pkgName} is a workspace dependency (${current}) — ` +
        "nothing to bump inside the monorepo.\n",
    )
    return 0
  }

  const resolveLatest = deps.resolveLatestVersion ?? defaultResolveLatestVersion
  const target = explicit ?? resolveLatest(pkgName)
  if (!target) {
    ctx.stderr(
      `voyant upgrade: could not resolve the latest ${pkgName} version ` +
        "(is npm reachable? pass --to <version>).\n",
    )
    return 1
  }

  const nextRange = normalizeRange(target)
  if (current === nextRange && !planOnly) {
    ctx.stdout(`Already on ${pkgName}@${current}.\n`)
    return 0
  }

  const dir = dirname(pkgPath)
  const manager = detectPackageManager(dir, manifest)
  if (planOnly) {
    const configPath = findNearestManagedProjectConfig(dir)
    let config: AuthoringProjectConfig | undefined
    let blockedBy: { code: string; message: string } | undefined
    if (!configPath) {
      blockedBy = {
        code: "project_config_missing",
        message: "graph-aware upgrade planning requires a voyant.config.ts file",
      }
    } else {
      try {
        config = parseProjectConfig(readFileSync(configPath, "utf8"))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        blockedBy = {
          code: "project_config_not_editable",
          message: `graph-aware upgrade planning cannot structurally edit voyant.config.ts: ${reason}`,
        }
      }
    }

    let snapshots: UpgradeGraphPlanSnapshots = { before: null, after: null }
    if (!blockedBy && config) {
      snapshots = await resolveUpgradeGraphPlan(
        dir,
        pkgName,
        current,
        nextRange,
        deps.resolveGraphPlan,
      )
    }
    const beforeSelections = snapshots.before
      ? resolvedGraphSelections(snapshots.before)
      : config
        ? authoringGraphSelections(config)
        : { modules: [], plugins: [] }
    const afterSelections = snapshots.after
      ? resolvedGraphSelections(snapshots.after)
      : beforeSelections
    const plan = createPackageLifecyclePlan({
      operation: "upgrade",
      packageManager: manager,
      dependencyChanges: [
        {
          packageName: pkgName,
          section: manifest.dependencies?.[pkgName] ? "dependencies" : "devDependencies",
          before: current,
          after: nextRange,
        },
      ],
      selections: diffGraphSelections(beforeSelections, afterSelections),
      beforeContentHash: snapshots.before?.contentHash ?? null,
      afterContentHash: snapshots.after?.contentHash ?? null,
      ...(blockedBy ? { blockedBy } : {}),
    })
    ctx.stdout(renderPackageLifecyclePlan(plan))
    return plan.status === "blocked" ? 1 : 0
  }

  targetDeps[pkgName] = nextRange
  writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`)
  ctx.stdout(`Updated ${pkgName}: ${current} → ${nextRange}\n`)

  const runInstall = deps.runInstall ?? defaultRunInstall
  ctx.stdout(`Installing with ${manager}…\n`)
  const code = await runInstall(dir, manager)
  if (code !== 0) {
    ctx.stderr(`voyant upgrade: ${manager} install failed (exit ${code}).\n`)
    return code
  }

  ctx.stdout(
    "\nUpgraded. Next steps:\n" +
      "  voyant db migrate   # apply any new framework migrations\n" +
      "  voyant doctor       # verify env, schema, and admin composition\n",
  )
  return 0
}

/** Walk up from `cwd` to the nearest `package.json`. */
function findNearestPackageJson(cwd: string): string | null {
  let dir = cwd
  for (;;) {
    const candidate = join(dir, "package.json")
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = parsePath(dir).dir
    if (!parent || parent === dir) {
      return null
    }
    dir = parent
  }
}

/** Pin a resolved version as a caret range; pass through an explicit range. */
function normalizeRange(version: string): string {
  return /^[\^~><=*]|\s|x/.test(version) ? version : `^${version}`
}

function defaultResolveLatestVersion(pkg: string): string | null {
  try {
    return execFileSync("npm", ["view", pkg, "version"], { encoding: "utf8" }).trim() || null
  } catch {
    return null
  }
}

function defaultRunInstall(cwd: string, manager: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(manager, ["install"], { cwd, stdio: "inherit", shell: false })
    child.on("exit", (code) => resolve(code ?? 0))
    child.on("error", () => resolve(1))
  })
}

async function resolveUpgradeGraphPlan(
  cwd: string,
  packageName: string,
  beforeVersion: string,
  afterVersion: string,
  resolver: UpgradeDeps["resolveGraphPlan"],
): Promise<UpgradeGraphPlanSnapshots> {
  if (resolver) {
    try {
      return await resolver({ cwd, packageName, beforeVersion, afterVersion })
    } catch {
      return { before: null, after: null }
    }
  }

  try {
    const before = (await resolveProject(cwd)).graph
    return { before, after: beforeVersion === afterVersion ? before : null }
  } catch {
    return { before: null, after: null }
  }
}

function findNearestManagedProjectConfig(cwd: string): string | null {
  let dir = cwd
  for (;;) {
    const candidate = join(dir, "voyant.config.ts")
    if (existsSync(candidate)) return candidate
    const parent = parsePath(dir).dir
    if (!parent || parent === dir) return null
    dir = parent
  }
}
