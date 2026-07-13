import { type EventEmitter, once } from "node:events"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import { errorMessage } from "../lib/output.js"
import { loadProjectEnv } from "../lib/project-env.js"
import { waitForShutdownSignal } from "../lib/shutdown.js"
import type { CommandContext, CommandResult } from "../types.js"

const RUNTIME_PACKAGE = "@voyant-travel/runtime"

interface VoyantProjectServerHandle {
  port: number
  server: EventEmitter & { listening: boolean }
  close(): Promise<void>
}

interface VoyantRuntimeModule {
  startVoyantProject(options: {
    projectRoot: string
    port: number
    preferBuiltAdminAssets: boolean
  }): Promise<VoyantProjectServerHandle>
}

export interface StartCommandDeps {
  env?: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
  loadEnv?: typeof loadProjectEnv
  loadRuntime?: (cwd: string) => Promise<VoyantRuntimeModule>
  waitForShutdown?: (cleanup: () => Promise<void>) => Promise<void>
}

export async function startCommand(
  ctx: CommandContext,
  deps: StartCommandDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, { booleanFlags: ["help", "probe"] })
  if (getBooleanFlag(args, "help", "h")) {
    ctx.stdout(`${START_USAGE}\n`)
    return 0
  }

  const env = deps.env ?? process.env
  try {
    await (deps.loadEnv ?? loadProjectEnv)(ctx.cwd, env)
  } catch (error) {
    ctx.stderr(`voyant start: failed to load project environment: ${errorMessage(error)}\n`)
    return 1
  }
  const port = Number.parseInt(getStringFlag(args, "port") ?? env.PORT ?? "8080", 10)

  let runtime: VoyantRuntimeModule
  try {
    runtime = await (deps.loadRuntime ?? loadProjectRuntime)(ctx.cwd)
  } catch (error) {
    ctx.stderr(`voyant start: ${errorMessage(error)}\n`)
    return 1
  }

  let handle: VoyantProjectServerHandle
  try {
    handle = await runtime.startVoyantProject({
      projectRoot: ctx.cwd,
      port,
      preferBuiltAdminAssets: true,
    })
  } catch (error) {
    ctx.stderr(`voyant start: failed to start: ${errorMessage(error)}\n`)
    return 1
  }

  ctx.stderr(`voyant start: Node host listening on :${handle.port}\n`)

  if (getBooleanFlag(args, "probe")) {
    try {
      if (!handle.server.listening) await once(handle.server, "listening")
      const response = await (deps.fetch ?? globalThis.fetch)(
        `http://127.0.0.1:${handle.port}/healthz`,
      )
      if (!response.ok || (await response.text()) !== "ok") {
        throw new Error("Node host health probe failed.")
      }
      ctx.stderr("voyant start: boot probe passed\n")
      return 0
    } catch (error) {
      ctx.stderr(`voyant start: ${errorMessage(error)}\n`)
      return 1
    } finally {
      await handle.close()
    }
  }

  ctx.stderr("Press Ctrl+C to stop.\n")
  try {
    await (deps.waitForShutdown ?? waitForShutdownSignal)(() => handle.close())
  } catch (error) {
    ctx.stderr(`voyant start: failed to stop: ${errorMessage(error)}\n`)
    return 1
  }
  return 0
}

export async function loadProjectRuntime(cwd: string): Promise<VoyantRuntimeModule> {
  const projectRequire = createRequire(resolve(cwd, "package.json"))
  let runtimeEntry: string
  try {
    runtimeEntry = projectRequire.resolve(RUNTIME_PACKAGE)
  } catch {
    throw new Error(
      `${RUNTIME_PACKAGE} is not installed in the current project. Add it to the project's dependencies before running \`voyant start\`.`,
    )
  }

  let runtime: Partial<VoyantRuntimeModule>
  if (/\.[cm]?tsx?$/.test(runtimeEntry)) {
    let tsxApiEntry: string
    try {
      tsxApiEntry = projectRequire.resolve("tsx/esm/api")
    } catch {
      throw new Error(
        `The linked ${RUNTIME_PACKAGE} resolves to TypeScript, but tsx is not installed in the current project. Add tsx to devDependencies or use a published runtime build.`,
      )
    }
    const tsxApi = (await import(pathToFileURL(tsxApiEntry).href)) as {
      register(): (() => Promise<void>) | Promise<() => Promise<void>>
    }
    const unregister = await tsxApi.register()
    try {
      runtime = (await import(pathToFileURL(runtimeEntry).href)) as Partial<VoyantRuntimeModule>
    } finally {
      await unregister()
    }
  } else {
    runtime = (await import(pathToFileURL(runtimeEntry).href)) as Partial<VoyantRuntimeModule>
  }
  if (typeof runtime.startVoyantProject !== "function") {
    throw new Error(
      `The project-installed ${RUNTIME_PACKAGE} does not export startVoyantProject(). Upgrade it before running \`voyant start\`.`,
    )
  }
  return runtime as VoyantRuntimeModule
}

const START_USAGE = `voyant start - start the current project with its installed Voyant runtime

usage:
  voyant start [--port <n>] [--probe]

options:
  --port <n>  Listening port (default: PORT or 8080)
  --probe     Check /healthz after startup, then exit
`
