import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path"

import { resolveEntry } from "@voyant-travel/core/config"

import { parseArgs } from "../lib/args.js"
import { resolvePackageJson } from "../lib/resolve-schemas.js"
import {
  readSchemaManifest,
  renderSchemaManifest,
  resolveSchemaManifest,
} from "../lib/schema-manifest.js"
import { loadVoyantConfig, type SchemaManifestConfig } from "../lib/voyant-config.js"
import type { CommandContext, CommandResult } from "../types.js"
import { loadLinks, resolveLinksPath } from "./db-sync-links.js"

const DRIZZLE_CONFIG_NAMES = [
  "drizzle.config.ts",
  "drizzle.config.js",
  "drizzle.config.mjs",
] as const

interface DoctorIssue {
  message: string
  details?: string[]
}

/**
 * `voyant db doctor [--template <path>] [--config <path>] [--fail-on-drift]`
 *
 * Cross-checks the manifest (`voyant.config.ts`) against the migration setup
 * and reports drift. It is a **report by default** (exit 0) so it can run
 * informationally while existing drift is paid down; pass `--fail-on-drift`
 * to gate CI once the report is clean.
 *
 * Checks:
 *  1. every manifest entry (modules + extensions + additionalSchemas) resolves
 *     to an installed package (catches typos / missing deps)
 *  2. manifest-derived schemas vs `drizzle.config` `schema` entries (missing/extra)
 *  3. the committed `drizzle.schemas.generated.ts` exists and is up to date
 *  4. no duplicate migration sequence prefixes in the `out` directory
 *  5. every materialized link table is present in the latest Drizzle snapshot
 *
 * `drizzle.config.ts` is parsed statically (its `schema`/`out` literals are
 * extracted from source) so the check needs no database, dotenv, or TS loader.
 */
export async function dbDoctorCommand(ctx: CommandContext): Promise<CommandResult> {
  const { flags } = parseArgs(ctx.argv)
  const templateDir = resolveTemplateDir(ctx.cwd, flags.template)
  if (!templateDir) {
    ctx.stderr(
      "Could not find a template with drizzle.config.{ts,js,mjs}. " +
        "Run from a template directory or pass --template <path>.\n",
    )
    return 1
  }

  const drizzleConfigPath = findDrizzleConfigPath(templateDir) as string
  const configPath = typeof flags.config === "string" ? flags.config : null
  const config = await loadVoyantConfig(templateDir, configPath)
  if (!config) {
    ctx.stderr(
      "Could not locate a voyant.config.ts. Run from a directory containing one, " +
        "pass --template <path>, or pass --config <path>.\n",
    )
    return 1
  }

  const parsed = parseDrizzleConfig(readFileSync(drizzleConfigPath, "utf8"))
  const issues: DoctorIssue[] = []
  const notes: string[] = []

  checkManifestResolvable(config, templateDir, issues, notes)
  checkSchemaParity(config, templateDir, parsed, issues, notes)
  checkGeneratedManifest(config, templateDir, issues, notes)
  checkDuplicatePrefixes(templateDir, parsed.out, issues, notes)
  await checkLinkSnapshot(templateDir, parsed.out, issues, notes)

  const failOnDrift = flags["fail-on-drift"] === true
  printReport(ctx, { templateDir, drizzleConfigPath, issues, notes, failOnDrift })
  return failOnDrift && issues.length > 0 ? 1 : 0
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkManifestResolvable(
  config: SchemaManifestConfig,
  templateDir: string,
  issues: DoctorIssue[],
  notes: string[],
): void {
  const buckets: Array<[string, SchemaManifestConfig["modules"]]> = [
    ["modules", config.modules],
    ["extensions", config.extensions],
    ["additionalSchemas", config.additionalSchemas],
  ]
  const entries = buckets.flatMap(([bucket, list]) =>
    (list ?? []).map((entry) => ({ bucket, name: resolveEntry(entry).resolve })),
  )
  const unresolved = entries.filter(({ name }) => resolvePackageJson(name, templateDir) === null)

  if (unresolved.length > 0) {
    issues.push({
      message:
        "Manifest entries do not resolve to an installed package (typo, or missing dependency):",
      details: unresolved.map(({ name, bucket }) => `${name} (${bucket})`),
    })
    return
  }
  notes.push(`Manifest: all ${entries.length} module/extension/additionalSchema entr(ies) resolve.`)
}

function checkSchemaParity(
  config: SchemaManifestConfig,
  templateDir: string,
  parsed: ParsedDrizzleConfig,
  issues: DoctorIssue[],
  notes: string[],
): void {
  let expected: string[]
  try {
    expected = resolveSchemaManifest(config, { cwd: templateDir, style: "file" }).map(canon)
  } catch (err) {
    issues.push({ message: `Failed to resolve manifest schemas: ${reason(err)}` })
    return
  }

  if (parsed.schemaEntries === null) {
    // Derived schema (e.g. `import { schema }` or `resolveSchemas(config)`).
    // We can't compare literal entries, so the generated-manifest freshness
    // check carries correctness — but ONLY if drizzle.config actually consumes
    // a source that includes the template-local `schemas` (the generated
    // manifest or `resolveSchemaManifest`). A bare `resolveSchemas(config)`
    // omits local `schemas`, which would then silently miss migrations.
    const localSchemas = config.schemas ?? []
    if (parsed.derivedIncludesLocalSchemas) {
      notes.push(
        "Schemas: drizzle.config derives its schema from the manifest " +
          "(packages + template-local schemas covered).",
      )
    } else if (localSchemas.length > 0) {
      issues.push({
        message:
          "drizzle.config derives its schema without the generated manifest / " +
          "resolveSchemaManifest, so template-local schemas are likely OMITTED from migrations:",
        details: localSchemas.map(String),
      })
    } else {
      notes.push(
        "Schemas: drizzle.config `schema` is derived; no template-local schemas to verify.",
      )
    }
    return
  }

  const actual = parsed.schemaEntries.map((entry) => canon(resolveEntryPath(entry, templateDir)))
  const missing = expected.filter((e) => !actual.includes(e))
  const extra = actual.filter((e) => !expected.includes(e))

  if (missing.length === 0 && extra.length === 0) {
    notes.push(`Schemas: ${expected.length} manifest-derived schema(s) match drizzle.config.`)
    return
  }
  if (missing.length > 0) {
    issues.push({
      message: "Manifest-derived schemas are MISSING from drizzle.config (would not migrate):",
      details: missing.map((p) => rel(templateDir, p)),
    })
  }
  if (extra.length > 0) {
    issues.push({
      message: "drizzle.config has schema entries NOT derived from voyant.config:",
      details: extra.map((p) => rel(templateDir, p)),
    })
  }
}

function checkGeneratedManifest(
  config: SchemaManifestConfig,
  templateDir: string,
  issues: DoctorIssue[],
  notes: string[],
): void {
  let generated: ReturnType<typeof renderSchemaManifest>
  try {
    generated = renderSchemaManifest(config, { cwd: templateDir })
  } catch (err) {
    issues.push({ message: `Failed to render generated schema manifest: ${reason(err)}` })
    return
  }
  const current = readSchemaManifest(generated.path)
  const path = rel(templateDir, generated.path)

  if (current === null) {
    notes.push(
      `Generated manifest: ${path} not present yet (pre-adoption). ` +
        "Run `voyant db schemas --emit` to create it.",
    )
    return
  }
  if (current !== generated.content) {
    issues.push({
      message: `Generated manifest is STALE: ${path}.`,
      details: ["Run `voyant db schemas --emit` (or `voyant db generate`) to refresh."],
    })
    return
  }
  notes.push(`Generated manifest: ${path} is up to date.`)
}

function checkDuplicatePrefixes(
  templateDir: string,
  outRel: string,
  issues: DoctorIssue[],
  notes: string[],
): void {
  const outDir = resolvePath(templateDir, outRel)
  if (!existsSync(outDir)) {
    notes.push(`Migrations: ${rel(templateDir, outDir)} not found — skipping prefix check.`)
    return
  }
  const byPrefix = new Map<string, string[]>()
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue
    const match = /^(\d+)_/.exec(entry.name)
    if (!match) continue
    const prefix = match[1] as string
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), entry.name])
  }
  const dupes = [...byPrefix.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([prefix, files]) => ({ prefix, files: [...files].sort() }))
  if (dupes.length === 0) {
    notes.push("Migrations: no duplicate sequence prefixes.")
    return
  }

  // Grandfather pre-existing duplicates via a committed baseline so the gate
  // fails only on NEW collisions. A baselined entry must match the exact file
  // set, so adding another file to an existing duplicate prefix still trips.
  const baseline = loadDuplicatePrefixBaseline(outDir)
  const baselined = dupes.filter((d) => baseline.get(d.prefix) === d.files.join("|"))
  const unbaselined = dupes.filter((d) => baseline.get(d.prefix) !== d.files.join("|"))

  if (baselined.length > 0) {
    notes.push(
      `Migrations: ${baselined.length} pre-existing duplicate prefix(es) grandfathered by ` +
        `${DUPLICATE_PREFIX_BASELINE_NAME}.`,
    )
  }
  for (const { prefix, files } of unbaselined) {
    issues.push({
      message: `Duplicate migration prefix "${prefix}" — order is non-deterministic (not baselined):`,
      details: files,
    })
  }
}

const DUPLICATE_PREFIX_BASELINE_NAME = "duplicate-prefixes.baseline.json"

/** Load the duplicate-prefix baseline as prefix → sorted-files key. */
function loadDuplicatePrefixBaseline(outDir: string): Map<string, string> {
  const path = join(outDir, DUPLICATE_PREFIX_BASELINE_NAME)
  if (!existsSync(path)) return new Map()
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      duplicates?: Array<{ prefix?: string; files?: string[] }>
    }
    const map = new Map<string, string>()
    for (const entry of parsed.duplicates ?? []) {
      if (typeof entry.prefix === "string" && Array.isArray(entry.files)) {
        map.set(entry.prefix, [...entry.files].sort().join("|"))
      }
    }
    return map
  } catch {
    return new Map()
  }
}

async function checkLinkSnapshot(
  templateDir: string,
  outRel: string,
  issues: DoctorIssue[],
  notes: string[],
): Promise<void> {
  const linksPath = resolveLinksPath(templateDir, {})
  if (!linksPath) {
    notes.push("Links: no link definitions found.")
    return
  }

  let links: Awaited<ReturnType<typeof loadLinks>>
  try {
    links = await loadLinks(linksPath)
  } catch (err) {
    issues.push({ message: `Could not load link definitions: ${reason(err)}` })
    return
  }

  const materialized = links.filter((l) => !l.readOnly).map((l) => l.tableName)
  if (materialized.length === 0) {
    notes.push("Links: no materialized link tables to verify.")
    return
  }

  const snapshotTables = loadLatestSnapshotTables(resolvePath(templateDir, outRel))
  if (!snapshotTables) {
    issues.push({
      message: `Links: ${materialized.length} link table(s) declared, but no Drizzle snapshot found to verify them against.`,
    })
    return
  }
  const missing = materialized.filter((t) => !snapshotTables.has(t))
  if (missing.length > 0) {
    issues.push({
      message:
        "Link tables are MISSING from the latest Drizzle snapshot (run via sync-links, not migrated):",
      details: missing.sort(),
    })
    return
  }
  notes.push(`Links: all ${materialized.length} link table(s) present in the latest snapshot.`)
}

// ---------------------------------------------------------------------------
// drizzle.config static parsing
// ---------------------------------------------------------------------------

interface ParsedDrizzleConfig {
  /** String-literal schema entries, or `null` when `schema` is derived (a call/identifier). */
  schemaEntries: string[] | null
  /** The `out` directory (relative to the template), defaulting to "./drizzle". */
  out: string
  /**
   * For the derived case: whether the config consumes a source that includes
   * template-local `schemas` — the generated manifest (`drizzle.schemas.generated`)
   * or `resolveSchemaManifest`. A bare `resolveSchemas(config)` does NOT, so
   * local schemas would be dropped.
   */
  derivedIncludesLocalSchemas: boolean
}

export function parseDrizzleConfig(source: string): ParsedDrizzleConfig {
  const text = stripComments(source)
  return {
    schemaEntries: extractSchemaEntries(text),
    out: extractOut(text),
    derivedIncludesLocalSchemas:
      /drizzle\.schemas\.generated/.test(text) || /\bresolveSchemaManifest\b/.test(text),
  }
}

function extractSchemaEntries(text: string): string[] | null {
  const key = /\bschema\s*:\s*/.exec(text)
  if (!key) return null
  const start = key.index + key[0].length
  if (text[start] !== "[") return null // derived (resolveSchemas(...), an identifier, etc.)

  // Scan to the matching close bracket.
  let depth = 0
  let end = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === "[") depth++
    else if (ch === "]") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null

  const inner = text.slice(start + 1, end)
  const strings: string[] = []
  const stringRe = /(["'`])((?:\\.|(?!\1).)*)\1/g
  for (const m of inner.matchAll(stringRe)) strings.push(m[2] as string)

  // If, after removing the string literals, anything non-trivial remains
  // (identifiers, spreads, calls), treat the list as not purely static.
  const residue = inner.replace(stringRe, "").replace(/[\s,]/g, "")
  if (residue.length > 0) return null

  return strings
}

function extractOut(text: string): string {
  const m = /\bout\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(text)
  return m ? (m[2] as string) : "./drizzle"
}

function stripComments(source: string): string {
  // Remove block and line comments so they don't confuse the extractors.
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTemplateDir(cwd: string, override: string | boolean | undefined): string | null {
  const roots =
    typeof override === "string"
      ? [isAbsolute(override) ? override : resolvePath(cwd, override)]
      : [cwd]
  for (const root of roots) {
    if (findDrizzleConfigPath(root)) return root
  }
  return null
}

function findDrizzleConfigPath(dir: string): string | null {
  for (const name of DRIZZLE_CONFIG_NAMES) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Resolve a drizzle `schema` entry (relative path, absolute, or specifier) to an absolute path. */
function resolveEntryPath(entry: string, templateDir: string): string {
  if (isAbsolute(entry)) return entry
  if (entry.startsWith(".")) return resolvePath(templateDir, entry)
  try {
    const require = createRequire(join(templateDir, "package.json"))
    return require.resolve(entry)
  } catch {
    return resolvePath(templateDir, entry)
  }
}

function loadLatestSnapshotTables(outDir: string): Set<string> | null {
  const metaDir = join(outDir, "meta")
  if (!existsSync(metaDir)) return null
  const snapshots = readdirSync(metaDir)
    .filter((n) => /^\d+_snapshot\.json$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const latest = snapshots.at(-1)
  if (!latest) return null
  try {
    const parsed = JSON.parse(readFileSync(join(metaDir, latest), "utf8")) as {
      tables?: Record<string, unknown>
    }
    const keys = Object.keys(parsed.tables ?? {})
    return new Set(keys.map((k) => k.slice(k.lastIndexOf(".") + 1)))
  } catch {
    return null
  }
}

function canon(p: string): string {
  const abs = resolvePath(p)
  try {
    return realpathSync(abs).replaceAll("\\", "/")
  } catch {
    return abs.replaceAll("\\", "/")
  }
}

function rel(baseDir: string, p: string): string {
  const r = relative(baseDir, p).replaceAll("\\", "/")
  return r && !r.startsWith("..") ? r : p
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function printReport(
  ctx: CommandContext,
  args: {
    templateDir: string
    drizzleConfigPath: string
    issues: DoctorIssue[]
    notes: string[]
    failOnDrift: boolean
  },
): void {
  ctx.stdout("voyant db doctor\n")
  ctx.stdout(`  template: ${args.templateDir}\n`)
  ctx.stdout(`  drizzle:  ${rel(args.templateDir, args.drizzleConfigPath)}\n\n`)

  for (const note of args.notes) ctx.stdout(`  OK    ${note}\n`)
  for (const issue of args.issues) {
    ctx.stdout(`  WARN  ${issue.message}\n`)
    for (const detail of issue.details ?? []) ctx.stdout(`          - ${detail}\n`)
  }

  if (args.issues.length === 0) {
    ctx.stdout("\nNo drift detected.\n")
    return
  }
  ctx.stdout(
    `\n${args.issues.length} issue(s) reported. ` +
      (args.failOnDrift
        ? "Exiting non-zero (--fail-on-drift).\n"
        : "Report mode exits 0; pass --fail-on-drift to gate CI.\n"),
  )
}
