import { spawn } from "node:child_process"
import { copyFile } from "node:fs/promises"
import { dirname, resolve as resolvePath } from "node:path"
import { getBooleanFlag, getStringFlag, type ParsedArgs, parseArgs } from "../../lib/args.js"
import { type BuildCmdDeps, defaultBuildDeps, runWorkflowsBuild } from "./build-cmd.js"

// Workflows are Node-only (docs/architecture/workflows-runtime-architecture.md).
// The Cloudflare Worker/Durable Object workflow adapter has been removed from
// the workspace, so `docker` (the Node self-host server) is the only deploy
// target. `--target` is retained for forward-compatibility and explicitness.
export type DeployTarget = "docker"

export interface DeployOutcome {
  target: DeployTarget
  bundlePath: string
  manifestPath: string
  stagedBundlePath: string
  stagedConfigPath?: string
  applied: boolean
  applyCommand?: readonly string[]
  applyCwd?: string
  nextStep: string
}

export interface DeployDeps extends BuildCmdDeps {
  copyFile: (from: string, to: string) => Promise<void>
  runCommand: (args: {
    command: readonly string[]
    cwd?: string
  }) => Promise<{ ok: true } | { ok: false; message: string; exitCode: number }>
}

const DOCKER_STAGE_PATH = "apps/selfhost-node-server/dist/bundle.mjs"
const DOCKER_ENV_STAGE_PATH = "apps/selfhost-node-server/dist/selfhost.env"
const DEFAULT_DOCKER_DATABASE_URL = ["postgresql://voyant:voyant", "postgres:5432/voyant"].join("@")

export async function runWorkflowsDeploy(
  args: ParsedArgs,
  deps: DeployDeps,
): Promise<{ ok: true; result: DeployOutcome } | { ok: false; message: string; exitCode: number }> {
  const target = getDeployTarget(args)
  if (!target) {
    return {
      ok: false,
      message: "voyant workflows deploy: missing required --target <docker>",
      exitCode: 2,
    }
  }

  const file = getStringFlag(args, "file", "entry")
  if (!file) {
    return {
      ok: false,
      message: "voyant workflows deploy: missing required --file <path>",
      exitCode: 2,
    }
  }

  const buildOutDir = getStringFlag(args, "out") ?? `.voyant/deploy/${target}`
  const buildArgv = ["--file", file, "--out", buildOutDir, "--platform", "node"]
  if (getBooleanFlag(args, "minify")) buildArgv.push("--minify")
  if (getBooleanFlag(args, "no-sourcemap")) {
    buildArgv.push("--no-sourcemap")
  }

  const built = await runWorkflowsBuild(parseArgs(buildArgv), deps)
  if (!built.ok) return built

  const stagedBundlePath = resolvePath(DOCKER_STAGE_PATH)
  await deps.copyFile(built.bundlePath, stagedBundlePath)

  const dockerConfig = parseDockerDeployConfig(args)
  if (!dockerConfig.ok) return dockerConfig
  const stagedConfigPath = resolvePath(dockerConfig.envOutPath)
  await deps.mkdir(dirname(stagedConfigPath))
  await deps.writeOut(stagedConfigPath, renderDockerEnvFile(dockerConfig.config))
  const applyConfig = getApplyConfig(stagedConfigPath)

  const apply = getBooleanFlag(args, "apply")
  if (apply) {
    const commandResult = await deps.runCommand(applyConfig)
    if (!commandResult.ok) {
      return {
        ok: false,
        message: `voyant workflows deploy: ${target} apply failed: ${commandResult.message}`,
        exitCode: commandResult.exitCode,
      }
    }
  }

  return {
    ok: true,
    result: {
      target,
      bundlePath: built.bundlePath,
      manifestPath: built.manifestPath,
      stagedBundlePath,
      stagedConfigPath,
      applied: apply,
      applyCommand: apply ? applyConfig.command : undefined,
      applyCwd: apply ? applyConfig.cwd : undefined,
      nextStep: formatNextStep(apply, stagedConfigPath),
    },
  }
}

interface DockerDeployConfig {
  bindHost: string
  bindPort: number
  hostPort: number
  entryFile: string
  databaseUrl: string
  skipMigrations: boolean
  databaseWaitSeconds: number
}

function parseDockerDeployConfig(args: ParsedArgs):
  | { ok: true; envOutPath: string; config: DockerDeployConfig }
  | {
      ok: false
      message: string
      exitCode: number
    } {
  const bindHost = getStringFlag(args, "bind-host") ?? "0.0.0.0"
  const bindPort = parsePortFlag(getStringFlag(args, "bind-port"), "bind-port", 3232)
  if (!bindPort.ok) return bindPort
  const hostPort = parsePortFlag(getStringFlag(args, "host-port"), "host-port", 3232)
  if (!hostPort.ok) return hostPort
  const databaseWaitSeconds = parsePositiveIntFlag(
    getStringFlag(args, "database-wait-seconds"),
    "database-wait-seconds",
    30,
  )
  if (!databaseWaitSeconds.ok) return databaseWaitSeconds
  const envOutPath = getStringFlag(args, "env-out") ?? DOCKER_ENV_STAGE_PATH
  return {
    ok: true,
    envOutPath,
    config: {
      bindHost,
      bindPort: bindPort.value,
      hostPort: hostPort.value,
      entryFile: "/app/workflows/bundle.mjs",
      databaseUrl: getStringFlag(args, "database-url") ?? DEFAULT_DOCKER_DATABASE_URL,
      skipMigrations: getBooleanFlag(args, "skip-migrations"),
      databaseWaitSeconds: databaseWaitSeconds.value,
    },
  }
}

function getDeployTarget(args: ParsedArgs): DeployTarget | undefined {
  const raw = getStringFlag(args, "target")
  if (raw === "docker") return raw
  return undefined
}

function getApplyConfig(dockerEnvPath: string): {
  command: readonly string[]
  cwd?: string
} {
  return {
    command: [
      "docker",
      "compose",
      "--env-file",
      dockerEnvPath,
      "-f",
      "apps/selfhost-node-server/docker-compose.yml",
      "up",
      "--build",
      "-d",
    ],
  }
}

function formatNextStep(applied: boolean, stagedConfigPath: string): string {
  return applied
    ? "docker target applied via docker compose"
    : `run \`docker compose --env-file ${stagedConfigPath} -f apps/selfhost-node-server/docker-compose.yml up --build -d\``
}

function renderDockerEnvFile(config: DockerDeployConfig): string {
  return [
    "# Generated by `voyant workflows deploy --target docker`.",
    "# Edit and re-run `docker compose --env-file ... up --build -d` to adjust the runtime.",
    `VOYANT_HOST_PORT=${config.hostPort}`,
    `VOYANT_BIND_HOST=${config.bindHost}`,
    `VOYANT_BIND_PORT=${config.bindPort}`,
    `VOYANT_ENTRY_FILE=${config.entryFile}`,
    `VOYANT_DATABASE_URL=${config.databaseUrl}`,
    `VOYANT_SKIP_MIGRATIONS=${config.skipMigrations ? 1 : 0}`,
    `VOYANT_DATABASE_WAIT_SECONDS=${config.databaseWaitSeconds}`,
    "",
  ].join("\n")
}

function parsePortFlag(
  raw: string | undefined,
  flag: string,
  fallback: number,
): { ok: true; value: number } | { ok: false; message: string; exitCode: number } {
  if (!raw) return { ok: true, value: fallback }
  const value = Number.parseInt(raw, 10)
  if (Number.isNaN(value) || value < 1 || value > 65535) {
    return {
      ok: false,
      message: `voyant workflows deploy: --${flag} must be 1-65535 (got "${raw}")`,
      exitCode: 2,
    }
  }
  return { ok: true, value }
}

function parsePositiveIntFlag(
  raw: string | undefined,
  flag: string,
  fallback: number,
): { ok: true; value: number } | { ok: false; message: string; exitCode: number } {
  if (!raw) return { ok: true, value: fallback }
  const value = Number.parseInt(raw, 10)
  if (Number.isNaN(value) || value < 1) {
    return {
      ok: false,
      message: `voyant workflows deploy: --${flag} must be a positive integer (got "${raw}")`,
      exitCode: 2,
    }
  }
  return { ok: true, value }
}

export async function defaultDeployDeps(): Promise<DeployDeps> {
  const buildDeps = await defaultBuildDeps()
  return {
    ...buildDeps,
    copyFile: async (from, to) => {
      await copyFile(from, to)
    },
    runCommand: ({ command, cwd }) =>
      runCommand(command, {
        cwd,
      }),
  }
}

async function runCommand(
  command: readonly string[],
  options: { cwd?: string },
): Promise<{ ok: true } | { ok: false; message: string; exitCode: number }> {
  const [bin, ...args] = command
  if (!bin) {
    return { ok: false, message: "empty command", exitCode: 1 }
  }
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      stdio: "inherit",
    })
    child.on("error", (err) => {
      resolve({ ok: false, message: err.message, exitCode: 1 })
    })
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({ ok: true })
        return
      }
      resolve({
        ok: false,
        message: signal ? `terminated by signal ${signal}` : `exited with code ${code ?? 1}`,
        exitCode: code ?? 1,
      })
    })
  })
}
