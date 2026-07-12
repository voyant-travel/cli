import { existsSync } from "node:fs"
import { isAbsolute, join, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"

import type { SchemaSeedConfig } from "./resolve-schemas.js"

/**
 * The config shape the schema tooling consumes across legacy configs and
 * normalized project graphs, plus two schema-tooling fields:
 *
 * - `additionalSchemas` — schema-owning packages migrated but not mounted as
 *   modules (plugins, FK targets). Seeded into the resolution closure.
 * - `schemas` — template/app-**local** Drizzle schema entrypoints (file paths
 *   relative to the template) that belong to no package. Appended verbatim
 *   after the package-derived closure.
 */
export type SchemaManifestConfig = SchemaSeedConfig & {
  schemas?: string[]
}

const CONFIG_FILE_NAMES = ["voyant.config.ts", "voyant.config.js", "voyant.config.mjs"] as const

/**
 * Locate and dynamically import a `voyant.config.{ts,js,mjs}` from `cwd` or the
 * explicit `override` path. Node (>= 22.18 / 23+) strips types from `.ts`
 * sources natively, so the TypeScript manifest imports directly. Returns
 * `null` when no config is found so callers can surface a usage error.
 */
export async function loadVoyantConfig(
  cwd: string,
  override: string | null,
): Promise<SchemaManifestConfig | null> {
  const candidates = override
    ? [isAbsolute(override) ? override : resolvePath(cwd, override)]
    : CONFIG_FILE_NAMES.map((name) => join(cwd, name))

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const mod = (await import(pathToFileURL(candidate).href)) as { default?: unknown }
    return (mod.default ?? mod) as SchemaManifestConfig
  }
  return null
}
