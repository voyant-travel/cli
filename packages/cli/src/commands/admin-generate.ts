import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

import type { ModuleEntry, VoyantConfig } from "@voyant-travel/core/config"
import { resolveCoreAdminEntry } from "../lib/admin-core-entry.js"
import {
  type AdminEntryScanResult,
  adminModuleEntries,
  DEFAULT_GENERATED_RELATIVE_PATH,
  scanAdminEntries,
} from "../lib/admin-entries.js"
import {
  type AdminRoutesManifestConfig,
  type AdminRoutesModuleChildRoute,
  type AdminRoutesModuleRoute,
  type AdminRoutesModuleSection,
  alternativeRouteFileRelPaths,
  canonicalRouteFileRelPath,
  collectDestinationBindings,
  DEFAULT_GENERATED_DESTINATIONS_MODULE_RELATIVE_PATH,
  DEFAULT_GENERATED_ROUTES_MODULE_RELATIVE_PATH,
  DEFAULT_ROUTES_DIR,
  fileRouteIdFor,
  isGeneratedDestinationsFile,
  isGeneratedRouteFile,
  isImplementedContribution,
  renderAdminDestinationsModule,
  renderAdminRoutesModule,
  renderRouteFile,
  resolveAdminRoutesManifestConfig,
  resolveSearchSchemaIdent,
  routeIdPrefixFor,
  type ScannedRouteContribution,
  scanExtensionId,
  scanRouteContributions,
  workspaceRouteModuleFor,
} from "../lib/admin-routes.js"
import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import { loadVoyantConfigFile, resolveConfigPath } from "../lib/config-loader.js"
import { toCamelCase, toPascalCase } from "../lib/strings.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant admin generate [--config <path>] [--out <file>] [--check]`
 * `voyant admin generate --graph <path> [--config <path>] [--out <file>] [--check]`
 *
 * Graph-driven admin composition: a `voyant.resolved-graph.v1` carrying
 * package-owned `unit.admin` facets emits one deterministic, target-neutral
 * static entry module. Route, navigation, copy, slot, and contribution
 * declarations come directly from the graph, and executable exports stay
 * behind literal dynamic imports so the Node bundle preserves lazy boundaries.
 *
 * Compatibility: config input, and old graphs with no `unit.admin` facets,
 * retain the packaged-admin RFC §4.1 scanner. That isolated legacy path derives
 * `<module>-react/admin` (or `package.json#voyant.adminEntry`) entries. A graph
 * with any admin facet never enters the scanner.
 *
 * The compatibility output remains:
 *
 * ```ts
 * import { createPromotionsAdminExtension } from "@voyant-travel/promotions-react/admin"
 * export const generatedAdminExtensionFactories = { ... } as const
 * ```
 *
 * Factories — not instances — so legacy hosts can pass localized labels/icons.
 *
 * `voyant admin generate --routes [--routes-dir <dir>] [--out <file>] [--check]`
 *
 * Code-assembled admin route module (packaged-admin RFC §4.8 endgame):
 * statically scan each admin entry's route contributions and emit ONE
 * committed module (default `src/admin.routes.generated.tsx`) holding a
 * code-based `createRoute` per implemented contribution (`page`,
 * `component`, or `redirectTo` present — `$param` routes included), its
 * options resolved from the host-registered extension instances via
 * `adminExtensionRouteOptions`, plus the typed-link map interfaces the
 * host's `router.tsx` merges. Layout contributions with nested `children`
 * become `addChildren` subtrees whose tail spreads
 * `adminExtensionChildRoutes` for runtime-known children. The BUILT-IN core
 * entry (`@voyant-travel/admin-app/core-extension`, extension id `core`, factory
 * `createAdminCoreExtension`) is included independently of the manifest
 * module list whenever the package is resolvable from the host with a
 * `"./core-extension"` export — pre-core hosts are unaffected. NO
 * per-route files exist for package-delivered pages. A target file without
 * the generated header is never overwritten — deleting the header is how a
 * host ejects the module; a hand-written route file binding a contribution's
 * path ejects that single route. Import bindings default to the operator
 * conventions (`@/lib/env`, `@/lib/voyant-fetcher`,
 * `@/lib/admin-extensions`) and are configurable via the manifest's
 * `admin.routes` block.
 *
 * `voyant admin generate --routes --files [--routes-dir <dir>] [--check]`
 *
 * Legacy per-route thin files (RFC §4.2 increment 1) for hosts not yet
 * migrated to the code-assembled module: one generated host file per
 * ZERO-PROP `component` route (no `$param` segments) under the host's
 * file-based route tree.
 *
 * `voyant admin generate --destinations [--out <file>] [--check]`
 *
 * Generated destination resolver map (packaged-admin RFC §4.7 endgame):
 * statically scan each admin entry's route contributions for `destination:`
 * annotations — the DECLARED bindings between a semantic destination key and
 * the one route whose path satisfies it by pure param interpolation — and
 * emit ONE committed module (default `src/admin.destinations.generated.ts`)
 * holding a typed resolver per binding (`encodeURIComponent` interpolation,
 * `destinationParams` name mapping), `satisfies
 * Partial<AdminDestinationResolvers>`. The host's resolver map shrinks to
 * `{ ...generatedAdminDestinations, ...custom } satisfies
 * AdminDestinationResolvers` — only genuinely custom resolvers (search-param
 * construction, multi-route targets) stay hand-written. A target file
 * without the generated header is never overwritten (ejected, host-owned).
 *
 * `--check` writes nothing and exits 1 when committed output is missing or
 * differs from what would be generated (CI drift gate).
 */
export async function adminGenerateCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const configFlag = getStringFlag(args, "config")
  const graphFlag = getStringFlag(args, "graph")
  const outFlag = getStringFlag(args, "out")
  const check = getBooleanFlag(args, "check")
  const routesMode = getBooleanFlag(args, "routes")

  const input = await resolveAdminGenerationInput({ ctx, configFlag, graphFlag })
  if (!input) return 1
  if (input.graphAdmin && (routesMode || getBooleanFlag(args, "destinations"))) {
    ctx.stderr(
      formatGraphAdminError(
        new AdminGraphError(
          "VOYANT_ADMIN_GRAPH_LEGACY_MODE",
          "Graph-owned admin facets are emitted by `voyant admin generate --graph`; --routes, --routes --files, and --destinations are legacy source-scanning modes for old graphs only.",
        ),
      ),
    )
    return 1
  }
  if (input.graphAdmin && !routesMode && !getBooleanFlag(args, "destinations")) {
    const content = renderGeneratedAdminGraph(input.graphAdmin)
    const outPath = outFlag
      ? isAbsolute(outFlag)
        ? outFlag
        : resolve(ctx.cwd, outFlag)
      : join(input.dir, DEFAULT_GENERATED_RELATIVE_PATH)
    const printablePath = relative(ctx.cwd, outPath) || outPath

    if (check) {
      const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null
      if (existing === content) {
        ctx.stdout(
          `[admin-generate] ${input.summary}, ${input.graphAdmin.facetCount} admin facets, ${printablePath} is up to date\n`,
        )
        return 0
      }
      ctx.stderr(
        existing === null
          ? `[admin-generate] ${printablePath} is missing — run \`voyant admin generate\`\n`
          : `[admin-generate] ${printablePath} is out of date — run \`voyant admin generate\`\n`,
      )
      return 1
    }

    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, content)
    ctx.stdout(
      `[admin-generate] ${input.summary}, ${input.graphAdmin.facetCount} admin facets, wrote ${printablePath}\n`,
    )
    return 0
  }
  const results = scanAdminEntries(input.modules, input.dir)

  if (routesMode) {
    const routesOptions = {
      ctx,
      configDir: input.dir,
      results,
      check,
      routesConfig: resolveAdminRoutesManifestConfig(input.config),
      routesDirFlag: getStringFlag(args, "routes-dir"),
    }
    return getBooleanFlag(args, "files")
      ? generateRouteFiles(routesOptions)
      : generateRoutesModule({ ...routesOptions, outFlag })
  }

  if (getBooleanFlag(args, "destinations")) {
    return generateDestinationsModule({ ctx, configDir: input.dir, results, check, outFlag })
  }

  for (const result of results) {
    if (result.status === "found" && !result.note) continue
    ctx.stderr(`[admin-generate] ${describeResult(result)}\n`)
  }

  const found = results.filter((result) => result.status === "found")
  const content = renderGeneratedFile(found, input.source)

  const outPath = outFlag
    ? isAbsolute(outFlag)
      ? outFlag
      : resolve(ctx.cwd, outFlag)
    : join(input.dir, DEFAULT_GENERATED_RELATIVE_PATH)
  const printablePath = relative(ctx.cwd, outPath) || outPath

  if (check) {
    const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null
    if (existing === content) {
      ctx.stdout(
        `[admin-generate] ${input.summary}, ${found.length} admin entries, ${printablePath} is up to date\n`,
      )
      return 0
    }
    ctx.stderr(
      existing === null
        ? `[admin-generate] ${printablePath} is missing — run \`voyant admin generate\`\n`
        : `[admin-generate] ${printablePath} is out of date — run \`voyant admin generate\`\n`,
    )
    return 1
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, content)
  ctx.stdout(
    `[admin-generate] ${input.summary}, ${found.length} admin entries, wrote ${printablePath}\n`,
  )
  return 0
}

type AdminGenerationSource = "config" | "graph"

interface AdminGenerationInput {
  config: unknown
  dir: string
  graphAdmin?: ResolvedAdminGraph
  modules: ReadonlyArray<ModuleEntry>
  source: AdminGenerationSource
  summary: string
}

async function resolveAdminGenerationInput({
  ctx,
  configFlag,
  graphFlag,
}: {
  ctx: CommandContext
  configFlag: string | undefined
  graphFlag: string | undefined
}): Promise<AdminGenerationInput | undefined> {
  if (graphFlag) {
    const graphPath = isAbsolute(graphFlag) ? graphFlag : resolve(ctx.cwd, graphFlag)
    let graphInput: GraphAdminInput
    try {
      graphInput = readGraphAdminInput(graphPath)
    } catch (err) {
      ctx.stderr(formatGraphAdminError(err))
      return undefined
    }

    let config: unknown = {}
    if (configFlag) {
      const configPath = resolveConfigPath({ path: configFlag, cwd: ctx.cwd })
      if (!configPath) {
        ctx.stderr(`No voyant config found at ${configFlag}\n`)
        return undefined
      }
      try {
        config = (await loadVoyantConfigFile<VoyantConfig>(configPath)).config
      } catch (err) {
        ctx.stderr(`${err instanceof Error ? err.message : String(err)}\n`)
        return undefined
      }
    }

    return {
      config,
      dir: dirname(graphPath),
      graphAdmin: graphInput.admin,
      modules: graphInput.legacyModules,
      source: "graph",
      summary: graphInput.admin
        ? `${graphInput.admin.units.length} graph-selected units`
        : `${graphInput.legacyModules.length} graph-selected packages (legacy fallback)`,
    }
  }

  const configPath = resolveConfigPath({ path: configFlag, cwd: ctx.cwd })
  if (!configPath) {
    ctx.stderr(
      configFlag
        ? `No voyant config found at ${configFlag}\n`
        : `No voyant.config.* found in ${ctx.cwd} or any parent directory.\n`,
    )
    return undefined
  }

  let config: VoyantConfig
  try {
    config = (await loadVoyantConfigFile<VoyantConfig>(configPath)).config
  } catch (err) {
    ctx.stderr(`${err instanceof Error ? err.message : String(err)}\n`)
    return undefined
  }

  const modules = adminModuleEntries(config)
  return {
    config,
    dir: dirname(configPath),
    modules,
    source: "config",
    summary: `${modules.length} modules`,
  }
}

interface GraphRuntimeReference {
  entry: string
  export?: string
}

interface ResolvedAdminFacet extends Record<string, unknown> {
  id: string
  runtime?: GraphRuntimeReference
}

interface ResolvedAdminUnit {
  id: string
  copy: ResolvedAdminFacet[]
  routes: ResolvedAdminFacet[]
  nav: ResolvedAdminFacet[]
  slots: ResolvedAdminFacet[]
  contributions: ResolvedAdminFacet[]
}

interface ResolvedAdminGraph {
  facetCount: number
  units: ResolvedAdminUnit[]
}

interface GraphAdminInput {
  admin?: ResolvedAdminGraph
  legacyModules: string[]
}

const ADMIN_FACET_KEYS = ["copy", "routes", "nav", "slots", "contributions"] as const

type AdminGraphErrorCode =
  | "VOYANT_ADMIN_GRAPH_DUPLICATE_ID"
  | "VOYANT_ADMIN_GRAPH_DUPLICATE_REFERENCE"
  | "VOYANT_ADMIN_GRAPH_INVALID_FACET"
  | "VOYANT_ADMIN_GRAPH_LEGACY_MODE"
  | "VOYANT_ADMIN_GRAPH_UNKNOWN_REFERENCE"

class AdminGraphError extends Error {
  constructor(
    readonly code: AdminGraphErrorCode,
    message: string,
    readonly reference?: string,
    readonly facetId?: string,
  ) {
    super(message)
    this.name = "AdminGraphError"
  }
}

function formatGraphAdminError(error: unknown): string {
  if (!(error instanceof AdminGraphError)) {
    return `${error instanceof Error ? error.message : String(error)}\n`
  }
  return `${JSON.stringify({
    code: error.code,
    message: error.message,
    ...(error.facetId ? { facetId: error.facetId } : {}),
    ...(error.reference ? { reference: error.reference } : {}),
  })}\n`
}

function readGraphAdminInput(graphPath: string): GraphAdminInput {
  if (!existsSync(graphPath)) {
    throw new Error(`No deployment graph found at ${graphPath}`)
  }

  let graph: unknown
  try {
    graph = JSON.parse(readFileSync(graphPath, "utf8"))
  } catch (err) {
    throw new Error(
      `Failed to read deployment graph at ${graphPath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!isRecord(graph) || !Array.isArray(graph.modules)) {
    throw new Error(`Deployment graph at ${graphPath} has no modules array`)
  }

  const legacyPackages = new Set<string>()
  const adminUnits: ResolvedAdminUnit[] = []
  for (const [unitIndex, unit] of [
    ...graph.modules,
    ...(Array.isArray(graph.plugins) ? graph.plugins : []),
  ].entries()) {
    if (
      isRecord(unit) &&
      typeof unit.packageName === "string" &&
      Array.isArray(unit.api) &&
      unit.api.some((route) => isRecord(route) && route.surface === "admin")
    ) {
      legacyPackages.add(unit.packageName)
    }
    if (!isRecord(unit) || !isRecord(unit.admin)) continue
    const admin = unit.admin
    const facets = Object.fromEntries(
      ADMIN_FACET_KEYS.map((key) => [
        key,
        parseAdminFacetArray(admin[key], `units[${unitIndex}].admin.${key}`),
      ]),
    ) as Record<(typeof ADMIN_FACET_KEYS)[number], ResolvedAdminFacet[]>
    if (ADMIN_FACET_KEYS.every((key) => facets[key].length === 0)) continue
    const id = requireGraphString(unit.id, `units[${unitIndex}].id`)
    adminUnits.push({ id, ...facets })
  }
  // Explicit compatibility boundary: only graphs with zero package-owned
  // admin facets may use the package-name/export scanner.
  if (adminUnits.length === 0) return { legacyModules: [...legacyPackages] }
  if (graph.schemaVersion !== "voyant.resolved-graph.v1") {
    throw new AdminGraphError(
      "VOYANT_ADMIN_GRAPH_INVALID_FACET",
      `Graph-owned admin facets require schemaVersion voyant.resolved-graph.v1, got ${String(graph.schemaVersion)}`,
      "schemaVersion",
    )
  }

  adminUnits.sort((left, right) => left.id.localeCompare(right.id))
  for (const unit of adminUnits) {
    for (const key of ADMIN_FACET_KEYS) {
      unit[key].sort((left, right) => left.id.localeCompare(right.id))
    }
  }
  validateAdminGraph(adminUnits)
  return {
    admin: {
      facetCount: adminUnits.reduce(
        (count, unit) =>
          count + ADMIN_FACET_KEYS.reduce((unitCount, key) => unitCount + unit[key].length, 0),
        0,
      ),
      units: adminUnits,
    },
    legacyModules: [],
  }
}

function parseAdminFacetArray(value: unknown, label: string): ResolvedAdminFacet[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((facet, index) => {
    if (!isRecord(facet)) throw new Error(`${label}[${index}] must be an object`)
    return { ...facet, id: requireGraphString(facet.id, `${label}[${index}].id`) }
  })
}

function requireGraphString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`)
  return value
}

function validateAdminGraph(units: ReadonlyArray<ResolvedAdminUnit>): void {
  const seenIds = new Set<string>()
  const routeIds = new Set<string>()
  const slotIds = new Set<string>()
  const copyNamespaces = new Set<string>()
  for (const unit of units) {
    for (const key of ADMIN_FACET_KEYS) {
      for (const facet of unit[key]) {
        if (seenIds.has(facet.id)) {
          throw new AdminGraphError(
            "VOYANT_ADMIN_GRAPH_DUPLICATE_ID",
            `Duplicate admin facet id: ${facet.id}`,
            facet.id,
            facet.id,
          )
        }
        seenIds.add(facet.id)
      }
    }
    for (const copy of unit.copy) {
      const namespace = requireFacetString(copy.namespace, copy.id, "namespace")
      if (copyNamespaces.has(namespace)) {
        throw new AdminGraphError(
          "VOYANT_ADMIN_GRAPH_DUPLICATE_REFERENCE",
          `Duplicate admin copy namespace: ${namespace}`,
          namespace,
          copy.id,
        )
      }
      copyNamespaces.add(namespace)
      validateFacetRuntime(copy)
    }
    for (const route of unit.routes) {
      routeIds.add(route.id)
      requireFacetString(route.path, route.id, "path")
      validateFacetRuntime(route)
    }
    for (const slot of unit.slots) slotIds.add(slot.id)
    for (const contribution of unit.contributions) validateFacetRuntime(contribution)
  }

  for (const unit of units) {
    for (const nav of unit.nav) {
      validateKnownReference(nav, "routeId", routeIds)
      validateMessageReference(nav.label, nav.id, "label", copyNamespaces)
    }
    for (const slot of unit.slots) validateKnownReference(slot, "routeId", routeIds)
    for (const route of unit.routes) {
      validateMessageReferences(route.copy, route.id, "copy", copyNamespaces)
    }
    for (const contribution of unit.contributions) {
      validateKnownReference(contribution, "slotId", slotIds)
      validateMessageReferences(contribution.copy, contribution.id, "copy", copyNamespaces)
    }
  }
}

function requireFacetString(value: unknown, facetId: string, field: string): string {
  if (typeof value === "string" && value.length > 0) return value
  throw new AdminGraphError(
    "VOYANT_ADMIN_GRAPH_INVALID_FACET",
    `${facetId}.${field} must be a non-empty string`,
    field,
    facetId,
  )
}

function validateFacetRuntime(facet: ResolvedAdminFacet): void {
  try {
    parseRuntimeReference(facet.runtime, `${facet.id}.runtime`)
  } catch (error) {
    throw new AdminGraphError(
      "VOYANT_ADMIN_GRAPH_INVALID_FACET",
      error instanceof Error ? error.message : String(error),
      "runtime",
      facet.id,
    )
  }
}

function validateKnownReference(
  facet: ResolvedAdminFacet,
  field: string,
  known: ReadonlySet<string>,
): void {
  const reference = requireFacetString(facet[field], facet.id, field)
  if (known.has(reference)) return
  throw new AdminGraphError(
    "VOYANT_ADMIN_GRAPH_UNKNOWN_REFERENCE",
    `${facet.id}.${field} references unknown admin facet ${reference}`,
    reference,
    facet.id,
  )
}

function validateMessageReferences(
  value: unknown,
  facetId: string,
  field: string,
  namespaces: ReadonlySet<string>,
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    throw new AdminGraphError(
      "VOYANT_ADMIN_GRAPH_INVALID_FACET",
      `${facetId}.${field} must be an array`,
      field,
      facetId,
    )
  }
  for (const [index, reference] of value.entries()) {
    validateMessageReference(reference, facetId, `${field}[${index}]`, namespaces)
  }
}

function validateMessageReference(
  value: unknown,
  facetId: string,
  field: string,
  namespaces: ReadonlySet<string>,
): void {
  if (!isRecord(value)) {
    throw new AdminGraphError(
      "VOYANT_ADMIN_GRAPH_INVALID_FACET",
      `${facetId}.${field} must be a message reference`,
      field,
      facetId,
    )
  }
  const namespace = requireFacetString(value.namespace, facetId, `${field}.namespace`)
  requireFacetString(value.key, facetId, `${field}.key`)
  if (namespaces.has(namespace)) return
  throw new AdminGraphError(
    "VOYANT_ADMIN_GRAPH_UNKNOWN_REFERENCE",
    `${facetId}.${field} references unknown admin copy namespace ${namespace}`,
    namespace,
    facetId,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function describeResult(result: AdminEntryScanResult): string {
  switch (result.status) {
    case "found":
      return `note: ${result.moduleName} — ${result.note}`
    case "missing-export":
      return `warning: skipped ${result.moduleName} — ${result.note}`
    case "module-unresolved":
    case "not-a-package":
      return `note: skipped ${result.moduleName} — ${result.note}`
    default:
      return `note: ${result.moduleName} — ${result.note} (no admin entry)`
  }
}

/**
 * Render the committed composition file. Deterministic output (manifest
 * order) so `--check` is a pure string comparison.
 */
export function renderGeneratedFile(
  found: ReadonlyArray<AdminEntryScanResult>,
  source: AdminGenerationSource = "config",
): string {
  const header =
    source === "graph"
      ? [
          "// GENERATED by voyant admin generate — do not edit.",
          "// Recreate from the selected deployment graph:",
          "//   voyant admin generate --graph deployment-graph.generated.json",
          "",
        ]
      : [
          "// GENERATED by voyant admin generate — do not edit.",
          "// Recreate after changing the modules list in voyant.config.*:",
          "//   voyant admin generate",
          "",
        ]

  const imports = found.map((entry) => `import { ${entry.exportName} } from "${entry.importSpec}"`)

  const body = [
    "/**",
    " * Admin extension factories keyed by module domain. Factories, not",
    " * instances — hosts call each with localized labels/icons before",
    " * registering the result.",
    " */",
    "export const generatedAdminExtensionFactories = {",
    ...found.map((entry) => `  ${entry.camel}: ${entry.exportName},`),
    "} as const",
    "",
  ]

  return [...header, ...(imports.length > 0 ? [...imports, ""] : []), ...body].join("\n")
}

interface RawTsExpression {
  readonly __rawTsExpression: string
}

function renderGeneratedAdminGraph(graph: ResolvedAdminGraph): string {
  const imports = collectAdminRuntimeImports(graph)
  const bindingByFacetId = new Map(imports.map((entry) => [entry.facetId, entry.binding]))
  const runtimeBindingLines = renderRuntimeBindings(imports)
  const units = graph.units.map((unit) => ({
    id: unit.id,
    ...Object.fromEntries(
      ADMIN_FACET_KEYS.map((key) => [
        key,
        unit[key].map((facet) => {
          const binding = bindingByFacetId.get(facet.id)
          return binding
            ? { ...facet, runtime: { __rawTsExpression: binding } satisfies RawTsExpression }
            : facet
        }),
      ]),
    ),
  }))

  return [
    "// GENERATED by voyant admin generate — do not edit.",
    "// Recreate from the selected target-neutral deployment graph:",
    "//   voyant admin generate --graph .voyant/deployment-graph.generated.json",
    "// Package-owned admin facets are authoritative; no package-name conventions are used.",
    "",
    ...runtimeBindingLines,
    ...(runtimeBindingLines.length > 0 ? [""] : []),
    `export const generatedAdminGraph = ${renderTsValue({ units })} as const`,
    "",
  ].join("\n")
}

interface FacetRuntimeImport {
  binding: string
  entry: string
  exportName?: string
  facetId: string
}

function collectAdminRuntimeImports(graph: ResolvedAdminGraph): FacetRuntimeImport[] {
  const candidates: Array<Omit<FacetRuntimeImport, "binding">> = []
  for (const unit of graph.units) {
    for (const key of ["copy", "routes", "contributions"] as const) {
      for (const facet of unit[key]) {
        const runtime = parseRuntimeReference(facet.runtime, `${facet.id}.runtime`)
        candidates.push({ entry: runtime.entry, exportName: runtime.export, facetId: facet.id })
      }
    }
  }
  candidates.sort(
    (left, right) =>
      left.entry.localeCompare(right.entry) ||
      (left.exportName ?? "default").localeCompare(right.exportName ?? "default") ||
      left.facetId.localeCompare(right.facetId),
  )
  const bindingCounts = new Map<string, number>()
  return candidates.map((candidate) => {
    const base = runtimeBindingName(candidate.facetId)
    const count = (bindingCounts.get(base) ?? 0) + 1
    bindingCounts.set(base, count)
    return {
      ...candidate,
      binding: count === 1 ? base : `${base}${count}`,
    }
  })
}

function parseRuntimeReference(value: unknown, label: string): GraphRuntimeReference {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  const entry = requireGraphString(value.entry, `${label}.entry`)
  if (
    value.export !== undefined &&
    (typeof value.export !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value.export))
  ) {
    throw new Error(`${label}.export must be a JavaScript export identifier`)
  }
  return { entry, ...(typeof value.export === "string" ? { export: value.export } : {}) }
}

function runtimeBindingName(facetId: string): string {
  const localId = facetId.includes("#") ? facetId.slice(facetId.indexOf("#") + 1) : facetId
  const base = toCamelCase(localId.replaceAll(/[^A-Za-z0-9]+/g, "-")) || "admin"
  return `${/^[0-9]/.test(base) ? `admin${toPascalCase(base)}` : base}Runtime`
}

function renderRuntimeBindings(imports: ReadonlyArray<FacetRuntimeImport>): string[] {
  return imports.flatMap((runtimeImport) => {
    const member = `module.${runtimeImport.exportName ?? "default"}`
    const expression = `  import(${JSON.stringify(runtimeImport.entry)}).then((module) => ${member})`
    return expression.length <= 100
      ? [`const ${runtimeImport.binding} = () =>`, expression]
      : [
          `const ${runtimeImport.binding} = () =>`,
          `  import(${JSON.stringify(runtimeImport.entry)}).then(`,
          `    (module) => ${member},`,
          "  )",
        ]
  })
}

function renderTsValue(value: unknown, indent = 0): string {
  if (isRecord(value) && typeof value.__rawTsExpression === "string") {
    return value.__rawTsExpression
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const prefix = " ".repeat(indent + 2)
    return `[\n${value.map((item) => `${prefix}${renderTsValue(item, indent + 2)},`).join("\n")}\n${" ".repeat(indent)}]`
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    if (entries.length === 0) return "{}"
    const prefix = " ".repeat(indent + 2)
    return `{\n${entries
      .map(([key, item]) => `${prefix}${renderTsKey(key)}: ${renderTsValue(item, indent + 2)},`)
      .join("\n")}\n${" ".repeat(indent)}}`
  }
  return JSON.stringify(value)
}

function renderTsKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
}

interface GenerateRouteFilesOptions {
  ctx: CommandContext
  configDir: string
  results: ReadonlyArray<AdminEntryScanResult>
  check: boolean
  routesConfig: AdminRoutesManifestConfig
  routesDirFlag: string | undefined
}

type FoundAdminEntry = AdminEntryScanResult & { importSpec: string; sourcePath: string }

function foundEntries(results: ReadonlyArray<AdminEntryScanResult>): FoundAdminEntry[] {
  return results.filter(
    (result): result is FoundAdminEntry =>
      result.status === "found" &&
      result.importSpec !== undefined &&
      result.sourcePath !== undefined,
  )
}

interface GenerateRoutesModuleOptions extends GenerateRouteFilesOptions {
  outFlag: string | undefined
}

/**
 * `voyant admin generate --routes` — emit the code-assembled admin route
 * module (packaged-admin RFC §4.8).
 *
 * Per contribution:
 * - no statically resolvable id/path → note, skipped (the generator only
 *   trusts what it can read without executing the entry)
 * - no implementation (`page`/`component`/`redirectTo`) → skipped,
 *   metadata-only — those stay bound by hand-written host route files
 * - nested `children: [...]` → the contribution becomes a layout parent:
 *   statically scanned children are emitted as literal child routes (typed
 *   links included) and listed on the runtime binding's `exclude:`;
 *   runtime-known children (spreads the scan cannot see) bind through the
 *   emitted `adminExtensionChildRoutes` tail
 * - a route file under the routes dir WITHOUT the generated header → that
 *   single route is ejected: omitted from the module and reported
 * - a leftover GENERATED thin route file (RFC §4.2 increment 1) → superseded
 *   by the module: deleted on write, reported as drift with `--check`
 * - `validateSearch` whose schema identifier cannot be statically resolved
 *   to an export of the entry → emitted without the typed search contract,
 *   noted (the runtime contract still applies via the contribution)
 *
 * The built-in core entry contributes its static route table (the factory
 * builds routes imperatively, invisible to the source scanner); it assumes
 * default factory options — hosts using `settings.omit` or per-surface
 * ejection flags should eject or hand-edit the affected routes.
 *
 * A target module without the generated header is the host's own (ejected
 * wholesale) and is never overwritten.
 */
function generateRoutesModule(options: GenerateRoutesModuleOptions): CommandResult {
  const { ctx, configDir, results, check, routesConfig } = options
  const routesDirRel = options.routesDirFlag ?? routesConfig.dir ?? DEFAULT_ROUTES_DIR
  const routesDir = isAbsolute(routesDirRel) ? routesDirRel : join(configDir, routesDirRel)
  const outRel =
    options.outFlag ?? routesConfig.out ?? DEFAULT_GENERATED_ROUTES_MODULE_RELATIVE_PATH
  const outPath = isAbsolute(outRel)
    ? outRel
    : options.outFlag
      ? resolve(ctx.cwd, outRel)
      : join(configDir, outRel)
  const printableOut = relative(ctx.cwd, outPath) || outPath

  let ejected = 0
  let metadataOnly = 0
  const supersededFiles: string[] = []
  const sections: AdminRoutesModuleSection[] = []
  const found = foundEntries(results)

  // Manifest-derived admin entries plus the built-in core entry
  // (`@voyant-travel/admin-app/core-extension`), which is not a manifest module.
  // Conditional on resolvability so pre-core hosts are unaffected.
  interface RoutesEntry {
    importSpec: string
    extensionId: string
    /** Entry source for schema-identifier resolution; null for the built-in core entry. */
    source: string | null
    contributions: ReadonlyArray<ScannedRouteContribution>
    subtreeComments?: Readonly<Record<string, ReadonlyArray<string>>>
  }
  const routesEntries: RoutesEntry[] = []
  for (const entry of found) {
    let source: string
    try {
      source = readFileSync(entry.sourcePath, "utf8")
    } catch {
      ctx.stderr(`[admin-generate] routes: note — ${entry.importSpec} source not readable\n`)
      continue
    }
    routesEntries.push({
      importSpec: entry.importSpec,
      extensionId: scanExtensionId(source) ?? entry.domain,
      source,
      contributions: scanRouteContributions(source),
    })
  }
  const coreEntry = resolveCoreAdminEntry(configDir)
  if (coreEntry) {
    if (coreEntry.note) {
      ctx.stderr(`[admin-generate] routes: note — ${coreEntry.note}\n`)
    }
    routesEntries.push({
      importSpec: coreEntry.importSpec,
      extensionId: coreEntry.extensionId,
      source: null,
      contributions: coreEntry.contributions,
      subtreeComments: coreEntry.subtreeComments,
    })
  } else {
    ctx.stderr(
      `[admin-generate] routes: note — built-in core entry skipped (no ` +
        `@voyant-travel/admin-app with a "./core-extension" export resolvable from the host)\n`,
    )
  }

  /** Note + null when a validateSearch schema is not an exported identifier. */
  const schemaIdentFor = (
    contribution: ScannedRouteContribution,
    entry: RoutesEntry,
  ): string | null => {
    if (!contribution.hasValidateSearch) return null
    const ident =
      contribution.validateSearchRaw === null || entry.source === null
        ? null
        : resolveSearchSchemaIdent(contribution.validateSearchRaw, entry.source)
    if (ident === null) {
      ctx.stderr(
        `[admin-generate] routes: note — ${contribution.id} has a validateSearch whose ` +
          `schema is not an export of ${entry.importSpec}; emitted without a typed ` +
          `search contract\n`,
      )
    }
    return ident
  }

  /**
   * Existing route files for an absolute path. Returns null when a
   * hand-written (header-less) file binds it — that route is ejected; the
   * caller reports and skips. Generator-owned leftovers are superseded.
   */
  const probeRouteFiles = (absolutePath: string): { superseded: string[] } | null => {
    const existingFiles = [
      canonicalRouteFileRelPath(absolutePath),
      ...alternativeRouteFileRelPaths(absolutePath),
    ]
      .map((rel) => join(routesDir, rel))
      .filter((candidate) => existsSync(candidate))
    const handWritten = existingFiles.find(
      (file) => !isGeneratedRouteFile(readFileSync(file, "utf8")),
    )
    if (handWritten !== undefined) {
      ejected++
      const printableFile = relative(ctx.cwd, handWritten) || handWritten
      ctx.stderr(
        `[admin-generate] routes: skipped ${absolutePath} — hand-written host ` +
          `${printableFile} binds this route (ejected)\n`,
      )
      return null
    }
    return { superseded: existingFiles }
  }

  for (const entry of routesEntries) {
    const routes: AdminRoutesModuleRoute[] = []
    for (const contribution of entry.contributions) {
      if (contribution.id === null || contribution.path === null) {
        ctx.stderr(
          `[admin-generate] routes: note — skipped a ${entry.importSpec} contribution ` +
            `(id/path not statically resolvable${
              contribution.rawPath === null ? "" : `: path ${contribution.rawPath}`
            })\n`,
        )
        continue
      }
      if (!isImplementedContribution(contribution)) {
        metadataOnly++
        continue
      }

      // Route-level ejection: a route file for this path that is NOT
      // generator-owned means the host hand-binds it — leave it out.
      // Leftover generated thin files (increment 1) are superseded by the module.
      const probe = probeRouteFiles(contribution.path)
      if (probe === null) continue
      supersededFiles.push(...probe.superseded)

      const route: AdminRoutesModuleRoute = {
        constName: `${toPascalCase(contribution.id)}Route`,
        routeId: contribution.id,
        path: contribution.path,
        searchSchemaIdent: schemaIdentFor(contribution, entry),
      }

      if (contribution.children !== null) {
        // Nested subtree: statically scanned children get literal child
        // routes (and typed-link entries) plus a slot on the runtime
        // binding's exclude list; children the scan cannot resolve are left
        // to `adminExtensionChildRoutes` at runtime.
        const children: AdminRoutesModuleChildRoute[] = []
        const excludeChildPaths: string[] = []
        for (const child of contribution.children) {
          if (child.id === null || child.path === null || !child.path.startsWith("/")) {
            ctx.stderr(
              `[admin-generate] routes: note — a ${entry.importSpec} child contribution of ` +
                `${contribution.id} is not statically resolvable; left to the runtime ` +
                `child binding\n`,
            )
            continue
          }
          // Excluded even when skipped below: the runtime binding must never
          // double-bind a statically known child path.
          excludeChildPaths.push(child.path)
          if (!isImplementedContribution(child)) {
            metadataOnly++
            continue
          }
          if (child.path !== "/") {
            const childProbe = probeRouteFiles(`${contribution.path}${child.path}`)
            if (childProbe === null) continue
            supersededFiles.push(...childProbe.superseded)
          }
          children.push({
            constName: `${toPascalCase(child.id)}Route`,
            routeId: child.id,
            path: child.path,
            searchSchemaIdent: schemaIdentFor(child, entry),
          })
        }
        route.children = children
        route.excludeChildPaths = excludeChildPaths
        const subtreeComment = entry.subtreeComments?.[contribution.id]
        if (subtreeComment !== undefined) route.subtreeComment = subtreeComment
      }

      routes.push(route)
    }

    if (routes.length > 0) {
      sections.push({
        extensionId: entry.extensionId,
        importSpec: entry.importSpec,
        routes,
      })
    }
  }

  sections.sort((a, b) =>
    a.extensionId < b.extensionId ? -1 : a.extensionId > b.extensionId ? 1 : 0,
  )
  const routeCount = sections.reduce(
    (sum, section) =>
      sum +
      section.routes.reduce((routeSum, route) => routeSum + 1 + (route.children?.length ?? 0), 0),
    0,
  )

  if (routeCount === 0) {
    const stale = existsSync(outPath) ? readFileSync(outPath, "utf8") : null
    if (stale !== null && isGeneratedRouteFile(stale)) {
      if (check) {
        ctx.stderr(
          `[admin-generate] routes: ${printableOut} is stale — no implemented extension ` +
            `route contributions remain; run \`voyant admin generate --routes\`\n`,
        )
        return 1
      }
      rmSync(outPath)
      ctx.stdout(
        `[admin-generate] routes: removed ${printableOut} — no implemented extension ` +
          `route contributions remain\n`,
      )
      return 0
    }
    if (stale !== null) {
      ctx.stderr(
        `[admin-generate] routes: ${printableOut} has no generated header (ejected, ` +
          `host-owned) — left in place despite zero implemented contributions\n`,
      )
    }
    ctx.stdout(
      `[admin-generate] routes: no implemented extension route contributions across ` +
        `${routesEntries.length} admin entries — nothing to emit\n`,
    )
    return 0
  }

  // Alias derivation needs a config-relative dir: an absolute --routes-dir
  // would otherwise produce imports like `@//abs/path/...`.
  const routesDirForAlias = isAbsolute(routesDirRel)
    ? relative(configDir, routesDirRel).replaceAll("\\", "/")
    : routesDirRel
  if (
    !routesConfig.workspaceRouteModule &&
    (routesDirForAlias.startsWith("..") || isAbsolute(routesDirForAlias))
  ) {
    ctx.stderr(
      `[admin-generate] routes: --routes-dir resolves outside the project root — set ` +
        `admin.routes.workspaceRouteModule in voyant.config.* to the host's workspace ` +
        `layout import\n`,
    )
    return 1
  }
  const content = renderAdminRoutesModule({
    moduleBaseName: basename(outPath).replace(/\.[^.]+$/, ""),
    sections,
    imports: routesConfig.imports,
    workspaceRouteModule:
      routesConfig.workspaceRouteModule ?? workspaceRouteModuleFor(routesDirForAlias),
    routeIdPrefix: routeIdPrefixFor(routesDirForAlias),
  })

  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null
  if (existing !== null && !isGeneratedRouteFile(existing)) {
    ctx.stderr(
      `[admin-generate] routes: skipped ${printableOut} — it has no generated header ` +
        `(ejected, host-owned)\n`,
    )
    return 0
  }

  const summary = (state: string): string =>
    `[admin-generate] routes: ${routeCount} extension route(s) across ${sections.length} ` +
    `extension(s) — ${printableOut} ${state}, ${ejected} ejected, ${metadataOnly} ` +
    `metadata-only contribution(s) left to hand-written hosts\n`

  if (check) {
    let drift = 0
    if (existing !== content) {
      drift++
      ctx.stderr(
        existing === null
          ? `[admin-generate] routes: ${printableOut} is missing — run \`voyant admin generate --routes\`\n`
          : `[admin-generate] routes: ${printableOut} is out of date — run \`voyant admin generate --routes\`\n`,
      )
    }
    for (const file of supersededFiles) {
      drift++
      const printableFile = relative(ctx.cwd, file) || file
      ctx.stderr(
        `[admin-generate] routes: ${printableFile} is a generated thin route file superseded ` +
          `by ${printableOut} — run \`voyant admin generate --routes\`\n`,
      )
    }
    ctx.stdout(summary(drift > 0 ? "drifted" : "is up to date"))
    return drift > 0 ? 1 : 0
  }

  for (const file of supersededFiles) {
    rmSync(file)
    const printableFile = relative(ctx.cwd, file) || file
    ctx.stdout(
      `[admin-generate] routes: removed ${printableFile} (superseded generated thin route file)\n`,
    )
  }
  if (existing === content) {
    ctx.stdout(summary("is up to date"))
    return 0
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, content)
  ctx.stdout(summary(existing === null ? "written" : "rewritten"))
  return 0
}

interface GenerateDestinationsModuleOptions {
  ctx: CommandContext
  configDir: string
  results: ReadonlyArray<AdminEntryScanResult>
  check: boolean
  outFlag: string | undefined
}

/**
 * `voyant admin generate --destinations` — emit the generated destination
 * resolver map (packaged-admin RFC §4.7 endgame).
 *
 * Per annotated contribution:
 * - no statically resolvable route path → note, skipped (the generator only
 *   trusts what it can read without executing the entry)
 * - duplicate destination key across contributions → first wins, noted
 * - otherwise → a pure path-interpolation resolver is emitted
 *
 * A target module without the generated header is the host's own (ejected
 * wholesale) and is never overwritten. When no annotations remain, a stale
 * generated module is removed (reported as drift with `--check`).
 */
function generateDestinationsModule(options: GenerateDestinationsModuleOptions): CommandResult {
  const { ctx, configDir, results, check } = options
  const outRel = options.outFlag ?? DEFAULT_GENERATED_DESTINATIONS_MODULE_RELATIVE_PATH
  const outPath = isAbsolute(outRel)
    ? outRel
    : options.outFlag
      ? resolve(ctx.cwd, outRel)
      : join(configDir, outRel)
  const printableOut = relative(ctx.cwd, outPath) || outPath

  const found = foundEntries(results)
  const sources: Array<{ importSpec: string; source: string }> = []
  for (const entry of found) {
    try {
      sources.push({ importSpec: entry.importSpec, source: readFileSync(entry.sourcePath, "utf8") })
    } catch {
      ctx.stderr(`[admin-generate] destinations: note — ${entry.importSpec} source not readable\n`)
    }
  }

  const { bindings, notes } = collectDestinationBindings(sources)
  for (const note of notes) {
    ctx.stderr(`[admin-generate] destinations: note — ${note}\n`)
  }

  if (bindings.length === 0) {
    const stale = existsSync(outPath) ? readFileSync(outPath, "utf8") : null
    if (stale !== null && isGeneratedDestinationsFile(stale)) {
      if (check) {
        ctx.stderr(
          `[admin-generate] destinations: ${printableOut} is stale — no route-backed ` +
            `destination annotations remain; run \`voyant admin generate --destinations\`\n`,
        )
        return 1
      }
      rmSync(outPath)
      ctx.stdout(
        `[admin-generate] destinations: removed ${printableOut} — no route-backed ` +
          `destination annotations remain\n`,
      )
      return 0
    }
    if (stale !== null) {
      ctx.stderr(
        `[admin-generate] destinations: ${printableOut} has no generated header (ejected, ` +
          `host-owned) — left in place despite zero destination annotations\n`,
      )
    }
    ctx.stdout(
      `[admin-generate] destinations: no route-backed destination annotations across ` +
        `${found.length} admin entries — nothing to emit\n`,
    )
    return 0
  }

  const content = renderAdminDestinationsModule({
    bindings,
    importSpecs: sources.map((entry) => entry.importSpec),
  })

  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null
  if (existing !== null && !isGeneratedDestinationsFile(existing)) {
    ctx.stderr(
      `[admin-generate] destinations: skipped ${printableOut} — it has no generated header ` +
        `(ejected, host-owned)\n`,
    )
    return 0
  }

  const summary = (state: string): string =>
    `[admin-generate] destinations: ${bindings.length} route-backed resolver(s) across ` +
    `${found.length} admin entries — ${printableOut} ${state}\n`

  if (check) {
    if (existing !== content) {
      ctx.stderr(
        existing === null
          ? `[admin-generate] destinations: ${printableOut} is missing — run \`voyant admin generate --destinations\`\n`
          : `[admin-generate] destinations: ${printableOut} is out of date — run \`voyant admin generate --destinations\`\n`,
      )
      ctx.stdout(summary("drifted"))
      return 1
    }
    ctx.stdout(summary("is up to date"))
    return 0
  }

  if (existing === content) {
    ctx.stdout(summary("is up to date"))
    return 0
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, content)
  ctx.stdout(summary(existing === null ? "written" : "rewritten"))
  return 0
}

/**
 * `voyant admin generate --routes --files` — LEGACY per-route thin files
 * (RFC §4.2 increment 1) for hosts not yet on the code-assembled module:
 * one generated host file per zero-prop route contribution.
 *
 * Per contribution:
 * - no statically resolvable id/path → note, skipped (the generator only
 *   trusts what it can read without executing the entry)
 * - carries `redirectTo` or nested `children` → skipped (module-only
 *   concepts; migrate to the code-assembled module). The built-in core
 *   entry is likewise module-only and never emits thin files.
 * - path contains `$param` segments → skipped, hand-written hosts bind params
 * - no `component` → skipped (thin files cannot bind lazy `page` modules —
 *   migrate to the code-assembled module for those)
 * - an existing file WITHOUT the generated header → skipped and reported:
 *   that file is ejected (hand-written), and stays the host's own
 * - otherwise → written (or, with `--check`, compared for drift)
 */
function generateRouteFiles(options: GenerateRouteFilesOptions): CommandResult {
  const { ctx, configDir, results, check, routesConfig } = options
  const routesDirRel = options.routesDirFlag ?? routesConfig.dir ?? DEFAULT_ROUTES_DIR
  const routesDir = isAbsolute(routesDirRel) ? routesDirRel : join(configDir, routesDirRel)

  let eligible = 0
  let written = 0
  let upToDate = 0
  let ejected = 0
  let paramSkipped = 0
  let metadataOnly = 0
  let moduleOnly = 0
  let drift = 0

  const found = foundEntries(results)

  for (const entry of found) {
    let source: string
    try {
      source = readFileSync(entry.sourcePath, "utf8")
    } catch {
      ctx.stderr(`[admin-generate] routes: note — ${entry.importSpec} source not readable\n`)
      continue
    }

    for (const contribution of scanRouteContributions(source)) {
      if (contribution.id === null || contribution.path === null) {
        ctx.stderr(
          `[admin-generate] routes: note — skipped a ${entry.importSpec} contribution ` +
            `(id/path not statically resolvable${
              contribution.rawPath === null ? "" : `: path ${contribution.rawPath}`
            })\n`,
        )
        continue
      }
      // Redirect and nested-children contributions are module-only concepts
      // (beforeLoad redirects / addChildren subtrees) — thin files cannot
      // express them; migrate to the code-assembled module.
      if (contribution.hasRedirectTo || contribution.children !== null) {
        moduleOnly++
        continue
      }
      if (contribution.path.includes("$")) {
        paramSkipped++
        continue
      }
      if (!contribution.hasComponent) {
        metadataOnly++
        continue
      }

      eligible++
      const canonicalRel = canonicalRouteFileRelPath(contribution.path)
      const canonicalPath = join(routesDir, canonicalRel)
      const printable = relative(ctx.cwd, canonicalPath) || canonicalPath

      const handWritten = alternativeRouteFileRelPaths(contribution.path)
        .map((rel) => join(routesDir, rel))
        .find((candidate) => existsSync(candidate))
      const existing = existsSync(canonicalPath) ? readFileSync(canonicalPath, "utf8") : null

      if (existing !== null && !isGeneratedRouteFile(existing)) {
        ejected++
        ctx.stderr(
          `[admin-generate] routes: skipped ${contribution.path} — ${printable} has no ` +
            `generated header (ejected, hand-written host)\n`,
        )
        continue
      }
      if (existing === null && handWritten !== undefined) {
        ejected++
        const printableHandWritten = relative(ctx.cwd, handWritten) || handWritten
        ctx.stderr(
          `[admin-generate] routes: skipped ${contribution.path} — hand-written host ` +
            `${printableHandWritten} already binds this route\n`,
        )
        continue
      }

      const content = renderRouteFile({
        fileRouteId: fileRouteIdFor(routesDirRel, contribution.path),
        importSpec: entry.importSpec,
        exportName: entry.exportName,
        routeId: contribution.id,
        ssr: contribution.ssr,
        preload: contribution.preload,
        hasLoader: contribution.hasLoader,
        hasValidateSearch: contribution.hasValidateSearch,
        runtime: routesConfig.imports,
      })

      if (existing === content) {
        upToDate++
        continue
      }
      if (check) {
        drift++
        ctx.stderr(
          existing === null
            ? `[admin-generate] routes: ${printable} is missing — run \`voyant admin generate --routes --files\`\n`
            : `[admin-generate] routes: ${printable} is out of date — run \`voyant admin generate --routes --files\`\n`,
        )
        continue
      }
      mkdirSync(dirname(canonicalPath), { recursive: true })
      writeFileSync(canonicalPath, content)
      written++
      ctx.stdout(
        `[admin-generate] routes: wrote ${printable} (${entry.importSpec} ${contribution.id})\n`,
      )
    }
  }

  ctx.stdout(
    `[admin-generate] routes: ${eligible} zero-prop route(s) across ${found.length} admin ` +
      `entries — ${check ? `${upToDate} up to date, ${drift} drifted` : `${written} written, ${upToDate} up to date`}, ` +
      `${ejected} ejected, ${paramSkipped} param route(s) and ${metadataOnly} metadata-only ` +
      `contribution(s) left to hand-written hosts` +
      `${moduleOnly > 0 ? `, ${moduleOnly} redirect/children contribution(s) left to the code-assembled module` : ""}\n`,
  )
  return check && drift > 0 ? 1 : 0
}
