import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { exportsTarget, resolvePackageJson } from "./admin-entries.js"
import type { ScannedRouteContribution } from "./admin-routes.js"

/**
 * The BUILT-IN core admin entry (packaged-admin RFC #1643 final sweep):
 * `@voyant-travel/admin-app/core-extension` ships the pages every Voyant admin
 * mounts regardless of domains — dashboard, account, and the settings area
 * (layout + built-in pages). It is not a manifest module, so `voyant admin
 * generate --routes` includes it independently of the modules list —
 * CONDITIONALLY on the package being resolvable from the host with a
 * `"./core-extension"` exports entry, so hosts on a pre-core
 * `@voyant-travel/admin-app` are unaffected.
 *
 * The factory builds its route contributions imperatively (`routes.push`,
 * option-driven children), which the convention-bound static scanner cannot
 * read — so the CLI carries the extension's STATIC contribution shape here,
 * mirroring `createAdminCoreExtension`'s defaults. App-supplied factory
 * options (`settings.extraPages`, `settings.omit`, per-surface `false`) are
 * invisible to the generator by design: extra pages bind at runtime via
 * `adminExtensionChildRoutes`, and hosts that omit/eject surfaces should
 * eject the generated module (delete its header) or hand-edit after
 * regeneration.
 */
export const CORE_ADMIN_ENTRY_PACKAGE = "@voyant-travel/admin-app"
export const CORE_ADMIN_ENTRY_SUBPATH = "./core-extension"
export const CORE_ADMIN_ENTRY_IMPORT_SPEC = "@voyant-travel/admin-app/core-extension"
export const CORE_ADMIN_EXTENSION_ID = "core"
export const CORE_ADMIN_FACTORY_EXPORT = "createAdminCoreExtension"

/**
 * Comment emitted above the settings `WithChildren` const — names the
 * factory option that feeds the runtime child binding.
 */
export const CORE_SETTINGS_SUBTREE_COMMENT: ReadonlyArray<string> = [
  "// Settings subtree: the static children above keep literal paths for typed",
  "// links; app-supplied extra settings pages (factory `settings.extraPages`,",
  "// invisible to the generator) bind at runtime via adminExtensionChildRoutes.",
]

/** Resolution outcome for the core admin entry. */
export interface CoreAdminEntryResolution {
  importSpec: string
  exportName: string
  extensionId: string
  /** Absolute path to the entry source/dist file the exports map points at. */
  sourcePath: string
  /** Static route contributions (the factory's default shape). */
  contributions: ScannedRouteContribution[]
  /** Per-parent-route-id comment override for the `WithChildren` const. */
  subtreeComments: Readonly<Record<string, ReadonlyArray<string>>>
  /** Best-effort warning (e.g. factory export not found in the entry source). */
  note?: string
}

/**
 * Resolve the built-in core admin entry from the host. Returns null when
 * `@voyant-travel/admin-app` is not resolvable from `configDir` or its exports
 * map has no `"./core-extension"` entry (pre-core hosts).
 */
export function resolveCoreAdminEntry(configDir: string): CoreAdminEntryResolution | null {
  const pkgJsonPath = resolvePackageJson(CORE_ADMIN_ENTRY_PACKAGE, configDir)
  if (!pkgJsonPath) return null
  let exportsMap: unknown
  try {
    exportsMap = (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { exports?: unknown }).exports
  } catch {
    return null
  }
  const target = exportsTarget(exportsMap, CORE_ADMIN_ENTRY_SUBPATH)
  if (!target) return null
  const sourcePath = join(dirname(pkgJsonPath), target)

  // Best-effort factory verification, mirroring scanAdminEntries: a readable
  // entry without the factory export downgrades to a warning note (the
  // emitted module would not typecheck against such a package).
  let note: string | undefined
  try {
    const source = readFileSync(sourcePath, "utf8")
    if (!new RegExp(`\\b${CORE_ADMIN_FACTORY_EXPORT}\\b`).test(source)) {
      note = `${CORE_ADMIN_ENTRY_IMPORT_SPEC} does not export ${CORE_ADMIN_FACTORY_EXPORT}`
    }
  } catch {
    note = "entry source not readable — export name not verified"
  }

  return {
    importSpec: CORE_ADMIN_ENTRY_IMPORT_SPEC,
    exportName: CORE_ADMIN_FACTORY_EXPORT,
    extensionId: CORE_ADMIN_EXTENSION_ID,
    sourcePath,
    contributions: coreAdminRouteContributions(),
    subtreeComments: { "core-settings": CORE_SETTINGS_SUBTREE_COMMENT },
    note,
  }
}

interface CoreContributionShape {
  id: string
  path: string
  hasPage?: boolean
  hasLoader?: boolean
  ssr?: boolean | "data-only"
  redirectTo?: string
  children?: CoreContributionShape[]
}

function contribution(shape: CoreContributionShape): ScannedRouteContribution {
  return {
    id: shape.id,
    path: shape.path,
    rawPath: JSON.stringify(shape.path),
    hasComponent: false,
    hasPage: shape.hasPage ?? false,
    hasLoader: shape.hasLoader ?? false,
    hasValidateSearch: false,
    validateSearchRaw: null,
    ssr: shape.ssr ?? null,
    preload: null,
    destination: null,
    destinationParams: undefined,
    hasRedirectTo: shape.redirectTo !== undefined,
    redirectTo: shape.redirectTo ?? null,
    children: shape.children === undefined ? null : shape.children.map(contribution),
  }
}

/**
 * The core extension's static route contributions with default factory
 * options — id/path/implementation shape exactly as
 * `createAdminCoreExtension({})` builds them.
 */
export function coreAdminRouteContributions(): ScannedRouteContribution[] {
  return [
    contribution({ id: "core-dashboard", path: "/", hasPage: true, ssr: "data-only" }),
    contribution({ id: "core-account", path: "/account", hasPage: true }),
    contribution({
      id: "core-settings",
      path: "/settings",
      hasPage: true,
      children: [
        { id: "core-settings-index", path: "/", redirectTo: "/settings/channels" },
        { id: "core-settings-team", path: "/team", hasPage: true },
        { id: "core-settings-api-tokens", path: "/api-tokens", hasPage: true },
        {
          id: "core-settings-channels",
          path: "/channels",
          hasPage: true,
          hasLoader: true,
          ssr: "data-only",
        },
        { id: "core-settings-taxes", path: "/taxes", hasPage: true },
        { id: "core-settings-cost-categories", path: "/cost-categories", hasPage: true },
        {
          id: "core-settings-pricing-categories",
          path: "/pricing-categories",
          hasPage: true,
          hasLoader: true,
          ssr: "data-only",
        },
        {
          id: "core-settings-price-catalogs",
          path: "/price-catalogs",
          hasPage: true,
          hasLoader: true,
          ssr: "data-only",
        },
        {
          id: "core-settings-product-types",
          path: "/product-types",
          hasPage: true,
          hasLoader: true,
          ssr: "data-only",
        },
        {
          id: "core-settings-product-tags",
          path: "/product-tags",
          hasPage: true,
          hasLoader: true,
          ssr: "data-only",
        },
      ],
    }),
  ]
}
