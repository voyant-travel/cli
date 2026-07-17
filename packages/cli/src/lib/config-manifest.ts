/**
 * Legacy `voyant.config.*` manifest authoring contracts.
 *
 * These types and helpers previously lived in `@voyant-travel/core/config`.
 * `@voyant-travel/core@0.125` (the 0.48-aligned line) removed the `./config`
 * export subpath as part of the deployment-graph rewrite ("unify application
 * config ownership"): the graph-native `defineConfig` in
 * `@voyant-travel/framework/project` produces a `VoyantGraphProject` (a
 * differences-from-standard descriptor) that no longer carries the
 * `modules[]` / `plugins[]` / `extensions[]` manifest lists.
 *
 * The CLI still consumes projects authored against the manifest model — a
 * default-exported object with `modules`, `plugins`, `extensions`,
 * `additionalSchemas`, `schemas`, `admin`, and `featureFlags`. Its
 * `config`, `admin generate`, and `admin doctor` commands read that shape and
 * its loader does not enforce it. Owning the authoring contracts here keeps
 * the CLI a matched pair with core@0.125 without dropping support for the
 * manifest projects customers still ship.
 */

/**
 * Core runtime settings declared for tooling purposes (connection strings,
 * cache backend, auth provider). All fields are optional because runtime
 * wiring lives in template code and environment bindings.
 */
export interface ProjectConfig {
  /** Database connection descriptor. */
  database?: {
    /** Environment variable name that holds the connection URL. */
    urlEnv?: string
    /** Adapter to use at runtime. */
    adapter?: string
  }
  /** Cache backend descriptor. */
  cache?: {
    /** Provider name. */
    provider?: string
    /** Optional binding name (e.g. a Workers KV binding). */
    binding?: string
  }
  /** Auth provider descriptor. */
  auth?: {
    /** Provider identifier (e.g. "better-auth"). */
    provider?: string
  }
}

/**
 * Settings for `voyant admin generate --routes` — the generated thin route
 * files that bind zero-prop extension route contributions into the host's
 * file-based route tree. All fields are optional; defaults match the operator
 * starter's conventions.
 */
export interface AdminRoutesConfig {
  /**
   * Host route-tree directory generated files land in, relative to the
   * config file. Default "src/routes/_workspace".
   */
  dir?: string
  /**
   * Module specifier exporting the API base-URL getter bound into generated
   * loaders. Default "@/lib/env".
   */
  apiUrlModule?: string
  /** Named export of `apiUrlModule` returning the API base URL. Default "getApiUrl". */
  apiUrlExport?: string
  /**
   * Module specifier exporting the SSR cookie-forwarding fetcher bound into
   * generated loaders. Default "@/lib/voyant-fetcher".
   */
  fetcherModule?: string
  /** Named export of `fetcherModule`. Default "operatorFetcher". */
  fetcherExport?: string
}

/**
 * Admin-dashboard manifest entry.
 */
export interface AdminConfig {
  /** Whether the admin dashboard is enabled for this project. */
  enabled?: boolean
  /** URL path the dashboard is mounted at (e.g. "/app"). */
  path?: string
  /** Optional URL the admin dashboard should call back to. */
  backendUrl?: string
  /** Generated-route-file settings for `voyant admin generate --routes`. */
  routes?: AdminRoutesConfig
}

/**
 * A module declaration — either a string identifier (referencing a package
 * or workspace-local module) or an inline descriptor with options.
 */
export type ModuleEntry =
  | string
  | {
      /** Module identifier (package name or workspace path). */
      resolve: string
      /** Arbitrary module options consumed by the module factory. */
      options?: Record<string, unknown>
    }

/**
 * A plugin declaration — mirrors {@link ModuleEntry} but references
 * distributable plugin bundles.
 */
export type PluginEntry =
  | string
  | {
      /** Plugin identifier (package name). */
      resolve: string
      /** Arbitrary plugin options. */
      options?: Record<string, unknown>
    }

/**
 * The top-level voyant.config.* manifest.
 *
 * @see {@link defineVoyantConfig}
 */
export interface VoyantConfig {
  /** Core runtime settings (database, cache, auth). */
  projectConfig?: ProjectConfig
  /** Admin dashboard configuration. */
  admin?: AdminConfig
  /** Modules composed into the application. */
  modules?: ModuleEntry[]
  /** Plugins registered alongside core modules. */
  plugins?: PluginEntry[]
  /**
   * Hono extensions mounted into the application. Extensions that own tables
   * are seeded into schema discovery alongside `modules`, so an extension's
   * tables can never be silently omitted from a migration.
   */
  extensions?: ModuleEntry[]
  /**
   * Schema-owning packages that a project migrates but does **not** mount as a
   * Hono module or extension — e.g. plugin-provided schemas or FK-target
   * packages. Migration tooling seeds schema discovery from `modules` +
   * `extensions` + `additionalSchemas`.
   */
  additionalSchemas?: ModuleEntry[]
  /**
   * Template/app-**local** Drizzle schema entrypoints (file paths relative to
   * the config) that belong to no package — deployment-owned glue. Migration
   * tooling appends these verbatim after the package-derived closure.
   */
  schemas?: string[]
  /** Feature flags for gradual rollout. */
  featureFlags?: Record<string, boolean>
  /** Deployment target hint consumed by tooling. */
  deployment?: string
}

/**
 * Identity helper that returns the config as-is, for authoring type inference.
 * Does not perform runtime validation — malformed manifests surface at
 * CLI/tooling consumption time via {@link validateVoyantConfig}.
 */
export function defineVoyantConfig<C extends VoyantConfig>(config: C): C {
  return config
}

/**
 * A single validation issue detected in a {@link VoyantConfig} manifest.
 */
export interface ConfigValidationIssue {
  /** Dotted path to the offending field (e.g. `modules[0].resolve`). */
  path: string
  /** Human-readable description. */
  message: string
}

/**
 * Result returned by {@link validateVoyantConfig}.
 */
export interface ConfigValidationResult {
  /** True when no issues were detected. */
  ok: boolean
  /** List of validation issues (empty when `ok` is true). */
  issues: ConfigValidationIssue[]
}

function validateEntryList(
  cfg: Record<string, unknown>,
  field: "modules" | "plugins" | "extensions" | "additionalSchemas",
  label: string,
  issues: ConfigValidationIssue[],
): void {
  const value = cfg[field]
  if (value === undefined) return
  if (!Array.isArray(value)) {
    issues.push({ path: field, message: "Expected an array." })
    return
  }
  const seen = new Set<string>()
  value.forEach((entry, index) => {
    const name = extractEntryName(entry)
    if (!name) {
      issues.push({
        path: `${field}[${index}]`,
        message: `${label} entry must be a non-empty string or an object with a \`resolve\` string.`,
      })
      return
    }
    if (seen.has(name)) {
      issues.push({
        path: `${field}[${index}]`,
        message: `Duplicate ${label.toLowerCase()} "${name}".`,
      })
    }
    seen.add(name)
  })
}

/**
 * Lightweight structural validation for a {@link VoyantConfig} manifest.
 *
 * Checks only shape/identity: field types, non-empty identifiers, no
 * duplicate module/plugin names. It does **not** resolve package names or
 * check that referenced modules exist on disk.
 */
export function validateVoyantConfig(config: unknown): ConfigValidationResult {
  const issues: ConfigValidationIssue[] = []

  if (config === null || typeof config !== "object") {
    return { ok: false, issues: [{ path: "", message: "Config must be an object." }] }
  }

  const cfg = config as Record<string, unknown>

  validateEntryList(cfg, "modules", "Module", issues)
  validateEntryList(cfg, "plugins", "Plugin", issues)
  validateEntryList(cfg, "extensions", "Extension", issues)
  validateEntryList(cfg, "additionalSchemas", "additionalSchemas", issues)

  if (cfg.schemas !== undefined) {
    if (!Array.isArray(cfg.schemas)) {
      issues.push({ path: "schemas", message: "Expected an array of file-path strings." })
    } else {
      cfg.schemas.forEach((entry, index) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          issues.push({
            path: `schemas[${index}]`,
            message: "schemas entry must be a non-empty file-path string.",
          })
        }
      })
    }
  }

  if (cfg.admin !== undefined) {
    if (cfg.admin === null || typeof cfg.admin !== "object" || Array.isArray(cfg.admin)) {
      issues.push({ path: "admin", message: "Expected an object." })
    } else {
      const admin = cfg.admin as Record<string, unknown>
      if (admin.enabled !== undefined && typeof admin.enabled !== "boolean") {
        issues.push({ path: "admin.enabled", message: "Expected a boolean." })
      }
      if (admin.path !== undefined && typeof admin.path !== "string") {
        issues.push({ path: "admin.path", message: "Expected a string." })
      }
      if (admin.backendUrl !== undefined && typeof admin.backendUrl !== "string") {
        issues.push({ path: "admin.backendUrl", message: "Expected a string." })
      }
      if (admin.routes !== undefined) {
        if (
          admin.routes === null ||
          typeof admin.routes !== "object" ||
          Array.isArray(admin.routes)
        ) {
          issues.push({ path: "admin.routes", message: "Expected an object." })
        } else {
          const routes = admin.routes as Record<string, unknown>
          for (const routeField of [
            "dir",
            "apiUrlModule",
            "apiUrlExport",
            "fetcherModule",
            "fetcherExport",
          ]) {
            if (routes[routeField] !== undefined && typeof routes[routeField] !== "string") {
              issues.push({ path: `admin.routes.${routeField}`, message: "Expected a string." })
            }
          }
        }
      }
    }
  }

  if (cfg.featureFlags !== undefined) {
    if (
      cfg.featureFlags === null ||
      typeof cfg.featureFlags !== "object" ||
      Array.isArray(cfg.featureFlags)
    ) {
      issues.push({ path: "featureFlags", message: "Expected an object of booleans." })
    } else {
      for (const [key, value] of Object.entries(cfg.featureFlags)) {
        if (typeof value !== "boolean") {
          issues.push({ path: `featureFlags.${key}`, message: "Expected a boolean." })
        }
      }
    }
  }

  return { ok: issues.length === 0, issues }
}

function extractEntryName(entry: unknown): string | null {
  if (typeof entry === "string") {
    return entry.trim().length > 0 ? entry : null
  }
  if (entry !== null && typeof entry === "object" && "resolve" in entry) {
    const resolve = (entry as { resolve: unknown }).resolve
    if (typeof resolve === "string" && resolve.trim().length > 0) {
      return resolve
    }
  }
  return null
}

/**
 * Normalize a {@link ModuleEntry} or {@link PluginEntry} into the canonical
 * `{ resolve, options }` object shape. Accepts string shorthand and inline
 * descriptors alike.
 */
export function resolveEntry<E extends ModuleEntry | PluginEntry>(
  entry: E,
): { resolve: string; options: Record<string, unknown> } {
  if (typeof entry === "string") {
    return { resolve: entry, options: {} }
  }
  return { resolve: entry.resolve, options: entry.options ?? {} }
}
