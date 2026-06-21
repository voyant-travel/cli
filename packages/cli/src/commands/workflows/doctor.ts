import { spawn } from "node:child_process"
import type { Dirent } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, relative, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import { getBooleanFlag, getStringFlag, type ParsedArgs } from "../../lib/args.js"

// Workflows are Node-only (docs/architecture/workflows-runtime-architecture.md):
//   - `docker` inspects the staged Node self-host server bundle/env.
//   - `entry`  inspects a workflow entry file BEFORE building — catching local
//              workflows that are declared but never imported (so never
//              registered) and ids that collide with already-registered
//              (usually upstream-owned) workflows.
// The Cloudflare Worker/Durable Object workflow adapter has been removed.
export type DoctorTarget = "docker" | "entry"

export interface DoctorCheck {
  id: string
  ok: boolean
  message: string
}

export interface DoctorOutcome {
  target: DoctorTarget
  ok: boolean
  checks: DoctorCheck[]
}

/** A `workflow({ id })` declaration found by scanning local source files. */
export interface DeclaredWorkflow {
  id: string
  file: string
}

export interface DoctorDeps {
  readFile: (path: string) => Promise<string>
  stat: (
    path: string,
  ) => Promise<
    | { isFile(): boolean }
    | { isDirectory(): boolean }
    | { isFile(): boolean; isDirectory(): boolean }
  >
  importModule: (url: string) => Promise<unknown>
  runCommand: (args: {
    command: readonly string[]
    cwd?: string
    env?: Record<string, string | undefined>
  }) => Promise<{ ok: true } | { ok: false; message: string; exitCode: number }>
  // --- entry-target deps (the default binding supplies all four) ---
  /** Drop the process-local workflow registry before loading the entry. */
  resetRegistry?: () => void
  /** Import the entry file, returning any `console.warn` lines it emitted. */
  loadWorkflowEntry?: (path: string) => Promise<{ warnings: string[] }>
  /** Enumerate workflows registered after the entry was loaded. */
  getRegisteredWorkflows?: () => Iterable<{ id: string }>
  /** Scan local source near the entry for `workflow({ id })` declarations. */
  scanDeclaredWorkflowIds?: (entryFile: string) => Promise<DeclaredWorkflow[]>
}

const DOCKER_BUNDLE_PATH = "apps/selfhost-node-server/dist/bundle.mjs"
const DOCKER_ENV_PATH = "apps/selfhost-node-server/dist/selfhost.env"
const DOCKER_COMPOSE_PATH = "apps/selfhost-node-server/docker-compose.yml"
const DOCKERFILE_PATH = "apps/selfhost-node-server/Dockerfile"
const DOCKER_ENTRYPOINT_PATH = "apps/selfhost-node-server/scripts/docker-entrypoint.sh"

export async function runWorkflowsDoctor(
  args: ParsedArgs,
  deps: DoctorDeps,
): Promise<{ ok: true; result: DoctorOutcome } | { ok: false; message: string; exitCode: number }> {
  const target = getDoctorTarget(args)
  if (!target) {
    return {
      ok: false,
      message: "voyant workflows doctor: missing required --target <docker|entry>",
      exitCode: 2,
    }
  }

  if (target === "entry") {
    return runEntryDoctor(args, deps)
  }

  return {
    ok: true,
    result: await runDockerDoctor(args, deps),
  }
}

async function runDockerDoctor(args: ParsedArgs, deps: DoctorDeps): Promise<DoctorOutcome> {
  const bundlePath = resolvePath(getStringFlag(args, "bundle") ?? DOCKER_BUNDLE_PATH)
  const envPath = resolvePath(getStringFlag(args, "env-file") ?? DOCKER_ENV_PATH)
  const composePath = resolvePath(DOCKER_COMPOSE_PATH)
  const dockerfilePath = resolvePath(DOCKERFILE_PATH)
  const entrypointPath = resolvePath(DOCKER_ENTRYPOINT_PATH)
  const checks: DoctorCheck[] = []

  checks.push(await checkFile(deps, bundlePath, "docker.bundle", "staged workflow bundle"))
  checks.push(await checkFile(deps, envPath, "docker.env", "generated compose env file"))
  checks.push(await checkFile(deps, composePath, "docker.compose", "docker compose file"))
  checks.push(await checkFile(deps, dockerfilePath, "docker.dockerfile", "Dockerfile"))
  checks.push(
    await checkFile(deps, entrypointPath, "docker.entrypoint", "docker entrypoint script"),
  )

  const envCheck = await checkDockerEnvFile(deps, envPath)
  checks.push(...envCheck.checks)

  const importCheck = await checkBundleImport(deps, bundlePath)
  checks.push(importCheck)

  if (getBooleanFlag(args, "check-docker")) {
    checks.push(await checkDockerComposeConfig(deps, envPath))
  }

  return {
    target: "docker",
    ok: checks.every((check) => check.ok),
    checks,
  }
}

/**
 * Inspect a workflow entry file before it is built. Catches the two failure
 * modes from voyant-travel/voyant#1989: local workflows that typecheck but are
 * never imported (so never registered with the app composition), and workflow
 * ids that collide with already-registered — usually upstream-owned — ids.
 */
async function runEntryDoctor(
  args: ParsedArgs,
  deps: DoctorDeps,
): Promise<{ ok: true; result: DoctorOutcome } | { ok: false; message: string; exitCode: number }> {
  const file = getStringFlag(args, "file", "entry")
  if (!file) {
    return {
      ok: false,
      message: "voyant workflows doctor --target entry: missing required --file <path>",
      exitCode: 2,
    }
  }
  if (!deps.loadWorkflowEntry || !deps.getRegisteredWorkflows || !deps.resetRegistry) {
    return {
      ok: false,
      message: "voyant workflows doctor --target entry: registry deps unavailable",
      exitCode: 1,
    }
  }

  const entryPath = resolvePath(file)
  deps.resetRegistry()

  let warnings: string[]
  try {
    ;({ warnings } = await deps.loadWorkflowEntry(entryPath))
  } catch (err) {
    return {
      ok: true,
      result: {
        target: "entry",
        ok: false,
        checks: [
          {
            id: "entry.load",
            ok: false,
            message: `entry file failed to import: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      },
    }
  }

  const registered = [...deps.getRegisteredWorkflows()]
  const registeredIds = new Set(registered.map((w) => w.id))
  const checks: DoctorCheck[] = []

  checks.push({ id: "entry.load", ok: true, message: `imported ${entryPath}` })

  checks.push(
    registered.length > 0
      ? {
          id: "entry.registered",
          ok: true,
          message: `${registered.length} workflow${registered.length === 1 ? "" : "s"} registered from the entry`,
        }
      : {
          id: "entry.registered",
          ok: false,
          message:
            "entry file registered no workflows — does it import your workflow modules so their `workflow({...})` declarations run?",
        },
  )

  checks.push(checkDuplicateWorkflowIds(warnings))
  checks.push(await checkUnregisteredWorkflows(deps, entryPath, registeredIds))

  return {
    ok: true,
    result: {
      target: "entry",
      ok: checks.every((check) => check.ok),
      checks,
    },
  }
}

const DUPLICATE_ID_RE = /workflow id "([^"]+)" re-registered/g

/**
 * The registry replaces + `console.warn`s on a duplicate id rather than
 * throwing (so dev HMR keeps working); a one-shot CLI import never re-imports,
 * so any such warning is a genuine collision — usually a local workflow reusing
 * an upstream-owned id.
 */
function checkDuplicateWorkflowIds(warnings: readonly string[]): DoctorCheck {
  const ids = new Set<string>()
  for (const line of warnings) {
    for (const match of line.matchAll(DUPLICATE_ID_RE)) {
      const id = match[1]
      if (id) ids.add(id)
    }
  }
  if (ids.size === 0) {
    return { id: "entry.duplicate-ids", ok: true, message: "no duplicate workflow ids" }
  }
  return {
    id: "entry.duplicate-ids",
    ok: false,
    message: `duplicate workflow id${ids.size === 1 ? "" : "s"} (collides with an already-registered, likely upstream-owned, workflow): ${[...ids].join(", ")}`,
  }
}

/**
 * Compare `workflow({ id })` declarations found in local source against the
 * registry the entry produced. An id present in source but absent from the
 * registry means that file is never reached from the entry.
 */
async function checkUnregisteredWorkflows(
  deps: DoctorDeps,
  entryPath: string,
  registeredIds: ReadonlySet<string>,
): Promise<DoctorCheck> {
  if (!deps.scanDeclaredWorkflowIds) {
    return {
      id: "entry.unregistered",
      ok: true,
      message: "source scan unavailable — skipped",
    }
  }
  let declared: DeclaredWorkflow[]
  try {
    declared = await deps.scanDeclaredWorkflowIds(entryPath)
  } catch (err) {
    return {
      id: "entry.unregistered",
      ok: false,
      message: `failed to scan local workflow source: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const missing = declared.filter((d) => !registeredIds.has(d.id))
  if (missing.length === 0) {
    return {
      id: "entry.unregistered",
      ok: true,
      message: "every locally-declared workflow is registered from the entry",
    }
  }
  const detail = missing.map((d) => `${d.id} (${d.file})`).join(", ")
  return {
    id: "entry.unregistered",
    ok: false,
    message: `workflow${missing.length === 1 ? "" : "s"} declared in local source but not registered from the entry — import the file(s) from your entry: ${detail}`,
  }
}

function getDoctorTarget(args: ParsedArgs): DoctorTarget | undefined {
  const raw = getStringFlag(args, "target")
  if (raw === "docker" || raw === "entry") return raw
  return undefined
}

async function checkFile(
  deps: DoctorDeps,
  path: string,
  id: string,
  label: string,
): Promise<DoctorCheck> {
  try {
    const info = await deps.stat(path)
    const isFile = "isFile" in info && typeof info.isFile === "function" ? info.isFile() : false
    if (!isFile) {
      return {
        id,
        ok: false,
        message: `${label} is not a file: ${path}`,
      }
    }
    return {
      id,
      ok: true,
      message: `${label} present at ${path}`,
    }
  } catch (err) {
    return {
      id,
      ok: false,
      message: `${label} missing at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function checkDockerEnvFile(
  deps: DoctorDeps,
  envPath: string,
): Promise<{ checks: DoctorCheck[] }> {
  try {
    const content = await deps.readFile(envPath)
    const vars = parseEnvFile(content)
    const checks: DoctorCheck[] = []
    checks.push(requiredEnvCheck(vars, "VOYANT_HOST_PORT"))
    checks.push(requiredEnvCheck(vars, "VOYANT_BIND_HOST"))
    checks.push(requiredEnvCheck(vars, "VOYANT_BIND_PORT"))
    checks.push(requiredEnvCheck(vars, "VOYANT_ENTRY_FILE", "/app/workflows/bundle.mjs"))
    checks.push(requiredEnvCheck(vars, "VOYANT_DATABASE_URL"))
    checks.push(requiredEnvCheck(vars, "VOYANT_SKIP_MIGRATIONS"))
    checks.push(requiredEnvCheck(vars, "VOYANT_DATABASE_WAIT_SECONDS"))
    return { checks }
  } catch (err) {
    return {
      checks: [
        {
          id: "docker.env.values",
          ok: false,
          message: `failed to read generated compose env file: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    }
  }
}

function requiredEnvCheck(
  vars: Record<string, string>,
  key: string,
  expectedValue?: string,
): DoctorCheck {
  const value = vars[key]
  if (!value) {
    return {
      id: `docker.env.${key}`,
      ok: false,
      message: `generated compose env file is missing ${key}`,
    }
  }
  if (expectedValue !== undefined && value !== expectedValue) {
    return {
      id: `docker.env.${key}`,
      ok: false,
      message: `${key} must be ${expectedValue} (got ${value})`,
    }
  }
  return {
    id: `docker.env.${key}`,
    ok: true,
    message: `${key}=${value}`,
  }
}

async function checkBundleImport(
  deps: DoctorDeps,
  bundlePath: string,
  id = "docker.bundle.import",
): Promise<DoctorCheck> {
  try {
    await deps.importModule(bundlePath)
    return {
      id,
      ok: true,
      message: `staged bundle imports successfully: ${bundlePath}`,
    }
  } catch (err) {
    return {
      id,
      ok: false,
      message: `staged bundle failed to import: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function checkDockerComposeConfig(deps: DoctorDeps, envPath: string): Promise<DoctorCheck> {
  const result = await deps.runCommand({
    command: ["docker", "compose", "--env-file", envPath, "-f", DOCKER_COMPOSE_PATH, "config"],
  })
  if (!result.ok) {
    return {
      id: "docker.compose.config",
      ok: false,
      message: `docker compose config failed: ${result.message}`,
    }
  }
  return {
    id: "docker.compose.config",
    ok: true,
    message: "docker compose config rendered successfully",
  }
}

function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx <= 0) continue
    vars[trimmed.slice(0, idx)] = trimmed.slice(idx + 1)
  }
  return vars
}

export async function defaultDoctorDeps(): Promise<DoctorDeps> {
  const [entryMod, wfMod] = await Promise.all([
    import("../../lib/load-entry.js"),
    import("@voyant-travel/workflows") as Promise<{
      __listRegisteredWorkflows: () => { id: string }[]
      __resetRegistry: () => void
    }>,
  ])
  return {
    readFile: async (path) => readFile(path, "utf8"),
    stat: async (path) => stat(path),
    importModule: async (path) => {
      const url = pathToFileURL(path)
      url.searchParams.set("t", String(Date.now()))
      await import(url.href)
    },
    runCommand: ({ command, cwd, env }) => runCommand(command, { cwd, env }),
    resetRegistry: () => wfMod.__resetRegistry(),
    getRegisteredWorkflows: () => wfMod.__listRegisteredWorkflows(),
    loadWorkflowEntry: async (path) => {
      const warnings: string[] = []
      const original = console.warn
      console.warn = (...parts: unknown[]) => {
        warnings.push(parts.map((p) => (typeof p === "string" ? p : String(p))).join(" "))
      }
      try {
        await entryMod.loadEntryFile(path)
      } finally {
        console.warn = original
      }
      return { warnings }
    },
    scanDeclaredWorkflowIds: (entryFile) => scanDeclaredWorkflowIds(entryFile),
  }
}

const SCAN_IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  ".voyant",
  ".turbo",
  ".wrangler",
  ".git",
  "coverage",
])
// `workflow({ ... id: "x" ... })` — word-boundary guard avoids `registerWorkflow(`;
// the bounded window keeps the lazy match from spanning unrelated code.
const DECLARED_WORKFLOW_RE =
  /(?<![A-Za-z0-9_$])workflow\s*(?:<[^>]*>)?\s*\(\s*\{[\s\S]{0,400}?\bid\s*:\s*["'`]([^"'`]+)["'`]/g

/**
 * Recursively scan the entry file's directory for `workflow({ id })`
 * declarations in local source. Best-effort/heuristic — it powers an advisory
 * doctor check, not a build gate.
 */
async function scanDeclaredWorkflowIds(entryFile: string): Promise<DeclaredWorkflow[]> {
  const root = dirname(entryFile)
  const found: DeclaredWorkflow[] = []
  const seen = new Set<string>()

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      const full = resolvePath(dir, entry.name)
      if (entry.isDirectory()) {
        if (SCAN_IGNORE_DIRS.has(entry.name)) continue
        await walk(full)
      } else if (entry.isFile() && isScannableSource(entry.name)) {
        const content = await readFile(full, "utf8").catch(() => "")
        for (const match of content.matchAll(DECLARED_WORKFLOW_RE)) {
          const id = match[1]
          if (!id) continue
          const key = `${id} ${full}`
          if (seen.has(key)) continue
          seen.add(key)
          found.push({ id, file: relative(root, full) || entry.name })
        }
      }
    }
  }

  await walk(root)
  return found
}

function isScannableSource(name: string): boolean {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return false
  return /\.[cm]?[jt]sx?$/.test(name)
}

async function runCommand(
  command: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<{ ok: true } | { ok: false; message: string; exitCode: number }> {
  const [bin, ...args] = command
  if (!bin) {
    return { ok: false, message: "empty command", exitCode: 1 }
  }
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on("error", (err: Error) => {
      resolve({ ok: false, message: err.message, exitCode: 1 })
    })
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        resolve({ ok: true })
        return
      }
      resolve({
        ok: false,
        message: formatCommandFailure({
          signal,
          code,
          stdout,
          stderr,
        }),
        exitCode: code ?? 1,
      })
    })
  })
}

function formatCommandFailure(args: {
  signal: NodeJS.Signals | null
  code: number | null
  stdout: string
  stderr: string
}): string {
  const output = [args.stderr.trim(), args.stdout.trim()].find((value) => value.length > 0)
  if (args.signal) {
    return output
      ? `terminated by signal ${args.signal}: ${output}`
      : `terminated by signal ${args.signal}`
  }
  return output
    ? `exited with code ${args.code ?? 1}: ${output}`
    : `exited with code ${args.code ?? 1}`
}
