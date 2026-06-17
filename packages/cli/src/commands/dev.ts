// `voyant dev` — watch-mode dev loop.
//
// Given a workflow entry file (TS / JS / MJS), keeps an esbuild
// context alive in watch mode. Every successful rebuild hot-reloads
// the serve process:
//
//   1. close the current HTTP server (stops the scheduler, frees the port)
//   2. reset the workflow registry (so stale workflow ids don't linger)
//   3. reload the freshly rebuilt bundle (repopulates the registry)
//   4. start a new HTTP server with new deps on the same port
//
// The dashboard is loaded on the same port and reconnects via SSE
// automatically, so the browser "just works" across reloads.

import { mkdir } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"
import type { BuildContext, Plugin } from "esbuild"
import {
  defaultServeDeps,
  parseServeOptions,
  type ServeHandle,
  type ServeOptions,
  startServer,
} from "./workflows/serve.js"

/**
 * Injectable surface for tests. `runDev` composes these; the command
 * layer binds `defaultDevDeps()` for the real esbuild / serve wiring.
 */
export interface DevDeps {
  /** Emit the bundle on initial build + every rebuild. Returns a cleanup handle. */
  startBundler(args: {
    entryFile: string
    outFile: string
    onRebuild: (outcome: { ok: boolean; errors: string[] }) => Promise<void>
  }): Promise<{ dispose: () => Promise<void> }>
  /** Start a serve against the given entry; returns the serve handle. */
  startServe(
    options: ServeOptions,
    entryFile: string,
  ): Promise<ServeHandle & { scheduleCount?: number; workflowCount?: number }>
  /** Optional logger for structured output; defaults to console.error. */
  log?: (level: "info" | "warn" | "error", msg: string, data?: object) => void
}

export interface DevHandle {
  /** Stop the watcher + the serve. Safe to call multiple times. */
  close: () => Promise<void>
  /** Current serve URL (changes are no-ops; the URL stays on the same port). */
  url: string
}

export interface DevArgs {
  entryFile: string
  outDir: string
  options: ServeOptions
}

export async function runDev(args: DevArgs, deps: DevDeps): Promise<DevHandle> {
  const log =
    deps.log ??
    ((level, msg) => {
      if (level === "error") console.error(`[dev] ${msg}`)
      else console.error(`[dev] ${msg}`)
    })

  const outFile = resolvePath(args.outDir, "bundle.cjs")

  // Track the current serve so we can swap it on rebuild.
  let serve: ServeHandle | undefined
  let closed = false
  let rebuildInFlight: Promise<void> = Promise.resolve()

  const reload = async (): Promise<void> => {
    if (closed) return
    const next = rebuildInFlight.then(async () => {
      if (closed) return
      if (serve) {
        try {
          await serve.close()
        } catch (err) {
          log("warn", `close failed before reload: ${errStr(err)}`)
        }
      }
      try {
        const h = await deps.startServe(args.options, outFile)
        serve = h
        log(
          "info",
          `reloaded · ${h.workflowCount ?? 0} workflow${
            h.workflowCount === 1 ? "" : "s"
          }${h.scheduleCount ? ` · ${h.scheduleCount} schedule${h.scheduleCount === 1 ? "" : "s"}` : ""}`,
        )
      } catch (err) {
        log("error", `serve failed after rebuild: ${errStr(err)}`)
      }
    })
    rebuildInFlight = next
    await next
  }

  // `startBundler` must fire `onRebuild` exactly once after the
  // initial build lands on disk, then once per subsequent source
  // change. We use that first firing as the initial serve start —
  // no separate `reload()` call here.
  const bundler = await deps.startBundler({
    entryFile: args.entryFile,
    outFile,
    onRebuild: async (outcome) => {
      if (!outcome.ok) {
        log("error", `build failed:\n${outcome.errors.map((e) => `  ${e}`).join("\n")}`)
        return
      }
      await reload()
    },
  })

  // Wait for the first reload to have fired so callers see a ready
  // serve URL on return. `startBundler` resolves only after
  // `onRebuild` has been called at least once; `rebuildInFlight`
  // captures the in-flight reload for that first firing.
  await rebuildInFlight

  return {
    url: serve?.url ?? `http://${args.options.host}:${args.options.port}`,
    close: async () => {
      closed = true
      try {
        await bundler.dispose()
      } catch (err) {
        log("warn", `bundler dispose failed: ${errStr(err)}`)
      }
      if (serve) {
        try {
          await serve.close()
        } catch (err) {
          log("warn", `serve close failed: ${errStr(err)}`)
        }
      }
    },
  }
}

// ---- Default deps (real esbuild + serve) ----

export async function defaultDevDeps(): Promise<DevDeps> {
  return {
    async startBundler({ entryFile, outFile, onRebuild }) {
      const { context } = await import("esbuild")
      await mkdir(resolvePath(outFile, ".."), { recursive: true })

      // esbuild invokes onEnd for every build — the initial explicit
      // rebuild, whatever pre-scan `watch()` does, and every source
      // change afterward. We only want one firing per real build
      // event, so we route everything through a single `ctx.rebuild()`
      // and swallow the duplicate onEnd that `ctx.watch()` fires on
      // setup.
      let swallowNextOnEnd = false
      const rebuildPlugin: Plugin = {
        name: "voyant-dev-reload",
        setup(b) {
          b.onEnd(async (result) => {
            if (swallowNextOnEnd) {
              swallowNextOnEnd = false
              return
            }
            const errors = result.errors.map((e) => e.text)
            await onRebuild({ ok: errors.length === 0, errors })
          })
        },
      }

      const ctx: BuildContext = await context({
        entryPoints: [entryFile],
        outfile: outFile,
        bundle: true,
        format: "cjs",
        target: "es2022",
        platform: "node",
        sourcemap: true,
        logLevel: "silent",
        plugins: [rebuildPlugin],
      })

      // First build: synchronous, fires onEnd → onRebuild → reload.
      await ctx.rebuild()

      // Watch-mode setup itself triggers a second onEnd once it
      // completes its initial scan; swallow that one. Subsequent
      // source-change firings propagate normally.
      swallowNextOnEnd = true
      await ctx.watch()

      return {
        dispose: async () => {
          await ctx.dispose()
        },
      }
    },

    async startServe(options, entryFile) {
      // Every reload reimports the bundle with a cache-busting query
      // and clears the globalThis-backed registry so the serve sees
      // only the current bundle's workflows.
      const wfMod = (await import("@voyant-travel/workflows")) as unknown as {
        __resetRegistry: () => void
      }
      wfMod.__resetRegistry()
      const deps = await defaultServeDeps({ entryFile, cacheBustEntry: true })
      const handle = await startServer(options, deps)
      const workflowCount = deps.listWorkflows ? deps.listWorkflows().length : 0
      const scheduleCount = deps.listSchedules ? deps.listSchedules().length : 0
      return {
        ...handle,
        workflowCount,
        scheduleCount,
      }
    },
  }
}

export { parseServeOptions }

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
