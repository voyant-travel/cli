import { spawn } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { generateLinkTableSql, type LinkDefinition } from "@voyant-travel/core/links"

import { parseArgs } from "../lib/args.js"
import { renderLinkDrizzleSchema } from "../lib/link-schema.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * Candidate locations (relative to a template root) where a `links` array
 * may live. Probed in declaration order, first hit wins.
 */
const DEFAULT_LINKS_PATHS = [
  "src/links/index.ts",
  "src/links/index.mts",
  "src/links/index.mjs",
  "src/links/index.js",
  "src/links.ts",
  "src/links.mts",
  "src/links.mjs",
  "src/links.js",
] as const

/**
 * `voyant db sync-links [--links <path>] [--template <path>] [--out <file>]`
 *
 * Loads a template's link definitions and prints the DDL produced by
 * {@link generateLinkTableSql} — one `CREATE TABLE` + N indexes per link.
 *
 * MVP: prints SQL to stdout (or to `--out <file>`). Does not touch the
 * database. Pair with `psql` / `drizzle-kit push` to apply the DDL.
 *
 * The target file must export either a named `links` array or a default-
 * exported array of {@link LinkDefinition} objects.
 *
 * For `.ts` source files, this command spawns a Node subprocess with
 * `--experimental-strip-types --experimental-transform-types` so that
 * NodeNext-style `.js` import specifiers resolve to sibling `.ts` files.
 */
export async function dbSyncLinksCommand(ctx: CommandContext): Promise<CommandResult> {
  const { flags } = parseArgs(ctx.argv)

  const linksPath = resolveLinksPath(ctx.cwd, flags)
  if (!linksPath) {
    ctx.stderr(
      "Could not find a links file. " +
        "Pass --links <path> or --template <path>, or run this from a template directory.\n",
    )
    return 1
  }

  let links: LinkDefinition[]
  try {
    links = await loadLinks(linksPath)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to load links from ${linksPath}: ${reason}\n`)
    return 1
  }

  if (links.length === 0) {
    ctx.stderr(`No link definitions exported from ${linksPath}\n`)
    return 1
  }

  // --emit-drizzle → write a generated Drizzle schema module so link tables are
  // folded into the migration snapshot (Drizzle owns the diff) instead of being
  // applied out-of-band as raw DDL. Add the emitted file to the template's
  // voyant.config `schemas` so it flows into the schema manifest.
  if (flags["emit-drizzle"] === true) {
    const drizzleSchema = renderLinkDrizzleSchema(links)
    // Default output goes into the SELECTED template (so it sits next to the
    // template's voyant.config `schemas` that references it) — not the caller's
    // cwd. An explicit --out is still resolved relative to cwd.
    const templateRoot =
      typeof flags.template === "string"
        ? isAbsolute(flags.template)
          ? flags.template
          : resolve(ctx.cwd, flags.template)
        : ctx.cwd
    const target =
      typeof flags.out === "string"
        ? isAbsolute(flags.out)
          ? flags.out
          : resolve(ctx.cwd, flags.out)
        : resolve(templateRoot, "drizzle.links.generated.ts")
    try {
      writeFileSync(target, drizzleSchema)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.stderr(`Failed to write ${target}: ${reason}\n`)
      return 1
    }
    const materialized = links.filter((l) => !l.readOnly).length
    ctx.stdout(`Wrote ${materialized} link table definition(s) to ${target}\n`)
    return 0
  }

  const sql = renderLinksSql(links, linksPath)

  const outFlag = flags.out
  if (typeof outFlag === "string") {
    const outPath = isAbsolute(outFlag) ? outFlag : resolve(ctx.cwd, outFlag)
    try {
      writeFileSync(outPath, sql)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.stderr(`Failed to write ${outPath}: ${reason}\n`)
      return 1
    }
    ctx.stdout(`Wrote ${links.length} link table(s) to ${outPath}\n`)
    return 0
  }

  ctx.stdout(sql)
  return 0
}

export function resolveLinksPath(
  cwd: string,
  flags: Record<string, string | boolean>,
): string | null {
  // --links <path> takes priority.
  if (typeof flags.links === "string") {
    const abs = isAbsolute(flags.links) ? flags.links : resolve(cwd, flags.links)
    return existsSync(abs) ? abs : null
  }

  // --template <path> locks us to a single template root.
  const templateOverride = typeof flags.template === "string" ? flags.template : null
  const roots = templateOverride
    ? [isAbsolute(templateOverride) ? templateOverride : resolve(cwd, templateOverride)]
    : [cwd]

  for (const root of roots) {
    for (const rel of DEFAULT_LINKS_PATHS) {
      const candidate = join(root, rel)
      if (existsSync(candidate)) return candidate
    }
  }

  return null
}

export async function loadLinks(absPath: string): Promise<LinkDefinition[]> {
  const isTypeScript = /\.(m|c)?ts$/i.test(absPath)
  const raw = isTypeScript
    ? await loadLinksViaSubprocess(absPath)
    : await loadLinksViaImport(absPath)

  if (!Array.isArray(raw)) {
    throw new Error("expected a named export `links` or a default-exported array of LinkDefinition")
  }

  // Shape-check each entry so we fail with a useful message.
  for (const [i, def] of raw.entries()) {
    if (!def || typeof def !== "object") {
      throw new Error(`links[${i}] is not an object`)
    }
    const d = def as Partial<LinkDefinition>
    if (!d.tableName || !d.leftColumn || !d.rightColumn || !d.left || !d.right) {
      throw new Error(
        `links[${i}] is not a LinkDefinition (missing tableName/leftColumn/rightColumn/left/right)`,
      )
    }
  }

  return raw as LinkDefinition[]
}

async function loadLinksViaImport(absPath: string): Promise<unknown> {
  const href = pathToFileURL(absPath).href
  const mod = (await import(href)) as { links?: unknown; default?: unknown }
  return mod.links ?? mod.default
}

/**
 * Node loader hook that rewrites NodeNext-style `.js` specifiers to the
 * matching TypeScript source on disk. This is what TypeScript's
 * `rewriteRelativeImportExtensions` does at compile time; here we do it
 * at resolve time so the template's source tree imports as-is.
 *
 * Emitted as a data: URL so we can ship it without touching the
 * filesystem.
 */
const LOADER_HOOK_SRC = `
import { existsSync, statSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
function tryResolveTs(specifier, parentDir) {
  // Rewrite NodeNext-style .js -> .ts / .mjs -> .mts / .cjs -> .cts.
  if (specifier.endsWith(".js") || specifier.endsWith(".mjs") || specifier.endsWith(".cjs")) {
    const ext = specifier.endsWith(".mjs") ? ".mjs" : specifier.endsWith(".cjs") ? ".cjs" : ".js"
    const tsExt = ext === ".mjs" ? ".mts" : ext === ".cjs" ? ".cts" : ".ts"
    const candidate = parentDir + "/" + specifier.slice(0, -ext.length) + tsExt
    if (existsSync(candidate)) return candidate
    return null
  }
  // Bundler-style extensionless imports: try .ts / .mts / /index.ts.
  const base = parentDir + "/" + specifier
  for (const ext of [".ts", ".mts", ".tsx"]) {
    if (existsSync(base + ext)) return base + ext
  }
  try {
    if (statSync(base).isDirectory()) {
      for (const idx of ["/index.ts", "/index.mts", "/index.tsx"]) {
        if (existsSync(base + idx)) return base + idx
      }
    }
  } catch {}
  return null
}
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const parentPath = fileURLToPath(context.parentURL)
    const lastSlash = parentPath.lastIndexOf("/")
    const parentDir = lastSlash >= 0 ? parentPath.slice(0, lastSlash) : parentPath
    const found = tryResolveTs(specifier, parentDir)
    if (found) return nextResolve(pathToFileURL(found).href, context)
  }
  return nextResolve(specifier, context)
}
`

const REGISTER_HOOK_SRC =
  `import { register } from "node:module";` +
  `register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(LOADER_HOOK_SRC)}`)},` +
  ` import.meta.url);`

/**
 * Spawn a Node subprocess that imports the TypeScript file with
 * transform-types + a resolver hook that rewrites `.js` specifiers to
 * their `.ts` siblings. Prints the link array as JSON.
 *
 * LinkDefinitions are plain data (no functions), so JSON round-tripping
 * preserves their shape.
 */
async function loadLinksViaSubprocess(absPath: string): Promise<unknown> {
  const href = pathToFileURL(absPath).href
  // Marker prefix so we can skip over any logs / warnings emitted on
  // stdout before the JSON payload.
  const marker = "__VOYANT_LINKS_JSON__:"
  const script =
    `import(${JSON.stringify(href)}).then((m)=>{` +
    `const v=m.links??m.default;` +
    `process.stdout.write(${JSON.stringify(marker)}+JSON.stringify(v??null));` +
    `}).catch((e)=>{` +
    `process.stderr.write(e?.stack??String(e));` +
    `process.exit(1);` +
    `});`

  const importHookUrl = `data:text/javascript,${encodeURIComponent(REGISTER_HOOK_SRC)}`

  const args = [
    "--experimental-strip-types",
    "--experimental-transform-types",
    "--no-warnings",
    `--import=${importHookUrl}`,
    "--input-type=module",
    "-e",
    script,
  ]

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => {
      stdout += d.toString()
    })
    child.stderr.on("data", (d) => {
      stderr += d.toString()
    })
    child.on("error", (err) => rejectPromise(err))
    child.on("exit", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || `subprocess exited with code ${code}`))
        return
      }
      const idx = stdout.indexOf(marker)
      if (idx < 0) {
        rejectPromise(new Error("subprocess returned no link payload"))
        return
      }
      const payload = stdout.slice(idx + marker.length).trim()
      try {
        resolvePromise(JSON.parse(payload))
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        rejectPromise(new Error(`could not parse link payload: ${reason}`))
      }
    })
  })
}

function renderLinksSql(links: LinkDefinition[], sourcePath: string): string {
  const lines: string[] = []
  lines.push("-- Voyant link tables — generated by `voyant db sync-links`")
  lines.push(`-- Source: ${sourcePath}`)
  lines.push(`-- ${links.length} link${links.length === 1 ? "" : "s"}`)
  lines.push("")

  for (const link of links) {
    const sql = generateLinkTableSql(link)
    const leftRef = `${link.left.linkable.module}.${link.left.linkable.entity}`
    const rightRef = `${link.right.linkable.module}.${link.right.linkable.entity}`
    lines.push(`-- ${leftRef} <-> ${rightRef} (${link.cardinality})`)
    lines.push(`${sql.createTable};`)
    for (const idx of sql.indexes) {
      lines.push(`${idx};`)
    }
    lines.push("")
  }

  return `${lines.join("\n")}\n`
}
