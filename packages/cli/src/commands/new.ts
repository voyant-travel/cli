import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { x } from "tar"

import { parseArgs } from "../lib/args.js"
import { compareCodeUnits } from "../lib/strings.js"
import { VOYANT_FRAMEWORK_VERSION, VOYANT_RUNTIME_VERSION } from "../lib/voyant-version.js"
import {
  cleanProjectFiles,
  DEFAULT_PROJECT_PRESET,
  UNAVAILABLE_PROJECT_PRESETS,
} from "../templates/project-files.js"
import {
  type GeneratedSelfHostProject,
  type SelfHostExportApi,
  selfHostExportProjectFiles,
} from "../templates/self-host-export-project.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * Directory / file names that should never be copied from a source
 * starter (they're either ephemeral or deployment-local).
 */
const SKIP_PATHS = new Set([
  "node_modules",
  ".git",
  ".github",
  ".turbo",
  ".tanstack",
  "dist",
  ".wrangler",
  ".next",
  ".vite",
  "coverage",
  ".cache",
  ".env",
  ".env.local",
  ".dev.vars",
  ".dev.vars.local",
  ".DS_Store",
])

const BUILT_IN_STARTERS = new Set(["operator"])
const STARTER_RELEASE_BASE_URL =
  process.env.VOYANT_STARTER_BASE_URL ?? "https://github.com/voyant-travel/voyant/releases/download"

/**
 * `voyant new <name> [--preset operator-standard | --starter <name|path>] [--force]`
 *
 * Scaffold a new Voyant project at `<cwd>/<name>`. The default path writes a
 * clean convention-based project; the compatibility starter path copies a
 * directory and rewrites its package metadata.
 *
 * The normal path writes a clean project using the standard Operator defaults.
 * `--starter` is an explicit compatibility path
 * for copying the legacy operator application or another starter directory.
 * The starter source is resolved (in priority order):
 *   1. `--starter <path>` — absolute or cwd-relative path
 *   2. `--starter <name>` — built-in / discoverable starter alias
 *   3. repo-local `starters/<name>` or sibling `voyant/starters/<name>`
 *   4. version-matched starter tarball from GitHub Releases
 */
export interface NewCommandOptions {
  loadSelfHostExportApi?: () => Promise<SelfHostExportApi>
  selfHostProjectFileSystem?: SelfHostProjectFileSystem
}

export interface SelfHostProjectFileSystem {
  existsSync: typeof existsSync
  mkdirSync: typeof mkdirSync
  mkdtempSync: typeof mkdtempSync
  renameSync: typeof renameSync
  rmSync: typeof rmSync
  writeFileSync: typeof writeFileSync
}

const DEFAULT_SELF_HOST_PROJECT_FILE_SYSTEM: SelfHostProjectFileSystem = {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
}

export async function newCommand(
  ctx: CommandContext,
  options: NewCommandOptions = {},
): Promise<CommandResult> {
  const { positionals, flags } = parseArgs(ctx.argv, { booleanFlags: ["force", "json"] })
  const [name] = positionals
  if (!name) {
    ctx.stderr(
      "Usage: voyant new <name> [--preset operator-standard | --starter <name|path> | --from-export <bundle.json>] [--force]\n",
    )
    return 1
  }

  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name)) {
    ctx.stderr(`Invalid project name: ${name}\n`)
    return 1
  }

  const target = isAbsolute(name) ? name : resolve(ctx.cwd, name)
  const force = flags.force === true

  if (existsSync(target) && !force) {
    ctx.stderr(`Target directory already exists: ${target}\nUse --force to overwrite.\n`)
    return 1
  }

  if ("template" in flags) {
    ctx.stderr("Unknown option for voyant new: --template. Use --preset or --starter.\n")
    return 1
  }

  const starterFlag = flags.starter
  const presetFlag = flags.preset
  const exportFlag = flags["from-export"]
  const selectedSources = [starterFlag, presetFlag, exportFlag].filter(
    (value) => value !== undefined,
  )
  if (selectedSources.length > 1) {
    ctx.stderr("voyant new: --preset, --starter, and --from-export cannot be used together.\n")
    return 1
  }

  if (exportFlag !== undefined) {
    if (typeof exportFlag !== "string") {
      ctx.stderr("voyant new: --from-export requires a bundle JSON path.\n")
      return 1
    }
    return generateFromSelfHostExport(ctx, {
      name,
      target,
      force,
      bundlePath: isAbsolute(exportFlag) ? exportFlag : resolve(ctx.cwd, exportFlag),
      loadApi: options.loadSelfHostExportApi ?? loadSelfHostExportApi,
      fileSystem: options.selfHostProjectFileSystem ?? DEFAULT_SELF_HOST_PROJECT_FILE_SYSTEM,
    })
  }

  if (ctx.argv.some((arg) => arg === "--provider" || arg.startsWith("--provider="))) {
    ctx.stderr("voyant new: --provider can only be used with --from-export.\n")
    return 1
  }

  if (starterFlag === undefined) {
    const preset = typeof presetFlag === "string" ? presetFlag : DEFAULT_PROJECT_PRESET
    const unavailable =
      UNAVAILABLE_PROJECT_PRESETS[preset as keyof typeof UNAVAILABLE_PROJECT_PRESETS]
    if (unavailable) {
      writeUnavailablePresetDiagnostic(ctx, flags, preset, unavailable)
      return 1
    }
    if (presetFlag === true || preset !== DEFAULT_PROJECT_PRESET) {
      ctx.stderr(
        `Unknown preset: ${presetFlag === true ? "(missing)" : preset}. Expected ${DEFAULT_PROJECT_PRESET}.\n`,
      )
      return 1
    }

    try {
      for (const [relPath, content] of cleanProjectFiles(name)) {
        const file = join(target, relPath)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, content)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.stderr(`Failed to write ${preset} preset: ${reason}\n`)
      return 1
    }

    printNextSteps(ctx, name, target)
    return 0
  }

  let starterSource: StarterSource | null
  try {
    starterSource = await resolveStarter(ctx.cwd, starterFlag)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to resolve starter: ${reason}\n`)
    return 1
  }

  if (!starterSource) {
    ctx.stderr("Could not find a starter. Pass --starter <name|path>.\n")
    return 1
  }

  try {
    cpSync(starterSource.path, target, {
      recursive: true,
      force: true,
      filter: (src) => !shouldSkip(src, starterSource.path),
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to copy starter: ${reason}\n`)
    return 1
  } finally {
    starterSource.cleanup?.()
  }

  const voyantVersion = resolveVoyantVersion()
  const configPath = join(target, "voyant.config.ts")
  const needsDefaultConfig = !existsSync(configPath)
  const drizzleConfigPath = join(target, "drizzle.config.ts")
  const schemaImports = existsSync(drizzleConfigPath)
    ? inferSchemaImports(readFileSync(drizzleConfigPath, "utf8"))
    : []

  // Rewrite package.json name (if present).
  const pkgPath = join(target, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf8")
      const pkg = JSON.parse(raw) as Record<string, unknown>
      pkg.name = name
      pkg.version = "0.0.1"
      pkg.private = true
      ensureVoyantDependencyVersions(
        pkg,
        voyantVersion,
        schemaImports,
        readLocalVoyantPackageVersions(starterSource.path),
      )
      normalizeLifecycleScripts(pkg)
      if (needsDefaultConfig) {
        ensureObjectRecord(pkg, "dependencies")["@voyant-travel/framework"] = `^${voyantVersion}`
      }
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.stderr(`Copied starter, but failed to update package.json: ${reason}\n`)
      return 1
    }
  }

  if (schemaImports.length > 0) {
    try {
      writeStandaloneSchemaFiles(target, schemaImports)
      writeFileSync(drizzleConfigPath, standaloneDrizzleConfigSource())
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.stderr(`Copied starter, but failed to rewrite drizzle config: ${reason}\n`)
      return 1
    }
  }

  // Write a minimal voyant.config.ts if the starter didn't ship one.
  if (needsDefaultConfig) {
    writeFileSync(configPath, defaultConfigSource())
  }

  printNextSteps(ctx, name, target)
  return 0
}

interface GenerateFromSelfHostExportInput {
  name: string
  target: string
  force: boolean
  bundlePath: string
  loadApi: () => Promise<SelfHostExportApi>
  fileSystem: SelfHostProjectFileSystem
}

async function generateFromSelfHostExport(
  ctx: CommandContext,
  input: GenerateFromSelfHostExportInput,
): Promise<CommandResult> {
  let bundle: unknown
  try {
    bundle = JSON.parse(readFileSync(input.bundlePath, "utf8"))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to read self-host export bundle ${input.bundlePath}: ${reason}\n`)
    return 1
  }

  let providerOverrides: Record<string, string>
  try {
    providerOverrides = parseProviderOverrides(ctx.argv)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`voyant new: ${reason}\n`)
    return 1
  }

  try {
    const api = await input.loadApi()
    const validation = await api.validateVoyantSelfHostExportBundle(bundle)
    if (!validation.ok) {
      ctx.stderr("Cannot generate a project from an invalid Voyant self-host export bundle:\n")
      for (const issue of validation.issues) {
        ctx.stderr(`  ${issue.code} at ${issue.path}: ${issue.message}\n`)
      }
      return 1
    }

    const projection = await api.projectVoyantSelfHostExport(validation.value, {
      providerOverrides,
    })
    if (!projection.ready) {
      ctx.stderr("Cannot generate a project because the self-host projection is not ready:\n")
      for (const diagnostic of projection.diagnostics) {
        ctx.stderr(
          `  ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}\n    Hint: ${diagnostic.hint}\n`,
        )
      }
      if (
        projection.diagnostics.some(
          (diagnostic) => diagnostic.code === "VOYANT_SELF_HOST_PROVIDER_UNSUPPORTED",
        )
      ) {
        ctx.stderr("Resolve provider diagnostics with --provider role=provider and retry.\n")
      } else {
        ctx.stderr("Resolve the reported projection diagnostics and retry.\n")
      }
      return 1
    }

    const generated = selfHostExportProjectFiles(input.name, projection)
    writeGeneratedSelfHostProject(input.target, generated, input.force, input.fileSystem)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to generate project from self-host export: ${reason}\n`)
    return 1
  }

  printNextSteps(ctx, input.name, input.target)
  ctx.stdout("Review SELF_HOST_PROVISIONING.md before restoring data or cutting over traffic.\n")
  return 0
}

function parseProviderOverrides(argv: readonly string[]): Record<string, string> {
  const overrides: Record<string, string> = {}

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === undefined) continue

    let raw: string | undefined
    if (argument === "--provider") {
      raw = argv[index + 1]
      index++
    } else if (argument.startsWith("--provider=")) {
      raw = argument.slice("--provider=".length)
    }
    if (raw === undefined) continue
    if (raw.length === 0 || raw.startsWith("-")) {
      throw new Error("--provider requires role=provider.")
    }

    for (const entry of raw.split(",")) {
      const separator = entry.indexOf("=")
      const role = separator >= 0 ? entry.slice(0, separator).trim() : ""
      const provider = separator >= 0 ? entry.slice(separator + 1).trim() : ""
      if (
        !/^[A-Za-z][A-Za-z0-9_-]*$/.test(role) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)
      ) {
        throw new Error(
          `Invalid provider override ${JSON.stringify(entry)}. Expected role=provider.`,
        )
      }
      const previous = overrides[role]
      if (previous && previous !== provider) {
        throw new Error(
          `Provider role ${role} was assigned conflicting overrides ${previous} and ${provider}.`,
        )
      }
      overrides[role] = provider
    }
  }

  return Object.fromEntries(
    Object.entries(overrides).sort(([left], [right]) => compareCodeUnits(left, right)),
  )
}

function writeGeneratedSelfHostProject(
  target: string,
  generated: GeneratedSelfHostProject,
  force: boolean,
  fileSystem: SelfHostProjectFileSystem,
): void {
  const parent = dirname(target)
  fileSystem.mkdirSync(parent, { recursive: true })
  const stagingRoot = fileSystem.mkdtempSync(join(parent, `.${basename(target)}-`))
  const stagedProject = join(stagingRoot, "project")
  const previousTarget = join(stagingRoot, "previous")
  let movedPrevious = false
  let preserveStagingRoot = false

  try {
    fileSystem.mkdirSync(stagedProject)
    for (const directory of [...generated.directories].sort(compareCodeUnits)) {
      fileSystem.mkdirSync(join(stagedProject, directory), { recursive: true })
    }
    for (const [relativePath, contents] of [...generated.files].sort(([left], [right]) =>
      compareCodeUnits(left, right),
    )) {
      const path = join(stagedProject, relativePath)
      fileSystem.mkdirSync(dirname(path), { recursive: true })
      fileSystem.writeFileSync(path, contents)
    }

    if (fileSystem.existsSync(target)) {
      if (!force) throw new Error(`Target directory already exists: ${target}`)
      fileSystem.renameSync(target, previousTarget)
      movedPrevious = true
    }
    fileSystem.renameSync(stagedProject, target)
    if (movedPrevious) fileSystem.rmSync(previousTarget, { recursive: true, force: true })
  } catch (err) {
    if (movedPrevious && fileSystem.existsSync(previousTarget)) {
      try {
        fileSystem.rmSync(target, { recursive: true, force: true })
        fileSystem.renameSync(previousTarget, target)
        movedPrevious = false
      } catch (rollbackError) {
        const backupPreserved = fileSystem.existsSync(previousTarget)
        preserveStagingRoot = backupPreserved
        const backupMessage = backupPreserved
          ? `The original project backup was preserved at ${previousTarget}.`
          : "The original project backup could not be found after rollback failed."
        throw new Error(
          `Replacement failed: ${errorReason(err)} Rollback failed: ${errorReason(rollbackError)} ${backupMessage}`,
          { cause: err },
        )
      }
    }
    throw err
  } finally {
    if (!preserveStagingRoot) {
      fileSystem.rmSync(stagingRoot, { recursive: true, force: true })
    }
  }
}

async function loadSelfHostExportApi(): Promise<SelfHostExportApi> {
  const specifier = "@voyant-travel/framework/self-host-export"
  let loaded: unknown
  try {
    loaded = await import(specifier)
  } catch (err) {
    throw new Error(
      `Could not load ${specifier}. Install a CLI release with a compatible framework self-host contract. ${errorReason(err)}`,
    )
  }

  if (
    !loaded ||
    typeof loaded !== "object" ||
    !("validateVoyantSelfHostExportBundle" in loaded) ||
    typeof loaded.validateVoyantSelfHostExportBundle !== "function" ||
    !("projectVoyantSelfHostExport" in loaded) ||
    typeof loaded.projectVoyantSelfHostExport !== "function"
  ) {
    throw new Error(`${specifier} does not expose the required validation and projection APIs.`)
  }
  return loaded as SelfHostExportApi
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function printNextSteps(ctx: CommandContext, name: string, target: string): void {
  ctx.stdout(`Created ${name} at ${target}\n`)
  ctx.stdout("Next steps:\n")
  ctx.stdout(`  cd ${name}\n`)
  ctx.stdout("  pnpm install\n")
  ctx.stdout("  pnpm dev\n")
}

type StarterSource = {
  path: string
  cleanup?: () => void
}

async function resolveStarter(
  cwd: string,
  override: string | boolean | undefined,
): Promise<StarterSource | null> {
  if (typeof override === "string") {
    const abs = isAbsolute(override) ? override : resolve(cwd, override)
    if (existsSync(abs)) return { path: abs }
  }

  const requested = typeof override === "string" ? override : "operator"

  for (const localCandidate of localStarterCandidates(cwd, requested)) {
    if (existsSync(localCandidate)) {
      return { path: localCandidate }
    }
  }

  if (!BUILT_IN_STARTERS.has(requested)) {
    return null
  }

  return downloadStarter(requested, resolveVoyantVersion())
}

function shouldSkip(srcPath: string, starterRoot: string): boolean {
  const rel = srcPath.slice(starterRoot.length).replace(/^[\\/]+/, "")
  if (!rel) return false
  const first = rel.split(/[\\/]/)[0]
  if (!first) return false
  return SKIP_PATHS.has(first)
}

async function downloadStarter(starter: string, voyantVersion: string): Promise<StarterSource> {
  const root = mkdtempSync(join(tmpdir(), `voyant-starter-${starter}-`))
  const archivePath = join(root, `${starter}.tar.gz`)
  const extractDir = join(root, "starter")
  mkdirSync(extractDir, { recursive: true })

  try {
    const url = starterAssetUrl(starter, voyantVersion)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`received ${response.status} ${response.statusText} from ${url}`)
    }

    const archive = Buffer.from(await response.arrayBuffer())
    writeFileSync(archivePath, archive)
    await x({ file: archivePath, cwd: extractDir, strict: true })

    return {
      path: extractDir,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    }
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }
}

function starterAssetUrl(starter: string, voyantVersion: string): string {
  const base = STARTER_RELEASE_BASE_URL.replace(/\/+$/, "")
  return `${base}/v${voyantVersion}/voyant-starter-${starter}-${voyantVersion}.tar.gz`
}

function localStarterCandidates(cwd: string, starter: string): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()

  for (const ancestor of ancestorDirs(cwd)) {
    for (const candidate of [
      join(ancestor, "starters", starter),
      join(ancestor, "voyant", "starters", starter),
    ]) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      candidates.push(candidate)
    }
  }

  return candidates
}

function ancestorDirs(start: string): string[] {
  const dirs: string[] = []
  let current = resolve(start)

  while (true) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) return dirs
    current = parent
  }
}

function defaultConfigSource(): string {
  return `import { defineProject } from "@voyant-travel/framework/project"

export default defineProject({
  schemaVersion: "voyant.project.v1",
  modules: [],
  plugins: [],
  deployment: {
    target: "node",
  },
})
`
}

function writeUnavailablePresetDiagnostic(
  ctx: CommandContext,
  flags: Record<string, string | boolean>,
  preset: string,
  diagnostic: { code: string; reason: string },
): void {
  if (flags.json === true || flags.output === "json") {
    ctx.stderr(
      `${JSON.stringify({
        schemaVersion: "voyant.cli-diagnostic.v1",
        code: diagnostic.code,
        preset,
        message: diagnostic.reason,
      })}\n`,
    )
    return
  }
  ctx.stderr(`${diagnostic.code}: Preset ${preset} is unavailable. ${diagnostic.reason}\n`)
}

function resolveVoyantVersion(): string {
  return VOYANT_FRAMEWORK_VERSION
}

function ensureVoyantDependencyVersions(
  pkg: Record<string, unknown>,
  voyantVersion: string,
  schemaImports: string[],
  packageVersions: Map<string, string>,
): void {
  const dependencies = ensureObjectRecord(pkg, "dependencies")
  const devDependencies = ensureObjectRecord(pkg, "devDependencies")

  normalizeWorkspaceRanges(dependencies, voyantVersion, packageVersions)
  normalizeWorkspaceRanges(devDependencies, voyantVersion, packageVersions)

  if (!dependencies["@voyant-travel/runtime"] && !devDependencies["@voyant-travel/runtime"]) {
    dependencies["@voyant-travel/runtime"] = voyantPackageRange(
      "@voyant-travel/runtime",
      voyantVersion,
      packageVersions,
    )
  }

  for (const pkgName of schemaImports.map(getPackageNameFromImport)) {
    if (!dependencies[pkgName] && !devDependencies[pkgName]) {
      dependencies[pkgName] = voyantPackageRange(pkgName, voyantVersion, packageVersions)
    }
  }
}

function normalizeWorkspaceRanges(
  deps: Record<string, unknown>,
  voyantVersion: string,
  packageVersions: Map<string, string>,
): void {
  for (const [name, value] of Object.entries(deps)) {
    if (
      name.startsWith("@voyant-travel/") &&
      typeof value === "string" &&
      value.startsWith("workspace:")
    ) {
      deps[name] = voyantPackageRange(name, voyantVersion, packageVersions)
    }
  }
}

function voyantPackageRange(
  packageName: string,
  fallbackVersion: string,
  packageVersions: Map<string, string>,
): string {
  const packageFallback =
    packageName === "@voyant-travel/runtime" ? VOYANT_RUNTIME_VERSION : fallbackVersion
  return `^${packageVersions.get(packageName) ?? packageFallback}`
}

function readLocalVoyantPackageVersions(starterRoot: string): Map<string, string> {
  const workspaceRoot = findWorkspaceRoot(starterRoot)
  if (!workspaceRoot) return new Map()

  const versions = new Map<string, string>()
  for (const parent of [
    join(workspaceRoot, "packages"),
    join(workspaceRoot, "packages", "plugins"),
    join(workspaceRoot, "apps"),
    join(workspaceRoot, "examples"),
    join(workspaceRoot, "starters"),
  ]) {
    readPackageVersionsFrom(parent, versions)
  }

  return versions
}

function findWorkspaceRoot(start: string): string | null {
  for (const dir of ancestorDirs(start)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
  }
  return null
}

function readPackageVersionsFrom(parent: string, versions: Map<string, string>): void {
  if (!existsSync(parent)) return

  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const pkgPath = join(parent, entry.name, "package.json")
    if (!existsSync(pkgPath)) continue

    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        name?: unknown
        version?: unknown
      }
      if (
        typeof pkg.name === "string" &&
        pkg.name.startsWith("@voyant-travel/") &&
        typeof pkg.version === "string"
      ) {
        versions.set(pkg.name, pkg.version)
      }
    } catch {
      // Ignore malformed package files outside the selected starter.
    }
  }
}

function ensureObjectRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = target[key]
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  const next: Record<string, unknown> = {}
  target[key] = next
  return next
}

function normalizeLifecycleScripts(pkg: Record<string, unknown>): void {
  const scripts = ensureObjectRecord(pkg, "scripts")
  scripts.dev = "voyant develop"
  scripts.build = "voyant build"
  scripts.start = "voyant start"
  scripts["db:migrate"] = "voyant migrate"
}

function inferSchemaImports(rawConfig: string): string[] {
  const matches = rawConfig.matchAll(/"\.\.\/\.\.\/packages\/([^/]+)\/src\/([^"]+)"/g)
  const imports: string[] = []

  for (const match of matches) {
    const [, pkgDir, srcPath] = match
    if (!pkgDir || !srcPath) continue
    const specifier = toPublishedSchemaImport(pkgDir, srcPath)
    if (specifier && !imports.includes(specifier)) {
      imports.push(specifier)
    }
  }

  return imports
}

function toPublishedSchemaImport(pkgDir: string, srcPath: string): string | null {
  if (pkgDir === "db" && srcPath === "schema/index.ts") {
    return "@voyant-travel/db/schema"
  }

  const packageName = `@voyant-travel/${pkgDir}`
  if (srcPath === "schema.ts") return `${packageName}/schema`
  return null
}

function writeStandaloneSchemaFiles(target: string, schemaImports: string[]): void {
  const schemaDir = join(target, "src", "db")
  mkdirSync(schemaDir, { recursive: true })
  const schemaFile = join(schemaDir, "voyant-schema.ts")
  writeFileSync(schemaFile, standaloneSchemaSource(schemaImports))
}

function standaloneSchemaSource(schemaImports: string[]): string {
  const lines = schemaImports.map((specifier) => `export * from "${specifier}"`)
  return `${lines.join("\n")}\n`
}

function standaloneDrizzleConfigSource(): string {
  return `import { config } from "dotenv"
import { defineConfig } from "drizzle-kit"

config({ path: ".env" })
config({ path: ".env.local" })

function resolveDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? ""
}

export default defineConfig({
  schema: "./src/db/voyant-schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: resolveDatabaseUrl(),
  },
})
`
}

function getPackageNameFromImport(specifier: string): string {
  const parts = specifier.split("/")
  return parts.slice(0, 2).join("/")
}
