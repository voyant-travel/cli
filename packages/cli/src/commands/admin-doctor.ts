import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import type { VoyantConfig } from "@voyant-travel/core/config"
import { resolveCoreAdminEntry } from "../lib/admin-core-entry.js"
import {
  type AdminEntryScanResult,
  DEFAULT_GENERATED_RELATIVE_PATH,
  scanAdminEntries,
} from "../lib/admin-entries.js"
import {
  collectContributionRoutePaths,
  collectDestinationBindings,
  DEFAULT_GENERATED_DESTINATIONS_MODULE_RELATIVE_PATH,
  DEFAULT_GENERATED_ROUTES_MODULE_RELATIVE_PATH,
  DEFAULT_ROUTES_DIR,
  isGeneratedDestinationsFile,
  renderAdminDestinationsModule,
  resolveAdminRoutesManifestConfig,
  scanDeclaredDestinationKeys,
  scanGeneratedDestinationKeys,
  scanGeneratedModuleRoutePaths,
  scanResolverMapKeys,
  scanRouteContributions,
} from "../lib/admin-routes.js"
import { getStringFlag, parseArgs } from "../lib/args.js"
import { loadVoyantConfigFile, resolveConfigPath } from "../lib/config-loader.js"
import type { CommandContext, CommandResult } from "../types.js"

/** Default location (relative to the config dir) of the host's destination resolver map. */
export const DEFAULT_DESTINATIONS_RELATIVE_PATH = "src/lib/admin-destinations.ts"

/**
 * `voyant admin doctor [--config <path>] [--out <file>] [--destinations <file>]
 * [--destinations-out <file>] [--routes-dir <dir>] [--routes-out <file>]`
 *
 * Parity check for the manifest ↔ admin extension ↔ route chain
 * (packaged-admin RFC §4.1). Findings A–C and the custom half of Finding D
 * are report-only; the GENERATED half of Finding D is a gate — any gating
 * finding makes the command exit 1 (aligned with `voyant admin generate
 * --destinations --check`).
 *
 * - **A** — a module's admin entry exists but is not imported in the
 *   generated composition file (or the file is missing entirely).
 * - **B** — the generated file imports an admin entry whose module is no
 *   longer in the manifest.
 * - **C** — best-effort route parity: a route contribution's statically
 *   resolvable path is bound NEITHER by a route file under the host's routes
 *   dir (default `src/routes/_workspace`, override with `--routes-dir` or
 *   the manifest's `admin.routes.dir`) NOR by an entry in the host's
 *   code-assembled admin route module (default
 *   `src/admin.routes.generated.tsx`, override with `--routes-out` or the
 *   manifest's `admin.routes.out` — see packaged-admin RFC §4.8). Nested
 *   `children` are traversed (absolute paths reconstructed on both sides);
 *   redirect-only contributions count as implemented and are satisfied by a
 *   module entry alone; the built-in core entry
 *   (`@voyant-travel/admin-app/core-extension`) participates when resolvable.
 *   Static scan only — nothing is imported.
 * - **D** — destination parity (RFC §4.7). Two halves:
 *   - GENERATED (gate, exit 1): the generated resolver module (default
 *     `src/admin.destinations.generated.ts`, override with
 *     `--destinations-out`) must exactly reflect the route contributions'
 *     `destination:` annotations — an annotated destination missing from the
 *     module, a generated resolver whose annotation vanished, or any content
 *     drift is a gating finding. An ejected module (no generated header) is
 *     host-owned and skips the gate.
 *   - CUSTOM (report-only): `AdminDestinations` keys the mounted admin
 *     entries declare via `declare module "@voyant-travel/admin"` versus the
 *     union of generated resolvers and the host map's own keys (the object
 *     literal marked `satisfies AdminDestinationResolvers`, default
 *     `src/lib/admin-destinations.ts`, override with `--destinations`).
 *     Reported in both directions: declared-but-unresolved and
 *     resolver-without-declaration.
 */
export async function adminDoctorCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const configFlag = getStringFlag(args, "config")
  const outFlag = getStringFlag(args, "out")

  const configPath = resolveConfigPath({ path: configFlag, cwd: ctx.cwd })
  if (!configPath) {
    ctx.stderr(
      configFlag
        ? `No voyant config found at ${configFlag}\n`
        : `No voyant.config.* found in ${ctx.cwd} or any parent directory.\n`,
    )
    return 1
  }

  let config: VoyantConfig
  try {
    const loaded = await loadVoyantConfigFile<VoyantConfig>(configPath)
    config = loaded.config
  } catch (err) {
    ctx.stderr(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const configDir = dirname(configPath)
  const results = scanAdminEntries(config.modules ?? [], configDir)
  const found = results.filter((result) => result.status === "found")

  const generatedPath = outFlag
    ? isAbsolute(outFlag)
      ? outFlag
      : resolve(ctx.cwd, outFlag)
    : join(configDir, DEFAULT_GENERATED_RELATIVE_PATH)
  const printableGenerated = relative(ctx.cwd, generatedPath) || generatedPath

  let findings = 0
  const report = (line: string): void => {
    findings++
    ctx.stdout(`[admin-doctor] ${line}\n`)
  }
  // Gating findings (the GENERATED half of Finding D) additionally flip the
  // exit code to 1 — aligned with `voyant admin generate --destinations --check`.
  let gateFindings = 0
  const gate = (line: string): void => {
    gateFindings++
    report(`${line} [gate]`)
  }

  // Finding A: admin entry exists but is not imported in the generated file.
  const generatedSource = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : null
  const importedSpecs = generatedSource === null ? [] : parseImportSpecs(generatedSource)
  if (generatedSource === null && found.length > 0) {
    report(`A: generated file ${printableGenerated} is missing — run \`voyant admin generate\``)
  }
  for (const entry of found) {
    if (generatedSource === null) {
      report(`A: admin entry ${entry.importSpec} (module ${entry.moduleName}) is not composed`)
      continue
    }
    if (entry.importSpec && !importedSpecs.includes(entry.importSpec)) {
      report(
        `A: admin entry ${entry.importSpec} (module ${entry.moduleName}) is not imported in ${printableGenerated}`,
      )
    }
  }

  // Finding B: generated imports whose module left the manifest. Compare
  // against candidate specs for ALL manifest modules (found or not), so a
  // module that merely lost its ui package doesn't masquerade as removed.
  const manifestSpecs = new Set(
    results.map((result) => result.importSpec).filter((spec): spec is string => Boolean(spec)),
  )
  for (const spec of importedSpecs) {
    if (!manifestSpecs.has(spec)) {
      report(
        `B: ${spec} is imported in ${printableGenerated} but its module is not in the manifest`,
      )
    }
  }

  // Finding C: best-effort route parity. A contribution path is bound either
  // by a route file (file-based routing) or by an entry in the host's
  // code-assembled admin route module (RFC §4.8 — fileless routes).
  const routesConfig = resolveAdminRoutesManifestConfig(config)
  const routesDirRel = getStringFlag(args, "routes-dir") ?? routesConfig.dir ?? DEFAULT_ROUTES_DIR
  const routesDir = isAbsolute(routesDirRel) ? routesDirRel : join(configDir, routesDirRel)
  const routesOutFlag = getStringFlag(args, "routes-out")
  const routesModulePath = routesOutFlag
    ? isAbsolute(routesOutFlag)
      ? routesOutFlag
      : resolve(ctx.cwd, routesOutFlag)
    : join(configDir, routesConfig.out ?? DEFAULT_GENERATED_ROUTES_MODULE_RELATIVE_PATH)
  const printableRoutesModule = relative(ctx.cwd, routesModulePath) || routesModulePath
  const routesModuleSource = existsSync(routesModulePath)
    ? readFileSync(routesModulePath, "utf8")
    : null
  const routesModulePaths = new Set(
    routesModuleSource === null ? [] : scanGeneratedModuleRoutePaths(routesModuleSource),
  )

  if (!existsSync(routesDir) && routesModuleSource === null) {
    ctx.stdout(
      `[admin-doctor] C: skipped route parity — no ${routesDirRel} directory and no ` +
        `${printableRoutesModule} in host\n`,
    )
  } else {
    // Manifest entries plus the built-in core entry (when resolvable): its
    // static contribution table — including the settings children and the
    // index redirect — must be bound like any other entry's. Redirect
    // contributions bound in the generated module satisfy their path with no
    // file and no page; runtime-bound children (e.g. settings extraPages)
    // are invisible to the static scan and never reported.
    const coreEntry = resolveCoreAdminEntry(configDir)
    const routeParityEntries: Array<{ importSpec: string; paths: string[] }> = found.map(
      (entry) => ({
        importSpec: entry.importSpec ?? entry.moduleName,
        paths: declaredRoutePaths(entry),
      }),
    )
    if (coreEntry) {
      routeParityEntries.push({
        importSpec: coreEntry.importSpec,
        paths: collectContributionRoutePaths(coreEntry.contributions),
      })
    }
    for (const entry of routeParityEntries) {
      for (const routePath of entry.paths) {
        if (routesModulePaths.has(routePath)) continue
        if (routeFileExists(routesDir, routePath)) continue
        report(
          `C: ${routePath} (extension ${entry.importSpec}) is bound by no route file and ` +
            `no entry in ${printableRoutesModule}`,
        )
      }
    }
  }

  // Finding D: destination parity (RFC §4.7). Shared inputs: the admin entry
  // sources (declared keys + `destination:` annotations).
  const entrySources: Array<{ importSpec: string; source: string }> = []
  for (const entry of found) {
    if (!entry.sourcePath || !entry.importSpec) continue
    try {
      entrySources.push({
        importSpec: entry.importSpec,
        source: readFileSync(entry.sourcePath, "utf8"),
      })
    } catch {
      // Unreadable entries stay best-effort, exactly like Findings A–C.
    }
  }
  const declaredBy = new Map<string, string[]>()
  for (const entry of entrySources) {
    for (const key of scanDeclaredDestinationKeys(entry.source)) {
      const declarers = declaredBy.get(key) ?? []
      declarers.push(entry.importSpec)
      declaredBy.set(key, declarers)
    }
  }
  const { bindings } = collectDestinationBindings(entrySources)

  // D, GENERATED half (gate): the generated resolver module must exactly
  // reflect the annotations. Same comparison `--check` makes, so the two
  // gates can never disagree.
  const destinationsOutFlag = getStringFlag(args, "destinations-out")
  const generatedDestinationsPath = destinationsOutFlag
    ? isAbsolute(destinationsOutFlag)
      ? destinationsOutFlag
      : resolve(ctx.cwd, destinationsOutFlag)
    : join(configDir, DEFAULT_GENERATED_DESTINATIONS_MODULE_RELATIVE_PATH)
  const printableGeneratedDestinations =
    relative(ctx.cwd, generatedDestinationsPath) || generatedDestinationsPath
  const generatedDestinationsSource = existsSync(generatedDestinationsPath)
    ? readFileSync(generatedDestinationsPath, "utf8")
    : null
  // Keys the generated module (or its ejected, host-owned replacement)
  // resolves — they count toward the custom half's resolver union.
  let generatedKeys: string[] = []

  if (
    generatedDestinationsSource !== null &&
    !isGeneratedDestinationsFile(generatedDestinationsSource)
  ) {
    generatedKeys = scanGeneratedDestinationKeys(generatedDestinationsSource) ?? []
    ctx.stdout(
      `[admin-doctor] D: skipped generated-destinations gate — ${printableGeneratedDestinations} ` +
        `has no generated header (ejected, host-owned)\n`,
    )
  } else if (generatedDestinationsSource === null) {
    if (bindings.length > 0) {
      gate(
        `D: ${printableGeneratedDestinations} is missing but ${bindings.length} route ` +
          `contribution(s) declare a destination — run \`voyant admin generate --destinations\``,
      )
    }
  } else {
    generatedKeys = scanGeneratedDestinationKeys(generatedDestinationsSource) ?? []
    const generatedKeySet = new Set(generatedKeys)
    const boundKeys = new Set(bindings.map((binding) => binding.key))
    for (const binding of bindings) {
      if (!generatedKeySet.has(binding.key)) {
        gate(
          `D: annotated destination "${binding.key}" (${binding.importSpec}) has no resolver ` +
            `in ${printableGeneratedDestinations} — run \`voyant admin generate --destinations\``,
        )
      }
    }
    for (const key of generatedKeys) {
      if (!boundKeys.has(key)) {
        gate(
          `D: generated resolver for "${key}" in ${printableGeneratedDestinations} matches no ` +
            `\`destination:\` annotation in any mounted admin entry — run ` +
            `\`voyant admin generate --destinations\``,
        )
      }
    }
    const expected =
      bindings.length === 0
        ? null
        : renderAdminDestinationsModule({
            bindings,
            importSpecs: entrySources.map((entry) => entry.importSpec),
          })
    if (expected === null) {
      gate(
        `D: ${printableGeneratedDestinations} is stale — no route-backed destination ` +
          `annotations remain; run \`voyant admin generate --destinations\``,
      )
    } else if (expected !== generatedDestinationsSource) {
      gate(
        `D: ${printableGeneratedDestinations} is out of date — run ` +
          `\`voyant admin generate --destinations\``,
      )
    }
  }

  // D, CUSTOM half (report-only): declared keys vs the union of generated
  // resolvers and the host map's own (hand-written) keys.
  const destinationsFlag = getStringFlag(args, "destinations")
  const destinationsPath = destinationsFlag
    ? isAbsolute(destinationsFlag)
      ? destinationsFlag
      : resolve(ctx.cwd, destinationsFlag)
    : join(configDir, DEFAULT_DESTINATIONS_RELATIVE_PATH)
  const printableDestinations = relative(ctx.cwd, destinationsPath) || destinationsPath

  if (!existsSync(destinationsPath)) {
    ctx.stdout(
      `[admin-doctor] D: skipped destination parity — no ${printableDestinations} in host\n`,
    )
  } else {
    const resolverKeys = scanResolverMapKeys(readFileSync(destinationsPath, "utf8"))
    if (resolverKeys === null) {
      ctx.stdout(
        `[admin-doctor] D: skipped destination parity — no \`satisfies AdminDestinationResolvers\` map in ${printableDestinations}\n`,
      )
    } else {
      const resolvedKeySet = new Set([...generatedKeys, ...resolverKeys])
      for (const [key, declarers] of declaredBy) {
        if (!resolvedKeySet.has(key)) {
          report(
            `D: destination "${key}" declared by ${declarers.join(", ")} has no resolver in ${printableDestinations}`,
          )
        }
      }
      for (const key of resolverKeys) {
        if (!declaredBy.has(key)) {
          report(
            `D: resolver for "${key}" in ${printableDestinations} matches no declared destination`,
          )
        }
      }
    }
  }

  ctx.stdout(
    `[admin-doctor] done: ${results.length} modules, ${found.length} admin entries, ` +
      `${findings} finding(s)${gateFindings > 0 ? ` — ${gateFindings} gating, exit 1` : ""}\n`,
  )
  return gateFindings > 0 ? 1 : 0
}

/** Extract `from "<spec>"` specifiers from a generated composition file. */
export function parseImportSpecs(source: string): string[] {
  const specs: string[] = []
  const pattern = /\bfrom\s+["']([^"']+)["']/g
  let match: RegExpExecArray | null = pattern.exec(source)
  while (match !== null) {
    if (match[1] !== undefined) specs.push(match[1])
    match = pattern.exec(source)
  }
  return specs
}

/**
 * Statically scan an admin entry's route contributions for declared route
 * paths: the resolved `path:` of every contribution in the entry's
 * `routes: [...]` array, descending into nested `children` (parent-relative
 * paths resolve to absolute ones; index children are skipped — see
 * {@link collectContributionRoutePaths}). Only absolute admin paths count;
 * contributions whose path is not statically resolvable are skipped — this
 * check stays best-effort.
 */
function declaredRoutePaths(entry: AdminEntryScanResult): string[] {
  if (!entry.sourcePath) return []
  let source: string
  try {
    source = readFileSync(entry.sourcePath, "utf8")
  } catch {
    return []
  }
  return collectContributionRoutePaths(scanRouteContributions(source))
}

/**
 * Does a plausible route file exist for `routePath` (e.g. `/promotions`)
 * under the host's `src/routes/_workspace/`? Probes nested
 * (`promotions/index.tsx`, `promotions.tsx`) and flat dotted
 * (`promotions.index.tsx`) file-routing conventions.
 */
function routeFileExists(workspaceRoutesDir: string, routePath: string): boolean {
  const rel = routePath.replace(/^\//, "")
  const dotted = rel.replaceAll("/", ".")
  const candidates = [
    `${rel}.tsx`,
    `${rel}.ts`,
    join(rel, "index.tsx"),
    join(rel, "index.ts"),
    join(rel, "route.tsx"),
    `${dotted}.tsx`,
    `${dotted}.index.tsx`,
  ]
  return candidates.some((candidate) => existsSync(join(workspaceRoutesDir, candidate)))
}
