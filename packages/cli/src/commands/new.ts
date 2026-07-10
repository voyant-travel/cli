import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { x } from "tar"

import { parseArgs } from "../lib/args.js"
import { VOYANT_FRAMEWORK_VERSION } from "../lib/voyant-version.js"
import { DEFAULT_PROJECT_PRESET, operatorStandardProjectFiles } from "../templates/project-files.js"
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
 * Scaffold a new Voyant project at `<cwd>/<name>`. Presets write a small,
 * explicit project graph; the compatibility starter path copies a directory
 * and rewrites its package metadata.
 *
 * The normal path writes a small graph-native project from the
 * `operator-standard` preset. `--starter` is an explicit compatibility path
 * for copying the legacy operator application or another starter directory.
 * The starter source is resolved (in priority order):
 *   1. `--starter <path>` — absolute or cwd-relative path
 *   2. `--starter <name>` — built-in / discoverable starter alias
 *   3. repo-local `starters/<name>` or sibling `voyant/starters/<name>`
 *   4. version-matched starter tarball from GitHub Releases
 */
export async function newCommand(ctx: CommandContext): Promise<CommandResult> {
  const { positionals, flags } = parseArgs(ctx.argv)
  const [name] = positionals
  if (!name) {
    ctx.stderr(
      "Usage: voyant new <name> [--preset operator-standard | --starter <name|path>] [--force]\n",
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
  if (starterFlag !== undefined && presetFlag !== undefined) {
    ctx.stderr("voyant new: --preset and --starter cannot be used together.\n")
    return 1
  }

  if (starterFlag === undefined) {
    const preset = typeof presetFlag === "string" ? presetFlag : DEFAULT_PROJECT_PRESET
    if (presetFlag === true || preset !== DEFAULT_PROJECT_PRESET) {
      ctx.stderr(
        `Unknown preset: ${presetFlag === true ? "(missing)" : preset}. Expected ${DEFAULT_PROJECT_PRESET}.\n`,
      )
      return 1
    }

    try {
      for (const [relPath, content] of operatorStandardProjectFiles(name)) {
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
  const configPath = join(target, "voyant.config.ts")
  if (!existsSync(configPath)) {
    writeFileSync(configPath, defaultConfigSource())
  }

  printNextSteps(ctx, name, target)
  return 0
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
  return `import { defineVoyantConfig } from "@voyant-travel/core/config"

export default defineVoyantConfig({
  deployment: "cloudflare-worker",
  projectConfig: {
    database: { urlEnv: "DATABASE_URL", adapter: "edge" },
  },
  admin: { enabled: true, path: "/app" },
  modules: [],
  plugins: [],
  featureFlags: {},
})
`
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
  return `^${packageVersions.get(packageName) ?? fallbackVersion}`
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
