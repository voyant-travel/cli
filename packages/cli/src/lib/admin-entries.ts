import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { type ModuleEntry, resolveEntry } from "@voyant-travel/core/config"

import { toCamelCase, toPascalCase } from "./strings.js"

/**
 * Default location (relative to the config directory) of the committed file
 * emitted by `voyant admin generate`.
 */
export const DEFAULT_GENERATED_RELATIVE_PATH = "src/admin.extensions.generated.ts"

/** Why a module did not contribute an admin entry. */
export type AdminEntryStatus =
  /** Admin entry resolved (and, where verifiable, exports the expected factory). */
  | "found"
  /** The module package itself could not be resolved from the config dir. */
  | "module-unresolved"
  /** No `<module>-react` package could be resolved from the config dir. */
  | "no-client-package"
  /** The ui package exists but its `exports` map has no admin subpath. */
  | "no-admin-export"
  /** The admin entry source is readable but lacks `create<Pascal>AdminExtension`. */
  | "missing-export"
  /** The manifest entry is not a package specifier (relative/absolute path). */
  | "not-a-package"

/** One manifest module's admin-entry scan outcome. */
export interface AdminEntryScanResult {
  /** Module specifier as listed in the manifest (e.g. `@voyant-travel/promotions`). */
  moduleName: string
  /** Last path segment minus scope (e.g. `promotions`). */
  domain: string
  /** Object key for the generated factories map (e.g. `bookingRequirements`). */
  camel: string
  /** Conventional factory export name (e.g. `createPromotionsAdminExtension`). */
  exportName: string
  status: AdminEntryStatus
  /** Import specifier for the admin entry (e.g. `@voyant-travel/promotions-react/admin`). */
  importSpec?: string
  /** Absolute path to the admin entry source, when resolvable on disk. */
  sourcePath?: string
  /** Human-readable note for skips/warnings. */
  note?: string
}

/**
 * Scan a manifest's `modules` for admin entries following the
 * `<module>-react/admin` convention (packaged-admin RFC §4.1).
 *
 * Detection is pure package.json inspection — no code is executed:
 * 1. Resolve the module's own package.json; honor an explicit
 *    `voyant.adminEntry` override when present.
 * 2. Otherwise probe `<module>-react` and require an `"./admin"` entry in its
 *    `exports` map.
 * 3. Best-effort: read the entry source and verify it exports
 *    `create<Pascal>AdminExtension`; a readable file without that named
 *    export downgrades the result to `missing-export`.
 */
export function scanAdminEntries(
  modules: ReadonlyArray<ModuleEntry>,
  configDir: string,
): AdminEntryScanResult[] {
  return modules.map((entry) => scanOne(resolveEntry(entry).resolve, configDir))
}

function scanOne(moduleName: string, configDir: string): AdminEntryScanResult {
  const domain = moduleDomain(moduleName)
  const base: Omit<AdminEntryScanResult, "status"> = {
    moduleName,
    domain,
    camel: toCamelCase(domain),
    exportName: `create${toPascalCase(domain)}AdminExtension`,
  }

  if (moduleName.startsWith(".") || moduleName.startsWith("/")) {
    return { ...base, status: "not-a-package", note: "not a package specifier" }
  }

  const modulePkgPath = resolvePackageJson(moduleName, configDir)
  if (!modulePkgPath) {
    return {
      ...base,
      // Conventional candidate spec (a voyant.adminEntry override is
      // unreadable here) so the doctor can tell "module unresolvable" apart
      // from "module left the manifest" for existing generated imports.
      importSpec: `${moduleName}-react/admin`,
      status: "module-unresolved",
      note: `module package ${moduleName} not resolvable from ${configDir}`,
    }
  }

  const override = readAdminEntryOverride(modulePkgPath)
  const { pkg: clientPkgName, subpath } = override
    ? splitSpecifier(override)
    : { pkg: `${moduleName}-react`, subpath: "./admin" }
  const importSpec = override ?? `${clientPkgName}/admin`

  const clientPkgPath = resolvePackageJson(clientPkgName, configDir)
  if (!clientPkgPath) {
    return {
      ...base,
      // Keep the candidate spec: the doctor compares generated imports
      // against manifest candidates, and a module whose UI package merely
      // went missing must not be misreported as removed from the manifest.
      importSpec,
      status: "no-client-package",
      note: override
        ? `voyant.adminEntry package ${clientPkgName} not resolvable from ${configDir}`
        : `no ${clientPkgName} package resolvable from ${configDir}`,
    }
  }

  const exportsMap = readExportsMap(clientPkgPath)
  const target = exportsTarget(exportsMap, subpath)
  if (!target) {
    return {
      ...base,
      importSpec,
      status: "no-admin-export",
      note: `${clientPkgName} has no "${subpath}" entry in its package.json exports`,
    }
  }

  const sourcePath = join(dirname(clientPkgPath), target)
  const source = tryReadFile(sourcePath)
  if (source !== null && !new RegExp(`\\b${base.exportName}\\b`).test(source)) {
    return {
      ...base,
      importSpec,
      sourcePath,
      status: "missing-export",
      note: `${importSpec} does not export ${base.exportName}`,
    }
  }

  return {
    ...base,
    importSpec,
    sourcePath: source !== null ? sourcePath : undefined,
    status: "found",
    note: source === null ? `entry source not readable — export name not verified` : undefined,
  }
}

/** Last path segment of a module name, minus any scope. */
export function moduleDomain(moduleName: string): string {
  const segments = moduleName.split("/").filter(Boolean)
  return segments[segments.length - 1] ?? moduleName
}

/**
 * Resolve `<pkg>/package.json` without `require.resolve` (strict `exports`
 * maps rarely whitelist `./package.json`). Walks ancestor directories from
 * `startDir`, probing the conventional install layout plus a monorepo
 * `packages/<base>` fallback.
 */
export function resolvePackageJson(pkgName: string, startDir: string): string | null {
  const base = pkgName.includes("/") ? pkgName.slice(pkgName.indexOf("/") + 1) : pkgName
  let dir = startDir
  while (true) {
    const installed = join(dir, "node_modules", pkgName, "package.json")
    if (existsSync(installed)) return installed
    const workspace = join(dir, "packages", base, "package.json")
    if (existsSync(workspace) && packageNameMatches(workspace, pkgName)) return workspace
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function packageNameMatches(pkgJsonPath: string, pkgName: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string }
    return parsed.name === pkgName
  } catch {
    return false
  }
}

/** Read `package.json#voyant.adminEntry` (the non-conventional override). */
function readAdminEntryOverride(pkgJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      voyant?: { adminEntry?: unknown }
    }
    const value = parsed.voyant?.adminEntry
    return typeof value === "string" && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** Split `@scope/pkg/sub/path` into `{ pkg: "@scope/pkg", subpath: "./sub/path" }`. */
function splitSpecifier(spec: string): { pkg: string; subpath: string } {
  const segments = spec.split("/")
  const pkgSegments = spec.startsWith("@") ? 2 : 1
  const pkg = segments.slice(0, pkgSegments).join("/")
  const rest = segments.slice(pkgSegments).join("/")
  return { pkg, subpath: rest ? `./${rest}` : "." }
}

function readExportsMap(pkgJsonPath: string): unknown {
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { exports?: unknown }
    return parsed.exports
  } catch {
    return undefined
  }
}

/**
 * Find the file target for `subpath` in a package.json `exports` map.
 * Returns the first string reachable through condition objects, or null when
 * the subpath is not exported. Wildcard patterns are not expanded — the admin
 * entry convention is an explicit `"./admin"` key.
 */
export function exportsTarget(exportsMap: unknown, subpath: string): string | null {
  if (exportsMap === null || exportsMap === undefined) return null
  if (typeof exportsMap === "string") {
    return subpath === "." ? exportsMap : null
  }
  if (typeof exportsMap !== "object") return null
  const record = exportsMap as Record<string, unknown>
  const keys = Object.keys(record)
  const isConditionMap = keys.length > 0 && keys.every((key) => !key.startsWith("."))
  if (isConditionMap) {
    // Bare condition map applies to the root subpath only.
    return subpath === "." ? firstString(record) : null
  }
  const value = record[subpath]
  if (value === undefined) return null
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    return firstString(value as Record<string, unknown>)
  }
  return null
}

function firstString(conditions: Record<string, unknown>): string | null {
  for (const key of ["import", "default", "require", "types"]) {
    const value = conditions[key]
    if (typeof value === "string") return value
    if (typeof value === "object" && value !== null) {
      const nested = firstString(value as Record<string, unknown>)
      if (nested) return nested
    }
  }
  for (const value of Object.values(conditions)) {
    if (typeof value === "string") return value
  }
  return null
}

function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
