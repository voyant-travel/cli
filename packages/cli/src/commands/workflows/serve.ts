// `voyant workflows serve [--port N] [--host H]`
//
// Starts a minimal HTTP server that exposes the local run store as JSON.
// Zero-dep: Node built-in http module. Consumers (dashboards, curl,
// Postman, future `voyant dev` SPA) fetch runs without re-reading the
// filesystem.

import { readFile, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { extname, join, resolve as resolvePath } from "node:path"
import { URL } from "node:url"
import {
  createScheduler,
  createSleepAlarmManager,
  durationToMs,
  generateLocalRunId,
  recordToSnapshot,
  type SchedulerHandle,
  type ScheduleSource,
  snapshotToRecord,
} from "@voyant-travel/workflows-orchestrator-node"
import { getStringFlag, type ParsedArgs } from "../../lib/args.js"
import { createFsRunStore, type ListFilter, type RunStore } from "../../lib/run-store.js"
import { createStoreStream, type StoreEvent, type StoreStream } from "../../lib/store-stream.js"

export interface ServeDeps {
  store: RunStore
  createServer: typeof createServer
  /** Optional runtime cleanup hook invoked when the server closes. */
  shutdown?: () => void
  /** Optional static asset source; if provided, serves index.html at / and static files from the dir. */
  staticDir?: string
  /** Injectable reader for tests. */
  readStatic?: (path: string) => Promise<Uint8Array | null>
  /**
   * Called by `POST /api/runs/:id/replay`. Receives the run id; returns
   * the newly-saved replay run or an error message. Supplied only when
   * replay is supported in this process (i.e. Node can import the
   * original entry file).
   */
  replayRun?: (
    runId: string,
  ) => Promise<
    | { ok: true; saved: import("../../lib/run-store.js").StoredRun }
    | { ok: false; message: string; exitCode: number }
  >

  /**
   * Called by `POST /api/runs`. Triggers a new run of the given
   * workflow with the supplied input. Only available when the serve
   * command was started with an `--file` entry pre-loaded.
   */
  triggerRun?: (args: {
    workflowId: string
    input: unknown
  }) => Promise<
    | { ok: true; saved: import("../../lib/run-store.js").StoredRun }
    | { ok: false; message: string; exitCode: number }
  >

  /**
   * Called by `GET /api/workflows`. Lists workflows registered by the
   * pre-loaded entry file. Also gated on `--file`.
   */
  listWorkflows?: () => { id: string; description?: string }[]

  /**
   * Called by `POST /api/runs/:id/events`, `/signals`, `/tokens/:tokenId`.
   * Resolves a pending waitpoint on a parked run and drives the body
   * forward. Only wired when `--file` was supplied at startup.
   */
  injectWaitpoint?: (args: {
    runId: string
    injection: WaitpointInjection
  }) => Promise<
    | { ok: true; saved: import("../../lib/run-store.js").StoredRun }
    | { ok: false; message: string; exitCode: number }
  >

  /** Optional scheduler handle; server will call start/stop around listen/close. */
  scheduler?: SchedulerHandle

  /** Called by `GET /api/schedules`. Returns the current schedule list. */
  listSchedules?: () => { workflowId: string; name?: string; nextAt: number; done: boolean }[]

  /**
   * Called by `POST /api/runs/:id/cancel`. Closes out a parked run as
   * status="cancelled" without running compensations (local dev only).
   */
  cancelRun?: (args: {
    runId: string
  }) => Promise<
    | { ok: true; saved: import("../../lib/run-store.js").StoredRun }
    | { ok: false; message: string; exitCode: number }
  >

  /**
   * Per-run stream-chunk bus. The orchestrator publishes chunks here
   * as `ctx.stream.*` emits them; the SSE endpoint forwards each
   * chunk to dashboard subscribers so they render live. Only
   * populated when the serve was started with `--file`.
   */
  chunkBus?: ChunkBus
}

export interface ChunkEvent {
  runId: string
  chunk: {
    streamId: string
    seq: number
    encoding: "text" | "json" | "base64"
    chunk: unknown
    final: boolean
    at: number
  }
}

export interface ChunkBus {
  publish(event: ChunkEvent): void
  subscribe(fn: (event: ChunkEvent) => void): () => void
}

export function createChunkBus(): ChunkBus {
  const subs = new Set<(event: ChunkEvent) => void>()
  return {
    publish(event) {
      for (const fn of subs) {
        try {
          fn(event)
        } catch {
          /* one bad subscriber must not break the loop */
        }
      }
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

/** HTTP-flavoured injection argument, mirroring @voyant-travel/workflows/testing. */
export type WaitpointInjection =
  | { kind: "EVENT"; eventType: string; payload?: unknown }
  | { kind: "SIGNAL"; name: string; payload?: unknown }
  | { kind: "MANUAL"; tokenId: string; payload?: unknown }

export interface ServeOptions {
  port: number
  host: string
}

export type ServeParseOutcome =
  | { ok: true; options: ServeOptions }
  | { ok: false; message: string; exitCode: number }

const DEFAULT_PORT = 3232
const DEFAULT_HOST = "127.0.0.1"

export function parseServeOptions(args: ParsedArgs): ServeParseOutcome {
  const portStr = getStringFlag(args, "port")
  let port = DEFAULT_PORT
  if (portStr !== undefined) {
    const parsed = Number.parseInt(portStr, 10)
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
      return {
        ok: false,
        message: `voyant workflows serve: --port must be 1-65535 (got "${portStr}")`,
        exitCode: 2,
      }
    }
    port = parsed
  }

  const host = getStringFlag(args, "host") ?? DEFAULT_HOST
  return { ok: true, options: { port, host } }
}

export interface RequestHandlerDeps {
  store: RunStore
  readStatic?: (path: string) => Promise<Uint8Array | null>
  hasStaticDashboard?: boolean
  replayRun?: ServeDeps["replayRun"]
  triggerRun?: ServeDeps["triggerRun"]
  listWorkflows?: ServeDeps["listWorkflows"]
  injectWaitpoint?: ServeDeps["injectWaitpoint"]
  listSchedules?: ServeDeps["listSchedules"]
  cancelRun?: ServeDeps["cancelRun"]
}

/**
 * Pure request handler — unit-testable without spinning up a socket.
 * Returns a response object; the transport (HTTP server) wires it
 * through to the actual ServerResponse.
 */
export interface HandlerResponse {
  status: number
  headers: Record<string, string>
  /** String for JSON/text responses, Uint8Array for binary static assets. */
  body: string | Uint8Array
}

export async function handleRequest(
  req: { method: string; url: string; body?: string },
  deps: RequestHandlerDeps,
): Promise<HandlerResponse> {
  const method = (req.method ?? "GET").toUpperCase()
  const url = new URL(req.url, "http://local")

  // CORS preflight — permissive by design; the server only runs
  // locally.
  if (method === "OPTIONS") {
    return {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
      body: "",
    }
  }

  // Mutating actions. POSTs are short-circuited before the GET-only
  // guard below so `405` is reserved for genuinely unsupported verbs.
  if (method === "POST") {
    // Replay.
    const replayMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/replay$/)
    if (replayMatch) {
      if (!deps.replayRun) {
        return json(501, {
          error: "replay_not_supported",
          message:
            "This serve instance was started without a workflow entry to " +
            "replay against. Restart with `--file <path>`, or use the CLI: " +
            "`voyant workflows replay <run-id>`.",
        })
      }
      const runId = decodeURIComponent(replayMatch[1]!)
      const result = await deps.replayRun(runId)
      if (!result.ok) {
        return json(result.exitCode === 2 ? 400 : 404, {
          error: "replay_failed",
          message: result.message,
        })
      }
      return json(200, { saved: result.saved })
    }
    // Cancel a parked run.
    const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/)
    if (cancelMatch) {
      if (!deps.cancelRun) {
        return json(501, {
          error: "cancel_not_supported",
          message:
            "This serve instance was started without a workflow entry. " +
            "Restart with `--file <path>` to enable cancellation.",
        })
      }
      const runId = decodeURIComponent(cancelMatch[1]!)
      const result = await deps.cancelRun({ runId })
      if (!result.ok) {
        return json(result.exitCode === 2 ? 400 : 404, {
          error: "cancel_failed",
          message: result.message,
        })
      }
      return json(200, { saved: result.saved })
    }
    // Inject a waitpoint resolution on a parked run.
    // POST /api/runs/:id/events    — body: { eventType, payload? }
    // POST /api/runs/:id/signals   — body: { name, payload? }
    // POST /api/runs/:id/tokens/:tokenId — body: { payload? }
    const eventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
    const signalsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/signals$/)
    const tokenMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/tokens\/([^/]+)$/)
    if (eventsMatch || signalsMatch || tokenMatch) {
      if (!deps.injectWaitpoint) {
        return json(501, {
          error: "inject_not_supported",
          message:
            "This serve instance was started without a workflow entry. " +
            "Restart with `--file <path>` to enable event / signal / token injection.",
        })
      }
      let parsed: Record<string, unknown>
      try {
        parsed = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {}
      } catch (err) {
        return json(400, {
          error: "invalid_json",
          message: err instanceof Error ? err.message : String(err),
        })
      }
      let injection: WaitpointInjection
      if (eventsMatch) {
        if (typeof parsed.eventType !== "string" || parsed.eventType.length === 0) {
          return json(400, { error: "invalid_body", message: "`eventType` (string) is required" })
        }
        injection = { kind: "EVENT", eventType: parsed.eventType, payload: parsed.payload }
      } else if (signalsMatch) {
        if (typeof parsed.name !== "string" || parsed.name.length === 0) {
          return json(400, { error: "invalid_body", message: "`name` (string) is required" })
        }
        injection = { kind: "SIGNAL", name: parsed.name, payload: parsed.payload }
      } else {
        injection = {
          kind: "MANUAL",
          tokenId: decodeURIComponent(tokenMatch![2]!),
          payload: parsed.payload,
        }
      }
      const runId = decodeURIComponent((eventsMatch?.[1] ?? signalsMatch?.[1] ?? tokenMatch?.[1])!)
      const result = await deps.injectWaitpoint({ runId, injection })
      if (!result.ok) {
        return json(result.exitCode === 2 ? 400 : 404, {
          error: "inject_failed",
          message: result.message,
        })
      }
      return json(200, { saved: result.saved })
    }
    // Trigger a new run.
    if (url.pathname === "/api/runs") {
      if (!deps.triggerRun) {
        return json(501, {
          error: "trigger_not_supported",
          message:
            "This serve instance was started without a workflow entry. " +
            "Restart with `--file <path>` to enable triggering from the dashboard.",
        })
      }
      let parsed: { workflowId?: unknown; input?: unknown }
      try {
        parsed = req.body ? JSON.parse(req.body) : {}
      } catch (err) {
        return json(400, {
          error: "invalid_json",
          message: err instanceof Error ? err.message : String(err),
        })
      }
      if (typeof parsed.workflowId !== "string" || parsed.workflowId.length === 0) {
        return json(400, {
          error: "invalid_body",
          message: "`workflowId` (string) is required",
        })
      }
      const result = await deps.triggerRun({
        workflowId: parsed.workflowId,
        input: parsed.input,
      })
      if (!result.ok) {
        return json(result.exitCode === 2 ? 400 : 404, {
          error: "trigger_failed",
          message: result.message,
        })
      }
      return json(200, { saved: result.saved })
    }
    return json(404, { error: "route_not_found", path: url.pathname })
  }

  if (method !== "GET" && method !== "HEAD") {
    return json(405, { error: "method_not_allowed", allowed: ["GET", "HEAD", "OPTIONS", "POST"] })
  }

  if (url.pathname === "/" || url.pathname === "") {
    if (deps.hasStaticDashboard && deps.readStatic) {
      const bytes = await deps.readStatic("index.html")
      if (bytes) {
        return {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
          body: bytes,
        }
      }
    }
    return json(200, {
      service: "voyant workflows serve",
      endpoints: ["/api/runs", "/api/runs/:id"],
    })
  }

  // Static assets: anything outside /api/* that maps to a file in the
  // dashboard bundle directory. Locked to the dashboard dir (no path
  // traversal) because only `readStatic` has access to the root.
  if (deps.hasStaticDashboard && deps.readStatic && !url.pathname.startsWith("/api/")) {
    const clean = url.pathname.replace(/^\/+/, "")
    if (clean && !clean.includes("..")) {
      const bytes = await deps.readStatic(clean)
      if (bytes) {
        return {
          status: 200,
          headers: {
            "content-type": mimeFor(clean),
            "cache-control": "no-store",
          },
          body: bytes,
        }
      }
    }
  }

  if (url.pathname === "/api/workflows") {
    const workflows = deps.listWorkflows ? deps.listWorkflows() : []
    return json(200, { workflows })
  }

  if (url.pathname === "/api/schedules") {
    const schedules = deps.listSchedules ? deps.listSchedules() : []
    return json(200, { schedules })
  }

  if (url.pathname === "/api/runs") {
    const filter: ListFilter = {}
    const workflowId = url.searchParams.get("workflow") ?? url.searchParams.get("workflowId")
    if (workflowId) filter.workflowId = workflowId
    const status = url.searchParams.get("status")
    if (status) filter.status = status
    const limitRaw = url.searchParams.get("limit")
    if (limitRaw !== null) {
      const limit = Number.parseInt(limitRaw, 10)
      if (Number.isNaN(limit) || limit < 0) {
        return json(400, {
          error: "invalid_limit",
          message: `limit must be a non-negative integer (got "${limitRaw}")`,
        })
      }
      filter.limit = limit
    }
    const runs = await deps.store.list(filter)
    return json(200, { runs })
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]!)
    const run = await deps.store.get(runId)
    if (!run) return json(404, { error: "not_found", runId })
    return json(200, { run })
  }

  return json(404, { error: "route_not_found", path: url.pathname })
}

function json(status: number, body: unknown): HandlerResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body, null, 2),
  }
}

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase()
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8"
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8"
    case ".css":
      return "text/css; charset=utf-8"
    case ".json":
      return "application/json; charset=utf-8"
    case ".svg":
      return "image/svg+xml"
    case ".png":
      return "image/png"
    case ".map":
      return "application/json"
    default:
      return "application/octet-stream"
  }
}

/**
 * Build a file reader scoped to `rootDir`. Returns null when the file
 * is missing or escapes the root (defense against path traversal via
 * unexpected clients).
 */
export function createStaticReader(rootDir: string): (path: string) => Promise<Uint8Array | null> {
  const root = resolvePath(rootDir)
  return async (path: string) => {
    const absolute = resolvePath(root, path)
    if (!absolute.startsWith(`${root}/`) && absolute !== root) return null
    try {
      return await readFile(absolute)
    } catch {
      return null
    }
  }
}

/** Locate the bundled dashboard dir by checking a few well-known paths. */
export async function findDashboardDir(startFrom: string): Promise<string | undefined> {
  const candidates = [
    join(startFrom, "apps/local-dashboard/dist"),
    join(startFrom, "../local-dashboard/dist"),
    join(startFrom, "../../apps/local-dashboard/dist"),
    join(startFrom, "../../../apps/local-dashboard/dist"),
  ]
  for (const c of candidates) {
    try {
      const s = await stat(join(c, "index.html"))
      if (s.isFile()) return c
    } catch {
      // continue
    }
  }
  return undefined
}

export interface ServeHandle {
  close: () => Promise<void>
  url: string
}

/** Start the HTTP server and return a handle. */
export async function startServer(options: ServeOptions, deps: ServeDeps): Promise<ServeHandle> {
  const readStatic =
    deps.readStatic ?? (deps.staticDir ? createStaticReader(deps.staticDir) : undefined)
  const hasStaticDashboard = Boolean(readStatic)

  // Lazy: the store stream starts its poll loop only when the first
  // SSE client connects.
  let storeStream: StoreStream | undefined
  const getStoreStream = (): StoreStream => {
    if (!storeStream) storeStream = createStoreStream(deps.store)
    return storeStream
  }

  const server: Server = deps.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? "GET").toUpperCase()
    const url = req.url ?? "/"
    // SSE bypasses the pure handler — it needs a long-lived socket
    // that accumulates writes over time.
    if ((method === "GET" || method === "HEAD") && urlPath(url) === "/api/runs/stream") {
      handleSseStream(res, getStoreStream(), deps.chunkBus)
      return
    }
    // Focused per-run SSE. Filters chunks + updates to a single run
    // and auto-closes once the run reaches terminal status.
    const perRunMatch = urlPath(url).match(/^\/api\/runs\/([^/]+)\/stream$/)
    if ((method === "GET" || method === "HEAD") && perRunMatch) {
      const runId = decodeURIComponent(perRunMatch[1]!)
      handleRunSseStream(res, runId, getStoreStream(), deps.chunkBus, deps.store)
      return
    }
    try {
      const body = method === "POST" ? await readRequestBody(req) : undefined
      const response = await handleRequest(
        { method, url, body },
        {
          store: deps.store,
          readStatic,
          hasStaticDashboard,
          replayRun: deps.replayRun,
          triggerRun: deps.triggerRun,
          listWorkflows: deps.listWorkflows,
          injectWaitpoint: deps.injectWaitpoint,
          listSchedules: deps.listSchedules,
          cancelRun: deps.cancelRun,
        },
      )
      res.writeHead(response.status, response.headers)
      res.end(response.body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "internal_error", message }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  deps.scheduler?.start()

  return {
    url: `http://${options.host}:${options.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        deps.scheduler?.stop()
        deps.shutdown?.()
        storeStream?.stop()
        // Stop accepting new connections.
        server.close((err) => (err ? reject(err) : resolve()))
        // Forcibly close long-lived sockets (SSE streams, polled
        // event streams). `server.close` otherwise waits forever on
        // SSE clients that never close their end. Node 18.2+.
        ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
      }),
  }
}

function urlPath(raw: string): string {
  try {
    return new URL(raw, "http://local").pathname
  } catch {
    return raw
  }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  // Cap at ~1MB; the local API is meant for dashboards, not bulk upload.
  const MAX_BYTES = 1_000_000
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Uint8Array[] = []
    req.on("data", (c: Uint8Array) => {
      total += c.length
      if (total > MAX_BYTES) {
        req.destroy(new Error("request body exceeds 1MB"))
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", reject)
  })
}

/**
 * Write a single-subscriber SSE stream. Events are Server-Sent Events
 * following `event: <kind>\ndata: <json>\n\n` format. Also sends a
 * keep-alive comment every 25s so proxies don't kill the socket.
 */
export function handleSseStream(
  res: ServerResponse,
  stream: StoreStream,
  chunkBus?: ChunkBus,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  })
  res.write("retry: 3000\n\n")

  const writeEvent = (ev: StoreEvent): void => {
    try {
      res.write(`event: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`)
    } catch {
      // Socket closed mid-write; the 'close' handler below cleans up.
    }
  }

  const writeChunk = (ev: ChunkEvent): void => {
    try {
      res.write(`event: stream.chunk\ndata: ${JSON.stringify(ev)}\n\n`)
    } catch {
      /* ignore */
    }
  }

  const unsubscribeStore = stream.subscribe(writeEvent)
  const unsubscribeChunk = chunkBus ? chunkBus.subscribe(writeChunk) : () => {}
  const ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`)
    } catch {
      /* ignore */
    }
  }, 25_000)
  ;(ping as unknown as { unref?: () => void }).unref?.()

  res.on("close", () => {
    clearInterval(ping)
    unsubscribeStore()
    unsubscribeChunk()
  })
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "compensated",
  "compensation_failed",
])

/**
 * Per-run SSE stream. Subscribes to the store + chunk bus, writes
 * only events that pertain to `runId`, and closes the socket once
 * the run enters a terminal status. Emits a `hello` event on open
 * carrying the current stored run (so callers can render backlog
 * before live events start landing).
 */
export function handleRunSseStream(
  res: ServerResponse,
  runId: string,
  stream: StoreStream,
  chunkBus: ChunkBus | undefined,
  store: RunStore,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  })
  res.write("retry: 3000\n\n")

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    try {
      res.end()
    } catch {
      /* ignore */
    }
  }

  const writeEvent = (kind: string, data: unknown): void => {
    if (closed) return
    try {
      res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      /* ignore */
    }
  }

  // Send backlog: the currently stored run, if any.
  void store.get(runId).then((r) => {
    if (r) {
      writeEvent("hello", { run: r })
      if (TERMINAL_STATUSES.has(r.status)) {
        close()
      }
    } else {
      writeEvent("hello", { run: null })
    }
  })

  const unsubscribeStore = stream.subscribe((ev) => {
    if (ev.kind === "added" || ev.kind === "updated") {
      if (ev.run.id !== runId) return
      writeEvent(ev.kind, ev)
      if (TERMINAL_STATUSES.has(ev.run.status)) close()
    } else if (ev.kind === "removed") {
      if (ev.runId !== runId) return
      writeEvent(ev.kind, ev)
      close()
    }
  })

  const unsubscribeChunk = chunkBus
    ? chunkBus.subscribe((ev) => {
        if (ev.runId !== runId) return
        writeEvent("stream.chunk", ev)
      })
    : () => {}

  const ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`)
    } catch {
      /* ignore */
    }
  }, 25_000)
  ;(ping as unknown as { unref?: () => void }).unref?.()

  res.on("close", () => {
    closed = true
    clearInterval(ping)
    unsubscribeStore()
    unsubscribeChunk()
  })
}

export interface DefaultServeDepsOptions {
  staticDir?: string
  /** Pre-loaded entry file path. Enables `GET /api/workflows` and `POST /api/runs`. */
  entryFile?: string
  /** Cache-bust the entry import. Needed by watch-mode reloaders (`voyant dev`). */
  cacheBustEntry?: boolean
}

export async function defaultServeDeps(opts: DefaultServeDepsOptions = {}): Promise<ServeDeps> {
  // Look in multiple places so the dashboard is found whether the user
  // runs from inside the monorepo or invokes the installed binary:
  //   1. explicit override
  //   2. cwd (useful for workspace tenants)
  //   3. next to the CLI binary itself (installed layout)
  let staticDir = opts.staticDir
  if (!staticDir) staticDir = await findDashboardDir(process.cwd())
  if (!staticDir && typeof import.meta.url === "string") {
    const here = resolvePath(new URL(".", import.meta.url).pathname)
    staticDir = await findDashboardDir(here)
  }

  const store = createFsRunStore()
  const { defaultReplayDeps, runWorkflowsReplay } = await import("./replay.js")
  const replayDeps = await defaultReplayDeps()

  const replayRun: ServeDeps["replayRun"] = async (runId) => {
    const outcome = await runWorkflowsReplay(
      { positionals: [runId], positional: [runId], flags: {} },
      replayDeps,
    )
    if (!outcome.ok) {
      return { ok: false, message: outcome.message, exitCode: outcome.exitCode }
    }
    if (!outcome.saved) {
      return {
        ok: false,
        message: "replay completed but no run was saved.",
        exitCode: 1,
      }
    }
    return { ok: true, saved: outcome.saved }
  }

  // Trigger + inject + scheduler support: only wired when the user
  // passed --file at startup.
  let triggerRun: ServeDeps["triggerRun"]
  let listWorkflows: ServeDeps["listWorkflows"]
  let injectWaitpoint: ServeDeps["injectWaitpoint"]
  let scheduler: ServeDeps["scheduler"]
  let listSchedules: ServeDeps["listSchedules"]
  const cancelRun: ServeDeps["cancelRun"] = async ({ runId }) => {
    const existing = await store.get(runId)
    if (!existing) return { ok: false, message: `run "${runId}" not found`, exitCode: 1 }
    if (existing.status !== "waiting") {
      return {
        ok: false,
        message: `run "${runId}" is not parked (status: ${existing.status})`,
        exitCode: 2,
      }
    }
    if (!store.update) {
      return { ok: false, message: "run store does not support update", exitCode: 1 }
    }
    const now = Date.now()
    const updated: import("../../lib/run-store.js").StoredRun = {
      ...existing,
      status: "cancelled",
      completedAt: now,
      durationMs: now - existing.startedAt,
      result: {
        ...existing.result,
        status: "cancelled",
        cancelledAt: now,
      },
    }
    const saved = await store.update(updated)
    sleepAlarms?.clear(runId)
    return { ok: true, saved }
  }
  let sleepAlarms:
    | ReturnType<typeof createSleepAlarmManager<import("../../lib/run-store.js").StoredRun>>
    | undefined

  const chunkBus = createChunkBus()

  if (opts.entryFile) {
    const entryAbs = resolvePath(process.cwd(), opts.entryFile)
    const { loadEntryFile } = await import("../../lib/load-entry.js")
    await loadEntryFile(entryAbs, { cacheBust: opts.cacheBustEntry })

    const wfMod = (await import("@voyant-travel/workflows")) as unknown as {
      __listRegisteredWorkflows: () => import("./list.js").WorkflowDef[]
    }
    const handlerMod = await import("@voyant-travel/workflows/handler")
    const rateLimitMod = await import("@voyant-travel/workflows/rate-limit")
    const orchMod = await import("@voyant-travel/workflows-orchestrator")

    // One in-memory rate limiter for the life of the serve process.
    // Shared across every step invocation so `rateLimit` buckets
    // behave the same way across runs in a single dev session.
    const rateLimiter = rateLimitMod.createInMemoryRateLimiter()

    // In-process passthrough runner for `runtime: "node"` steps.
    // Local dev has only one Node process, so the step body runs here
    // anyway — the important part is that the routing works and the
    // runtime label flows into the journal / timeline. Production
    // replaces this with `createCfContainerStepRunner` from
    // `@voyant-travel/workflows-orchestrator-cloudflare`, which dispatches to a CF
    // Container binding sized for the step.
    const nodeStepRunner: import("@voyant-travel/workflows/handler").StepRunner = async ({
      attempt,
      fn,
      stepCtx,
    }) => {
      const startedAt = Date.now()
      try {
        const output = await fn(stepCtx)
        return { attempt, status: "ok", output, startedAt, finishedAt: Date.now() }
      } catch (err) {
        const e = err as Error
        const code =
          typeof (err as { code?: unknown }).code === "string"
            ? (err as { code: string }).code
            : "UNKNOWN"
        return {
          attempt,
          status: "err",
          error: {
            category: "USER_ERROR",
            code,
            message: e?.message ?? String(err),
            name: e?.name,
            stack: e?.stack,
          },
          startedAt,
          finishedAt: Date.now(),
        }
      }
    }

    // Build a StepHandler once; the handler consults the process-local
    // workflow registry each call, so it stays live for the entry's lifetime.
    // Forwards per-invocation options (signal + onStreamChunk) so cancel
    // and live-stream chunks work end-to-end.
    const stepHandler: import("@voyant-travel/workflows-orchestrator").StepHandler = async (
      req,
      stepOpts,
    ) => handlerMod.handleStepRequest(req, { rateLimiter, nodeStepRunner }, stepOpts)
    const tenantMeta = {
      tenantId: "tnt_local",
      projectId: "prj_local",
      organizationId: "org_local",
    }

    listWorkflows = () =>
      wfMod.__listRegisteredWorkflows().map((w) => ({
        id: w.id,
        description: w.config.description,
      }))
    const sleepAlarmManager = createSleepAlarmManager({
      listRuns: () => store.list(),
      getRun: (runId) => store.get(runId),
      saveRun: async (stored) => {
        if (!store.update) {
          throw new Error("run store does not support update")
        }
        return store.update(stored)
      },
      toRecord: (stored) => snapshotToRecord(stored),
      fromRecord: (record, base) => recordToSnapshot(record, base),
      handler: stepHandler,
      onStreamChunk: ({ runId, chunk }) => chunkBus.publish({ runId, chunk }),
      logger: (level, message, data) => {
        const error =
          typeof data === "object" && data !== null && "error" in data ? data.error : undefined
        const details = error ? `: ${String(error)}` : ""
        if (level === "error") console.error(`[voyant] ${message}${details}`)
        else console.warn(`[voyant] ${message}${details}`)
      },
      createRunStore: orchMod.createInMemoryRunStore,
      resumeDueAlarmsImpl: orchMod.resumeDueAlarms,
    })
    sleepAlarms = sleepAlarmManager

    triggerRun = async ({ workflowId, input }) => {
      const wf = wfMod.__listRegisteredWorkflows().find((w) => w.id === workflowId)
      if (!wf) {
        return {
          ok: false,
          message: `workflow "${workflowId}" is not registered in ${entryAbs}.`,
          exitCode: 2,
        }
      }
      // Generate runId up-front so the live-chunk hook can tag each
      // chunk with it before the trigger returns.
      const runId = generateLocalRunId()
      const memStore = orchMod.createInMemoryRunStore()
      let record: import("@voyant-travel/workflows-orchestrator").RunRecord
      try {
        record = await orchMod.trigger(
          {
            runId,
            workflowId,
            workflowVersion: "local",
            input,
            tenantMeta,
            timeoutMs: durationToMs(wf.config.timeout),
          },
          {
            store: memStore,
            handler: stepHandler,
            onStreamChunk: (chunk) => chunkBus.publish({ runId, chunk }),
          },
        )
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        }
      }
      const stored = recordToSnapshot(record)
      stored.entryFile = entryAbs
      if (!store.update) {
        return { ok: false, message: "run store does not support update", exitCode: 1 }
      }
      const saved = await store.update(stored)
      sleepAlarmManager.schedule(saved)
      return { ok: true, saved }
    }

    injectWaitpoint = async ({ runId, injection }) => {
      const existing = await store.get(runId)
      if (!existing) {
        return { ok: false, message: `run "${runId}" not found`, exitCode: 1 }
      }
      if (existing.status !== "waiting") {
        return {
          ok: false,
          message: `run "${runId}" is not parked (status: ${existing.status})`,
          exitCode: 2,
        }
      }
      const record = snapshotToRecord(existing)
      if (!record) {
        return {
          ok: false,
          message: `run "${runId}" has no resumable snapshot`,
          exitCode: 1,
        }
      }
      const memStore = orchMod.createInMemoryRunStore()
      await memStore.save(record)
      const out = await orchMod.resume(
        { runId, injection },
        {
          store: memStore,
          handler: stepHandler,
          onStreamChunk: (chunk) => chunkBus.publish({ runId, chunk }),
        },
      )
      if (!out.ok) {
        const exitCode = out.status === "no_match" || out.status === "not_parked" ? 2 : 1
        return { ok: false, message: out.message, exitCode }
      }
      if (!store.update) {
        return { ok: false, message: "run store does not support update", exitCode: 1 }
      }
      const saved = await store.update(recordToSnapshot(out.record, existing))
      sleepAlarmManager.schedule(saved)
      return { ok: true, saved }
    }

    // Boot-time alarm bootstrap: the fs-backed run store persists
    // waiting runs across serve restarts, but per-run wake-up timers
    // live only in this process's memory. Scan the store and arm an
    // alarm for each parked run with a DATETIME waitpoint. If a
    // `wakeAt` has already passed, the timer fires on the next tick
    // and the sleep resumes immediately.
    try {
      await sleepAlarmManager.bootstrap()
    } catch (err) {
      console.warn(
        `[voyant] failed to bootstrap sleep alarms from run store: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  // Collect any declared schedules and build a scheduler that fires
  // them through the same trigger path as `POST /api/runs`. The
  // scheduler is started by `startServer()` and stopped in close().
  if (opts.entryFile && triggerRun) {
    const wfMod2 = (await import("@voyant-travel/workflows")) as unknown as {
      __listRegisteredWorkflows: () => import("./list.js").WorkflowDef[]
    }
    const sources: ScheduleSource[] = []
    for (const wf of wfMod2.__listRegisteredWorkflows()) {
      const decl = wf.config.schedule
      if (!decl) continue
      const decls = Array.isArray(decl) ? decl : [decl]
      for (const d of decls) sources.push({ workflowId: wf.id, decl: d })
    }
    if (sources.length > 0) {
      const fire = triggerRun
      scheduler = createScheduler({
        sources,
        onFire: async ({ workflowId, input }) => {
          await fire({ workflowId, input })
        },
        logger: (level, msg) => {
          if (level === "error") console.error(`[scheduler] ${msg}`)
          else if (level === "warn") console.warn(`[scheduler] ${msg}`)
        },
      })
      listSchedules = () => scheduler!.nextFirings()
    }
  }

  return {
    store,
    shutdown: () => sleepAlarms?.stop(),
    createServer,
    staticDir,
    replayRun,
    triggerRun,
    listWorkflows,
    injectWaitpoint,
    scheduler,
    listSchedules,
    cancelRun,
    chunkBus,
  }
}
