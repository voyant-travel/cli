import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import type { CommandContext, CommandResult } from "../types.js"
import { adminDoctorCommand } from "./admin-doctor.js"
import { dbDoctorCommand } from "./db-doctor.js"

/**
 * `voyant doctor [--config <path>] [--env-types <env.d.ts>] [--wrangler <file>]
 *   [--strict] [--skip-env] [--skip-db] [--skip-admin]`
 *
 * The single preflight a deployment runs before deploying / after upgrading.
 * Composes three checks and exits non-zero if any gate fails:
 *
 *  1. **env/bindings preflight** (this command) — the genuinely-new check.
 *     Required Cloudflare bindings are the non-optional fields of the
 *     `CloudflareBindings` interface in `env.d.ts`; each must be wired in
 *     `wrangler.jsonc` (KV → `kv_namespaces`, R2 → `r2_buckets`, secret/string
 *     → present in `.dev.vars`/env or `vars`). Placeholder values left in
 *     `wrangler.jsonc` (e.g. `replace-with-...`) fail the gate. Missing secrets
 *     are warnings unless `--strict` (they are often injected at deploy time).
 *  2. **`db doctor`** — schema/migration parity (unless `--skip-db`).
 *  3. **`admin doctor`** — manifest ↔ admin composition parity (unless
 *     `--skip-admin`).
 *
 * Designed to be run from a deployment's root.
 */
export async function doctorCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const strict = getBooleanFlag(args, "strict")
  let failed = false

  if (!getBooleanFlag(args, "skip-env")) {
    const code = runEnvPreflight(ctx, {
      strict,
      envTypesPath: getStringFlag(args, "env-types"),
      wranglerPath: getStringFlag(args, "wrangler"),
    })
    if (code !== 0) failed = true
  }

  if (!getBooleanFlag(args, "skip-db")) {
    ctx.stdout("\n› db doctor\n")
    const code = await dbDoctorCommand(ctx)
    if (code && code !== 0) failed = true
  }

  if (!getBooleanFlag(args, "skip-admin")) {
    ctx.stdout("\n› admin doctor\n")
    const code = await adminDoctorCommand(ctx)
    if (code && code !== 0) failed = true
  }

  ctx.stdout(failed ? "\nvoyant doctor: FAILED\n" : "\nvoyant doctor: OK\n")
  return failed ? 1 : 0
}

interface EnvPreflightOptions {
  strict: boolean
  envTypesPath?: string
  wranglerPath?: string
}

/** Run the env/bindings preflight against a deployment root. Returns exit code. */
export function runEnvPreflight(ctx: CommandContext, opts: EnvPreflightOptions): CommandResult {
  const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(ctx.cwd, p))
  const envTypes = resolvePath(opts.envTypesPath ?? "env.d.ts")
  const wrangler = resolvePath(opts.wranglerPath ?? "wrangler.jsonc")

  if (!existsSync(envTypes) || !existsSync(wrangler)) {
    // Not a Cloudflare-worker deployment root (or paths overridden wrong) —
    // skip silently rather than fail; db/admin doctor still run.
    ctx.stdout("env preflight: skipped (no env.d.ts / wrangler.jsonc at root)\n")
    return 0
  }

  const required = parseRequiredBindings(readFileSync(envTypes, "utf-8"))
  const wInfo = collectWranglerInfo(readFileSync(wrangler, "utf-8"))
  const present = presentSecretKeys(ctx.cwd)

  const errors: string[] = []
  const warnings: string[] = []

  for (const b of required) {
    if (b.category === "kv" && !wInfo.kvBindings.includes(b.name)) {
      errors.push(`required KV binding ${b.name} is not declared in wrangler.jsonc kv_namespaces`)
    } else if (b.category === "r2" && !wInfo.r2Bindings.includes(b.name)) {
      errors.push(`required R2 binding ${b.name} is not declared in wrangler.jsonc r2_buckets`)
    } else if (b.category === "secret" && !present.has(b.name) && !wInfo.vars.includes(b.name)) {
      const msg = `required value ${b.name} is not set (.dev.vars / env / wrangler vars)`
      ;(opts.strict ? errors : warnings).push(msg)
    }
  }
  for (const p of wInfo.placeholders) {
    errors.push(
      `placeholder value left in wrangler.jsonc: ${JSON.stringify(p)} — replace before deploy`,
    )
  }

  for (const w of warnings) ctx.stdout(`env preflight: WARN ${w}\n`)
  if (errors.length) {
    ctx.stderr("env preflight: FAILED\n")
    for (const e of errors) ctx.stderr(`  - ${e}\n`)
    return 1
  }
  ctx.stdout(
    `env preflight: OK (${required.length} required bindings; ${warnings.length} warning${warnings.length === 1 ? "" : "s"})\n`,
  )
  return 0
}

/**
 * Extract the required (non-optional) members of the `CloudflareBindings`
 * interface from an `env.d.ts` source, classified by binding category.
 * Optional members (`name?: T`) and commented lines are ignored.
 */
export function parseRequiredBindings(
  source: string,
): Array<{ name: string; category: "kv" | "r2" | "secret" | "other" }> {
  const start = source.indexOf("interface CloudflareBindings")
  if (start === -1) return []
  const open = source.indexOf("{", start)
  if (open === -1) return []
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}" && --depth === 0) {
      end = i
      break
    }
  }
  const body = source.slice(open + 1, end === -1 ? source.length : end)
  // Drop block comments, then scan line by line dropping line comments.
  const noBlock = body.replace(/\/\*[\s\S]*?\*\//g, "")
  const out: Array<{ name: string; category: "kv" | "r2" | "secret" | "other" }> = []
  for (const raw of noBlock.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim()
    // Required member: `NAME: Type` — exclude optional `NAME?:`.
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_<>[\]| ]+)/)
    const name = m?.[1]
    const type = m?.[2]
    if (!name || !type) continue
    if (raw.includes(`${name}?`)) continue
    const t = type.trim()
    const category = t.includes("KVNamespace")
      ? "kv"
      : t.includes("R2Bucket")
        ? "r2"
        : t === "string"
          ? "secret"
          : "other"
    out.push({ name, category })
  }
  return out
}

/** Parse a wrangler.jsonc: declared KV/R2 binding names, vars keys, and any
 * placeholder string values. */
export function collectWranglerInfo(source: string): {
  kvBindings: string[]
  r2Bindings: string[]
  vars: string[]
  placeholders: string[]
} {
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(stripJsonComments(source))
  } catch {
    return { kvBindings: [], r2Bindings: [], vars: [], placeholders: [] }
  }
  const bindingNames = (arr: unknown): string[] =>
    Array.isArray(arr)
      ? arr.map((e) => (e as { binding?: string })?.binding).filter((b): b is string => Boolean(b))
      : []
  const placeholders: string[] = []
  const PLACEHOLDER = /replace-with|<your-|your-[a-z-]+-id|changeme|^TODO$|xxxxxxxx/i
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (PLACEHOLDER.test(v)) placeholders.push(v)
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x)
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x)
    }
  }
  walk(config)
  return {
    kvBindings: bindingNames(config.kv_namespaces),
    r2Bindings: bindingNames(config.r2_buckets),
    vars: config.vars && typeof config.vars === "object" ? Object.keys(config.vars) : [],
    placeholders: [...new Set(placeholders)],
  }
}

/** Keys present in `.dev.vars` (KEY=value lines) plus process.env. */
function presentSecretKeys(cwd: string): Set<string> {
  const keys = new Set(Object.keys(process.env))
  const devVars = join(cwd, ".dev.vars")
  if (existsSync(devVars)) {
    for (const line of readFileSync(devVars, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
      if (m?.[1]) keys.add(m[1])
    }
  }
  return keys
}

/** Strip `//` and block comments from JSONC, preserving string contents. */
export function stripJsonComments(input: string): string {
  let out = ""
  let inStr = false
  let quote = ""
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    const n = input[i + 1]
    if (inStr) {
      out += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === quote) inStr = false
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      out += c
      continue
    }
    if (c === "/" && n === "/") {
      while (i < input.length && input[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (c === "/" && n === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  return out
}
