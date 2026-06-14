import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import type { VoyantConfig } from "@voyant-travel/core/config"
import { resolveEntry } from "@voyant-travel/core/config"

/** Output mode for {@link resolveSchemas}. */
export type SchemaResolutionStyle = "specifier" | "file"

/**
 * Config shape the resolver reads. `additionalSchemas` is not yet part of the
 * published `@voyant-travel/core` `VoyantConfig` type, so it is augmented here and
 * read off the manifest at runtime. It lists schema-owning packages a template
 * **migrates but does not mount as a Hono module** — plugin-provided schemas
 * (e.g. catalog behind a bridge bundle) and FK-target packages (e.g.
 * accommodations). Entries seed schema resolution exactly like `modules`, so
 * their tables (and transitive `requiresSchemas`) are included — keeping
 * `modules` an honest list of what is actually mounted.
 */
export type SchemaSeedConfig = VoyantConfig & {
  /** Mounted Hono extensions that own tables — seeded like `modules`. */
  extensions?: VoyantConfig["modules"]
  additionalSchemas?: VoyantConfig["modules"]
}

/** Options for {@link resolveSchemas}. */
export interface ResolveSchemasOptions {
  /** Working directory (defaults to `process.cwd()`). */
  cwd?: string
  /**
   * "specifier" → returns package subpath strings like `@voyant-travel/db/schema`.
   * "file" → resolves each subpath to an absolute file via Node's resolver.
   *
   * Defaults to "specifier", which works with drizzle-kit's bundler-style loader.
   */
  style?: SchemaResolutionStyle
}

/** A package.json `voyant` field shape used by the resolver. */
interface VoyantPackageManifest {
  schema?: string
  requiresSchemas?: string[]
}

/**
 * Resolve the closure of schema entrypoints required by the modules listed in a
 * {@link VoyantConfig}. Walks each module's `package.json#voyant.requiresSchemas`
 * transitively, dedupes, and returns the resolved entries in dependency order
 * (deps first).
 *
 * @example
 * ```ts
 * // drizzle.config.ts
 * import { defineConfig } from "drizzle-kit"
 * import { resolveSchemas } from "@voyant-travel/cli/drizzle"
 * import voyantConfig from "./voyant.config"
 *
 * export default defineConfig({
 *   schema: resolveSchemas(voyantConfig),
 *   out: "./migrations",
 *   dialect: "postgresql",
 * })
 * ```
 */
export function resolveSchemas(
  config: SchemaSeedConfig,
  options: ResolveSchemasOptions = {},
): string[] {
  const cwd = options.cwd ?? process.cwd()
  const style = options.style ?? "specifier"
  // Seed from mounted modules, mounted extensions, AND non-mounted
  // schema-owning packages (`additionalSchemas`). All are walked for their
  // `requiresSchemas` closure.
  const seeds = [
    ...(config.modules ?? []),
    ...(config.extensions ?? []),
    ...(config.additionalSchemas ?? []),
  ].map((entry) => resolveEntry(entry).resolve)
  const order = expandClosure(seeds, cwd)
  return order.map((mod) => {
    const manifest = readManifest(mod, cwd)
    const sub = manifest.schema ?? "./schema"
    if (style === "specifier") {
      return joinSubpath(mod, sub)
    }
    return resolveFilePath(mod, sub, cwd)
  })
}

/**
 * Compute the dependency-ordered list of module identifiers starting from
 * `seeds`, walking each module's declared `requiresSchemas`.
 */
function expandClosure(seeds: string[], cwd: string): string[] {
  const visited = new Set<string>()
  const order: string[] = []

  const visit = (mod: string, stack: string[]): void => {
    if (visited.has(mod)) return
    if (stack.includes(mod)) {
      throw new Error(`Circular schema dependency detected: ${[...stack, mod].join(" → ")}`)
    }
    const manifest = readManifest(mod, cwd)
    for (const dep of manifest.requiresSchemas ?? []) {
      visit(dep, [...stack, mod])
    }
    visited.add(mod)
    order.push(mod)
  }

  for (const seed of seeds) {
    visit(seed, [])
  }
  return order
}

/**
 * Read `<mod>/package.json#voyant` from the package installed at `cwd`. Returns
 * an empty manifest when the field is absent or the file cannot be read.
 */
function readManifest(mod: string, cwd: string): VoyantPackageManifest {
  const pkgJsonPath = resolvePackageJson(mod, cwd)
  if (!pkgJsonPath) return {}
  try {
    const raw = readFileSync(pkgJsonPath, "utf8")
    const parsed = JSON.parse(raw) as { voyant?: VoyantPackageManifest }
    return parsed.voyant ?? {}
  } catch {
    return {}
  }
}

/**
 * Resolve `<mod>/package.json` from `cwd`.
 *
 * Direct `require.resolve("<mod>/package.json")` fails when a package's
 * `exports` field doesn't whitelist `./package.json` (the strict-exports
 * default). Resolve the entrypoint file instead and walk up to the owning
 * package.json. Falls back to a workspace-style lookup at
 * `<cwd>/packages/<basename>/package.json` so the resolver also works in the
 * voyant monorepo where modules may not be installed under `node_modules/`.
 */
export function resolvePackageJson(mod: string, cwd: string): string | null {
  // 1. Conventional install layout: <cwd>/node_modules/<mod>/package.json.
  const direct = join(cwd, "node_modules", mod, "package.json")
  if (existsSync(direct)) return direct

  // 2. Resolve the entrypoint and walk up.
  try {
    const require = createRequire(join(cwd, "package.json"))
    const entry = require.resolve(mod)
    let dir = dirname(entry)
    while (dir !== dirname(dir)) {
      const candidate = join(dir, "package.json")
      if (existsSync(candidate)) {
        try {
          const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }
          if (parsed.name === mod) return candidate
        } catch {
          // ignore and keep walking
        }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore — try workspace fallback
  }

  // 3. Workspace fallback: monorepo-relative location.
  const base = mod.startsWith("@voyant-travel/") ? mod.slice("@voyant-travel/".length) : mod
  const ws = join(cwd, "packages", base, "package.json")
  if (existsSync(ws)) return ws

  return null
}

/** Resolve `<mod>/<sub>` to an absolute file via Node's exports map. */
function resolveFilePath(mod: string, sub: string, cwd: string): string {
  const subpath = sub.startsWith("./") ? sub.slice(1) : `/${sub}`
  try {
    const require = createRequire(join(cwd, "package.json"))
    return require.resolve(`${mod}${subpath}`)
  } catch {
    const pkgJson = resolvePackageJson(mod, cwd)
    if (pkgJson) {
      const pkgDir = dirname(pkgJson)
      const sourceCandidate = join(
        pkgDir,
        "src",
        `${subpath.replace(/^\//, "").replace(/^\.\//, "")}.ts`,
      )
      if (existsSync(sourceCandidate)) return sourceCandidate
    }
    throw new Error(`Could not resolve schema entry for ${mod}${subpath}`)
  }
}

/** Concatenate a package name and a subpath like `./schema` → `pkg/schema`. */
function joinSubpath(mod: string, sub: string): string {
  if (sub === "." || sub === "./") return mod
  if (sub.startsWith("./")) return `${mod}/${sub.slice(2)}`
  if (sub.startsWith("/")) return `${mod}${sub}`
  return `${mod}/${sub}`
}
