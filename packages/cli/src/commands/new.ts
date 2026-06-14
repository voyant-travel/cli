import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { x } from "tar"

import { parseArgs } from "../lib/args.js"
import { VOYANT_FRAMEWORK_VERSION } from "../lib/voyant-version.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * Directory / file names that should never be copied from a source
 * template (they're either ephemeral or deployment-local).
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

const BUILT_IN_TEMPLATES = new Set(["operator"])
const STARTER_RELEASE_BASE_URL =
  process.env.VOYANT_STARTER_BASE_URL ?? "https://github.com/voyant-travel/voyant/releases/download"

const TEMPLATE_ALIAS_FALLBACK = "operator"

/**
 * `voyant new <name> [--template <name|path>] [--force]`
 *
 * Scaffold a new Voyant project by cloning a template directory into
 * `<cwd>/<name>` and rewriting the package.json name. A minimal
 * `voyant.config.ts` is generated if the template doesn't already
 * provide one.
 *
 * The template source is resolved (in priority order):
 *   1. `--template <path>` — absolute or cwd-relative path
 *   2. `--template <name>` — built-in / discoverable template alias
 *   3. repo-local `templates/<name>` when invoked from a Voyant checkout
 *   4. version-matched starter tarball from GitHub Releases
 *   5. `operator` as the default fallback starter
 */
export async function newCommand(ctx: CommandContext): Promise<CommandResult> {
  const { positionals, flags } = parseArgs(ctx.argv)
  const [name] = positionals
  if (!name) {
    ctx.stderr("Usage: voyant new <name> [--template <name|path>] [--force]\n")
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

  let templateSource: TemplateSource | null
  try {
    templateSource = await resolveTemplate(ctx.cwd, flags.template)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to resolve template: ${reason}\n`)
    return 1
  }

  if (!templateSource) {
    ctx.stderr("Could not find a template. Pass --template <name|path>.\n")
    return 1
  }

  try {
    cpSync(templateSource.path, target, {
      recursive: true,
      force: true,
      filter: (src) => !shouldSkip(src, templateSource.path),
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to copy template: ${reason}\n`)
    return 1
  } finally {
    templateSource.cleanup?.()
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
      ensureVoyantDependencyVersions(pkg, voyantVersion, schemaImports)
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.stderr(`Copied template, but failed to update package.json: ${reason}\n`)
      return 1
    }
  }

  if (schemaImports.length > 0) {
    try {
      writeStandaloneSchemaFiles(target, schemaImports)
      writeFileSync(drizzleConfigPath, standaloneDrizzleConfigSource())
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.stderr(`Copied template, but failed to rewrite drizzle config: ${reason}\n`)
      return 1
    }
  }

  // Write a minimal voyant.config.ts if the template didn't ship one.
  const configPath = join(target, "voyant.config.ts")
  if (!existsSync(configPath)) {
    writeFileSync(configPath, defaultConfigSource())
  }

  ctx.stdout(`Created ${name} at ${target}\n`)
  ctx.stdout("Next steps:\n")
  ctx.stdout(`  cd ${name}\n`)
  ctx.stdout("  pnpm install\n")
  ctx.stdout("  pnpm dev\n")
  return 0
}

type TemplateSource = {
  path: string
  cleanup?: () => void
}

async function resolveTemplate(
  cwd: string,
  override: string | boolean | undefined,
): Promise<TemplateSource | null> {
  if (typeof override === "string") {
    const abs = isAbsolute(override) ? override : resolve(cwd, override)
    if (existsSync(abs)) return { path: abs }
  }

  const requested = typeof override === "string" ? override : TEMPLATE_ALIAS_FALLBACK
  const localCandidate = join(cwd, "templates", requested)
  if (existsSync(localCandidate)) return { path: localCandidate }

  if (!BUILT_IN_TEMPLATES.has(requested)) {
    return null
  }

  return downloadStarterTemplate(requested, resolveVoyantVersion())
}

function shouldSkip(srcPath: string, templateRoot: string): boolean {
  const rel = srcPath.slice(templateRoot.length).replace(/^[\\/]+/, "")
  if (!rel) return false
  const first = rel.split(/[\\/]/)[0]
  if (!first) return false
  return SKIP_PATHS.has(first)
}

async function downloadStarterTemplate(
  starter: string,
  voyantVersion: string,
): Promise<TemplateSource> {
  const root = mkdtempSync(join(tmpdir(), `voyant-starter-${starter}-`))
  const archivePath = join(root, `${starter}.tar.gz`)
  const extractDir = join(root, "template")
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
): void {
  const dependencies = ensureObjectRecord(pkg, "dependencies")
  const devDependencies = ensureObjectRecord(pkg, "devDependencies")

  normalizeWorkspaceRanges(dependencies, voyantVersion)
  normalizeWorkspaceRanges(devDependencies, voyantVersion)

  for (const pkgName of schemaImports.map(getPackageNameFromImport)) {
    if (!dependencies[pkgName] && !devDependencies[pkgName]) {
      dependencies[pkgName] = `^${voyantVersion}`
    }
  }
}

function normalizeWorkspaceRanges(deps: Record<string, unknown>, voyantVersion: string): void {
  for (const [name, value] of Object.entries(deps)) {
    if (
      name.startsWith("@voyant-travel/") &&
      typeof value === "string" &&
      value.startsWith("workspace:")
    ) {
      deps[name] = `^${voyantVersion}`
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
