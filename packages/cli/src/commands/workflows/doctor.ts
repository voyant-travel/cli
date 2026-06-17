import { spawn } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import { getBooleanFlag, getStringFlag, type ParsedArgs } from "../../lib/args.js"

export type DoctorTarget = "docker" | "cloudflare"

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
}

const DOCKER_BUNDLE_PATH = "apps/selfhost-node-server/dist/bundle.mjs"
const DOCKER_ENV_PATH = "apps/selfhost-node-server/dist/selfhost.env"
const DOCKER_COMPOSE_PATH = "apps/selfhost-node-server/docker-compose.yml"
const DOCKERFILE_PATH = "apps/selfhost-node-server/Dockerfile"
const DOCKER_ENTRYPOINT_PATH = "apps/selfhost-node-server/scripts/docker-entrypoint.sh"
const CLOUDFLARE_BUNDLE_PATH = "apps/selfhost-cloudflare-worker/src/bundle.mjs"
const CLOUDFLARE_WRANGLER_PATH = "apps/selfhost-cloudflare-worker/wrangler.jsonc"
const CLOUDFLARE_PLACEHOLDERS = [
  {
    token: "replace-me-after-wrangler-kv-namespace-create",
    message: "wrangler.jsonc still contains the placeholder KV namespace id for BUNDLE_HASHES",
  },
  {
    token: "replace-with-your-cf-account-id",
    message: "wrangler.jsonc still contains the placeholder R2 account id",
  },
] as const

export async function runWorkflowsDoctor(
  args: ParsedArgs,
  deps: DoctorDeps,
): Promise<{ ok: true; result: DoctorOutcome } | { ok: false; message: string; exitCode: number }> {
  const target = getDoctorTarget(args)
  if (!target) {
    return {
      ok: false,
      message: "voyant workflows doctor: missing required --target <docker|cloudflare>",
      exitCode: 2,
    }
  }

  if (target === "docker") {
    return {
      ok: true,
      result: await runDockerDoctor(args, deps),
    }
  }

  return {
    ok: true,
    result: await runCloudflareDoctor(args, deps),
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

async function runCloudflareDoctor(args: ParsedArgs, deps: DoctorDeps): Promise<DoctorOutcome> {
  const bundlePath = resolvePath(getStringFlag(args, "bundle") ?? CLOUDFLARE_BUNDLE_PATH)
  const wranglerPath = resolvePath(CLOUDFLARE_WRANGLER_PATH)
  const checks: DoctorCheck[] = []
  checks.push(
    await checkFile(deps, bundlePath, "cloudflare.bundle", "staged Cloudflare worker bundle"),
  )
  checks.push(await checkFile(deps, wranglerPath, "cloudflare.wrangler", "wrangler config"))
  checks.push(...(await checkCloudflareWranglerConfig(deps, wranglerPath)))
  checks.push(await checkBundleImport(deps, bundlePath, "cloudflare.bundle.import"))
  if (getBooleanFlag(args, "check-cloudflare")) {
    checks.push(await checkCloudflareDryRun(deps))
  }
  return {
    target: "cloudflare",
    ok: checks.every((check) => check.ok),
    checks,
  }
}

function getDoctorTarget(args: ParsedArgs): DoctorTarget | undefined {
  const raw = getStringFlag(args, "target")
  if (raw === "docker" || raw === "cloudflare") return raw
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

async function checkCloudflareWranglerConfig(
  deps: DoctorDeps,
  wranglerPath: string,
): Promise<DoctorCheck[]> {
  try {
    const content = await deps.readFile(wranglerPath)
    return CLOUDFLARE_PLACEHOLDERS.map(({ token, message }) => ({
      id: `cloudflare.wrangler.${token}`,
      ok: !content.includes(token),
      message: content.includes(token)
        ? message
        : `${message.replace("still contains ", "").replace("placeholder ", "")} configured`,
    }))
  } catch (err) {
    return [
      {
        id: "cloudflare.wrangler.content",
        ok: false,
        message: `failed to read wrangler config: ${err instanceof Error ? err.message : String(err)}`,
      },
    ]
  }
}

async function checkCloudflareDryRun(deps: DoctorDeps): Promise<DoctorCheck> {
  const result = await deps.runCommand({
    command: [
      "pnpm",
      "--filter",
      "@voyant-travel/workflows-selfhost-cloudflare-worker",
      "run",
      "deploy",
      "--dry-run",
    ],
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: "/tmp/voyant-workflows-selfhost-cloudflare.log",
      WRANGLER_LOG: process.env.WRANGLER_LOG ?? "error",
    },
  })
  if (!result.ok) {
    return {
      id: "cloudflare.wrangler.dry-run",
      ok: false,
      message: `wrangler dry-run failed: ${result.message}`,
    }
  }
  return {
    id: "cloudflare.wrangler.dry-run",
    ok: true,
    message: "wrangler dry-run rendered successfully",
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
  return {
    readFile: async (path) => readFile(path, "utf8"),
    stat: async (path) => stat(path),
    importModule: async (path) => {
      const url = pathToFileURL(path)
      url.searchParams.set("t", String(Date.now()))
      await import(url.href)
    },
    runCommand: ({ command, cwd, env }) => runCommand(command, { cwd, env }),
  }
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
