import { getStringFlag, parseArgs } from "../lib/args.js"
import {
  type DevelopProjectWatcherFactory,
  watchDevelopProjectInputs,
} from "../lib/develop-project-watcher.js"
import { errorMessage } from "../lib/output.js"
import { prepareProjectArtifacts } from "../lib/project-artifacts.js"
import { loadProjectEnv, resolveProjectEnvRoot } from "../lib/project-env.js"
import {
  loadProjectTooling,
  requireToolingFunction,
  type VoyantProjectToolingModule,
} from "../lib/project-tooling.js"
import { waitForShutdownSignal } from "../lib/shutdown.js"
import type { CommandContext, CommandResult } from "../types.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 3300

export interface DevelopCommandDeps {
  env?: Record<string, string | undefined>
  loadEnv?: typeof loadProjectEnv
  prepareArtifacts?: typeof prepareProjectArtifacts
  loadTooling?: (projectRoot: string) => Promise<VoyantProjectToolingModule>
  watchProjectInputs?: DevelopProjectWatcherFactory
  waitForShutdown?: (cleanup: () => Promise<void>) => Promise<void>
}

export async function developCommand(
  ctx: CommandContext,
  deps: DevelopCommandDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, { booleanFlags: ["help"] })
  if (args.flags.help === true || args.flags.h === true) {
    ctx.stdout(`${DEVELOP_USAGE}\n`)
    return 0
  }

  const portValue = getStringFlag(args, "port")
  const port = portValue === undefined ? DEFAULT_PORT : Number.parseInt(portValue, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ctx.stderr(`voyant develop: --port must be 1-65535 (got "${String(portValue)}")\n`)
    return 2
  }
  const host = getStringFlag(args, "host") ?? DEFAULT_HOST

  let cleanup: (() => Promise<void>) | undefined
  try {
    const configPath = getStringFlag(args, "config")
    await (deps.loadEnv ?? loadProjectEnv)(
      resolveProjectEnvRoot(ctx.cwd, configPath),
      deps.env ?? process.env,
    )
    const prepared = await (deps.prepareArtifacts ?? prepareProjectArtifacts)(ctx.cwd, {
      configPath,
    })
    const tooling = await (deps.loadTooling ?? loadProjectTooling)(prepared.projectRoot)
    const developVoyantProject = requireToolingFunction(tooling, "developVoyantProject", "develop")
    const handle = await developVoyantProject({
      projectRoot: prepared.projectRoot,
      host,
      port,
    })
    if (!handle || typeof handle.url !== "string" || typeof handle.close !== "function") {
      throw new Error(
        "The project runtime tooling returned an invalid development handle. Upgrade @voyant-travel/runtime before running `voyant develop`.",
      )
    }
    const prepareArtifacts = deps.prepareArtifacts ?? prepareProjectArtifacts
    let refreshQueue = Promise.resolve()
    let acceptingRefreshes = true
    const refresh = (): Promise<void> => {
      if (!acceptingRefreshes) return refreshQueue
      const next = refreshQueue.then(async () => {
        try {
          const refreshed = await prepareArtifacts(ctx.cwd, { configPath })
          ctx.stderr(
            `voyant develop: project artifacts refreshed ${refreshed.manifest.graphHash}\n`,
          )
        } catch (error) {
          ctx.stderr(`voyant develop: project artifact refresh failed: ${errorMessage(error)}\n`)
        }
      })
      refreshQueue = next
      return next
    }
    let watcher: { close(): void } | undefined
    let closed = false
    cleanup = async () => {
      if (closed) return
      closed = true
      acceptingRefreshes = false
      watcher?.close()
      await refreshQueue
      await handle.close()
    }
    watcher = (deps.watchProjectInputs ?? watchDevelopProjectInputs)(
      {
        projectRoot: prepared.projectRoot,
        configPath: prepared.resolution.configPath,
      },
      refresh,
    )
    ctx.stderr(`voyant develop: ${handle.url}\n`)
    await (deps.waitForShutdown ?? waitForShutdownSignal)(cleanup)
    return 0
  } catch (error) {
    if (cleanup) {
      try {
        await cleanup()
      } catch {
        // The original lifecycle error is more actionable than a second cleanup failure.
      }
    }
    ctx.stderr(`voyant develop: ${errorMessage(error)}\n`)
    return 1
  }
}

const DEVELOP_USAGE = `voyant develop - prepare, refresh, and run the full application in development mode

usage:
  voyant develop [--config <path>] [--host <host>] [--port <n>]

options:
  --config <path>  Use an explicit voyant.config.* file
  --host <host>    Listening host (default: 127.0.0.1)
  --port <n>       Listening port (default: 3300)
`
