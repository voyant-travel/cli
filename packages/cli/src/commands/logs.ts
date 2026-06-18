import { getBooleanFlag, getStringFlag, type ParsedArgs, parseArgs } from "../lib/args.js"
import { CloudAuthError, createCloudClient } from "../lib/cloud-client.js"
import type { CommandContext, CommandResult } from "../types.js"

/** One runtime log line, as returned by `/cloud/v1/apps/:app/runtime-logs`. */
export interface RuntimeLogEntry {
  id: string
  timestamp: string
  level: "info" | "warn" | "error"
  message: string
  outcome?: string
  requestId?: string
  eventType?: string
  statusCode?: number
  durationMs?: number
  traceId?: string
}

interface RuntimeLogsPage {
  entries: RuntimeLogEntry[]
  windowStart: string
  windowEnd: string
  unavailable: boolean
}

const DEFAULT_FOLLOW_LOOKBACK_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_FOLLOW_INTERVAL_MS = 3000

const USAGE = `Usage: voyant logs <app> [options]

Read runtime logs for a deployed app, or follow them live.

Options:
  --env <name>        Environment (default: production)
  --level <level>     Filter by level: info | warn | error
  --search <text>     Full-text search across messages
  --since <duration>  Relative window start, e.g. 30s, 15m, 2h, 1d
  --from <time>       Window start (ISO timestamp or epoch ms)
  --to <time>         Window end (ISO timestamp or epoch ms)
  -f, --follow        Poll for and stream new logs until interrupted
  --interval <secs>   Follow poll interval in seconds (default: 3)
  --json              Output JSON (an array, or NDJSON in --follow)
  --token <token>     Voyant Cloud API token
  --api-url <url>     Voyant Cloud API base URL

Examples:
  voyant logs my-app
  voyant logs my-app --level error --since 1h
  voyant logs my-app --search "timeout" --json
  voyant logs my-app --follow --from 2026-06-18T00:00:00Z
`

export async function logsCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [appSlug] = args.positionals

  if (!appSlug || getBooleanFlag(args, "help", "h")) {
    ctx.stdout(USAGE)
    return appSlug ? 0 : 1
  }

  const level = getStringFlag(args, "level")
  if (level && level !== "info" && level !== "warn" && level !== "error") {
    ctx.stderr(`Invalid --level "${level}". Expected info, warn, or error.\n`)
    return 1
  }

  let client: ReturnType<typeof createCloudClient>
  try {
    client = createCloudClient({
      token: getStringFlag(args, "token"),
      apiUrl: getStringFlag(args, "api-url"),
      org: getStringFlag(args, "org"),
    })
  } catch (err) {
    if (err instanceof CloudAuthError) {
      ctx.stderr(`${err.message}\n`)
      return 1
    }
    throw err
  }

  const json = getBooleanFlag(args, "json")
  const fetchPage = (query: Record<string, string>) =>
    client.transport.request<RuntimeLogsPage>(
      `/cloud/v1/apps/${encodeURIComponent(appSlug)}/runtime-logs`,
      { query },
    )

  if (getBooleanFlag(args, "follow", "f")) {
    return followLogs(ctx, args, fetchPage, json)
  }

  let page: RuntimeLogsPage
  try {
    page = await fetchPage(buildQuery(args))
  } catch (err) {
    ctx.stderr(`Failed to fetch logs: ${errorMessage(err)}\n`)
    return 1
  }

  if (page.unavailable) {
    ctx.stderr(
      "Runtime logs aren't available for this app yet. Redeploy it, then logs appear after its next invocation.\n",
    )
    return 0
  }

  const entries = sortAscending(page.entries)

  if (json) {
    ctx.stdout(`${JSON.stringify(entries, null, 2)}\n`)
    return 0
  }

  if (entries.length === 0) {
    ctx.stdout("No logs in the selected window.\n")
    return 0
  }

  for (const entry of entries) {
    ctx.stdout(`${formatLine(entry)}\n`)
  }
  return 0
}

async function followLogs(
  ctx: CommandContext,
  args: ParsedArgs,
  fetchPage: (query: Record<string, string>) => Promise<RuntimeLogsPage>,
  json: boolean,
): Promise<CommandResult> {
  const baseQuery = buildQuery(args, { omitWindow: true })
  const intervalMs = followIntervalMs(args)
  const sinceMs = parseSince(getStringFlag(args, "since")) ?? DEFAULT_FOLLOW_LOOKBACK_MS

  // An explicit --from wins so `--follow --from <ts>` streams the requested
  // history before tailing live; otherwise start `--since` ago (default 5m).
  const fromFlag = getStringFlag(args, "from")
  const explicitFrom = fromFlag ? parseTimeMs(fromFlag) : undefined
  let fromMs = explicitFrom ?? Date.now() - sinceMs
  // Dedupe across polls: only entries sharing the latest seen millisecond can
  // legitimately reappear once the window advances to that millisecond.
  let seen = new Set<string>()
  let warnedUnavailable = false

  const control = installInterrupt()
  try {
    while (!control.aborted) {
      let page: RuntimeLogsPage
      try {
        page = await fetchPage({ ...baseQuery, from: String(fromMs) })
      } catch (err) {
        ctx.stderr(`Failed to fetch logs: ${errorMessage(err)}\n`)
        return 1
      }

      if (page.unavailable && !warnedUnavailable) {
        ctx.stderr(
          "Runtime logs aren't available yet — waiting for the app's next deploy/invocation…\n",
        )
        warnedUnavailable = true
      }

      const fresh = sortAscending(
        page.entries.filter((entry) => timestampMs(entry) >= fromMs && !seen.has(entry.id)),
      )

      if (fresh.length > 0) {
        for (const entry of fresh) {
          ctx.stdout(json ? `${JSON.stringify(entry)}\n` : `${formatLine(entry)}\n`)
        }
        const maxMs = Math.max(...fresh.map(timestampMs))
        fromMs = maxMs
        seen = new Set(fresh.filter((entry) => timestampMs(entry) === maxMs).map((e) => e.id))
      }

      await control.sleep(intervalMs)
    }
  } finally {
    control.dispose()
  }
  return 0
}

export function buildQuery(
  args: ParsedArgs,
  opts: { omitWindow?: boolean } = {},
): Record<string, string> {
  const query: Record<string, string> = {}
  const env = getStringFlag(args, "env", "environment")
  if (env) query.environment = env
  const level = getStringFlag(args, "level")
  if (level) query.level = level
  const search = getStringFlag(args, "search")
  if (search) query.q = search

  if (opts.omitWindow) return query

  const sinceMs = parseSince(getStringFlag(args, "since"))
  const from = getStringFlag(args, "from")
  const to = getStringFlag(args, "to")
  if (from) query.from = from
  else if (sinceMs !== undefined) query.from = String(Date.now() - sinceMs)
  if (to) query.to = to
  return query
}

/** Parse an absolute time (epoch ms or ISO string) into epoch milliseconds. */
export function parseTimeMs(value: string): number | undefined {
  const ms = Number(value)
  if (Number.isFinite(ms)) return ms
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Parse a relative duration like `30s`, `15m`, `2h`, `1d` into milliseconds. */
export function parseSince(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  const unit = match[2] ?? "s"
  const scale = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]
  return scale ? amount * scale : undefined
}

export function formatLine(entry: RuntimeLogEntry): string {
  return `${formatTimestamp(entry.timestamp)}  ${entry.level.toUpperCase().padEnd(5)}  ${entry.message}`
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, "0")
  const ms = String(date.getMilliseconds()).padStart(3, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${ms}`
}

function sortAscending(entries: RuntimeLogEntry[]): RuntimeLogEntry[] {
  return [...entries].sort((a, b) => timestampMs(a) - timestampMs(b))
}

function timestampMs(entry: RuntimeLogEntry): number {
  const ms = Date.parse(entry.timestamp)
  return Number.isNaN(ms) ? 0 : ms
}

function followIntervalMs(args: ParsedArgs): number {
  const raw = getStringFlag(args, "interval")
  const seconds = raw ? Number(raw) : undefined
  if (seconds && Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000)
  }
  return DEFAULT_FOLLOW_INTERVAL_MS
}

interface InterruptControl {
  readonly aborted: boolean
  sleep(ms: number): Promise<void>
  dispose(): void
}

/** Wire SIGINT so `--follow` stops cleanly on Ctrl-C instead of a hard kill. */
function installInterrupt(): InterruptControl {
  let aborted = false
  let wake: (() => void) | null = null
  const onSignal = () => {
    aborted = true
    wake?.()
  }
  process.once("SIGINT", onSignal)

  return {
    get aborted() {
      return aborted
    },
    sleep(ms: number) {
      if (aborted) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve()
        }, ms)
        wake = () => {
          clearTimeout(timer)
          wake = null
          resolve()
        }
      })
    },
    dispose() {
      process.removeListener("SIGINT", onSignal)
    },
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
