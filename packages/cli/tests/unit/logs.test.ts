import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  buildQuery,
  formatLine,
  logsCommand,
  parseSince,
  parseTimeMs,
  type RuntimeLogEntry,
} from "../../src/commands/logs.js"
import { parseArgs } from "../../src/lib/args.js"

function makeCtx(argv: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    ctx: {
      argv,
      cwd: process.cwd(),
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
    stdout,
    stderr,
  }
}

function page(entries: RuntimeLogEntry[], unavailable = false) {
  return {
    data: {
      entries,
      windowStart: "2026-06-18T00:00:00.000Z",
      windowEnd: "2026-06-18T01:00:00.000Z",
      unavailable,
    },
  }
}

const SAMPLE: RuntimeLogEntry[] = [
  {
    id: "b",
    timestamp: "2026-06-18T00:30:00.000Z",
    level: "error",
    message: "boom",
  },
  {
    id: "a",
    timestamp: "2026-06-18T00:10:00.000Z",
    level: "info",
    message: "served",
  },
]

describe("logsCommand", () => {
  let prevFetch: typeof globalThis.fetch | undefined
  let prevApiKey: string | undefined
  let lastUrl: string | null

  beforeEach(() => {
    prevFetch = globalThis.fetch
    prevApiKey = process.env.VOYANT_CLOUD_API_KEY
    lastUrl = null
  })

  afterEach(() => {
    if (prevFetch === undefined) {
      globalThis.fetch = undefined as unknown as typeof globalThis.fetch
    } else {
      globalThis.fetch = prevFetch
    }
    if (prevApiKey === undefined) delete process.env.VOYANT_CLOUD_API_KEY
    else process.env.VOYANT_CLOUD_API_KEY = prevApiKey
  })

  function stubFetch(body: unknown, status = 200) {
    globalThis.fetch = (async (url: string | URL) => {
      lastUrl = String(url)
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch
  }

  it("prints usage and fails without an app", async () => {
    const { ctx, stdout } = makeCtx([])
    const code = await logsCommand(ctx)
    expect(code).toBe(1)
    expect(stdout.join("")).toContain("Usage: voyant logs <app>")
  })

  it("rejects an invalid level", async () => {
    const { ctx, stderr } = makeCtx(["my-app", "--level", "fatal", "--token", "tok"])
    const code = await logsCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain('Invalid --level "fatal"')
  })

  it("prints logs oldest-first in human form", async () => {
    stubFetch(page(SAMPLE))
    const { ctx, stdout } = makeCtx(["my-app", "--token", "tok"])
    const code = await logsCommand(ctx)
    expect(code).toBe(0)
    const lines = stdout.join("").trimEnd().split("\n")
    expect(lines[0]).toContain("INFO")
    expect(lines[0]).toContain("served")
    expect(lines[1]).toContain("ERROR")
    expect(lines[1]).toContain("boom")
  })

  it("outputs JSON with --json", async () => {
    stubFetch(page(SAMPLE))
    const { ctx, stdout } = makeCtx(["my-app", "--token", "tok", "--json"])
    const code = await logsCommand(ctx)
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.join("")) as RuntimeLogEntry[]
    expect(parsed.map((e) => e.id)).toEqual(["a", "b"])
  })

  it("forwards level and since as query params", async () => {
    stubFetch(page([]))
    const { ctx } = makeCtx(["my-app", "--token", "tok", "--level", "error", "--since", "1h"])
    await logsCommand(ctx)
    expect(lastUrl).toContain("/cloud/v1/apps/my-app/runtime-logs")
    expect(lastUrl).toContain("level=error")
    expect(lastUrl).toContain("from=")
  })

  it("forwards --search as the q query param", async () => {
    stubFetch(page([]))
    const { ctx } = makeCtx(["my-app", "--token", "tok", "--search", "timeout"])
    await logsCommand(ctx)
    expect(lastUrl).toContain("q=timeout")
  })

  it("reports an unavailable window without failing", async () => {
    stubFetch(page([], true))
    const { ctx, stderr } = makeCtx(["my-app", "--token", "tok"])
    const code = await logsCommand(ctx)
    expect(code).toBe(0)
    expect(stderr.join("")).toContain("aren't available")
  })

  it("prints a friendly message with no logs", async () => {
    stubFetch(page([]))
    const { ctx, stdout } = makeCtx(["my-app", "--token", "tok"])
    const code = await logsCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("No logs in the selected window.")
  })

  it("surfaces transport failures", async () => {
    stubFetch("Unauthorized", 401)
    const { ctx, stderr } = makeCtx(["my-app", "--token", "tok_bad"])
    const code = await logsCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Failed to fetch logs")
  })

  it("surfaces missing credentials cleanly", async () => {
    delete process.env.VOYANT_CLOUD_API_KEY
    const { ctx, stderr } = makeCtx(["my-app", "--api-url", "https://offline.example"])
    const code = await logsCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("No Voyant Cloud credentials")
  })
})

describe("parseSince", () => {
  it("parses duration units into ms", () => {
    expect(parseSince("30s")).toBe(30_000)
    expect(parseSince("15m")).toBe(900_000)
    expect(parseSince("2h")).toBe(7_200_000)
    expect(parseSince("1d")).toBe(86_400_000)
    expect(parseSince("45")).toBe(45_000) // bare number → seconds
  })

  it("returns undefined for junk", () => {
    expect(parseSince(undefined)).toBeUndefined()
    expect(parseSince("soon")).toBeUndefined()
  })
})

describe("parseTimeMs", () => {
  it("accepts epoch ms and ISO strings", () => {
    expect(parseTimeMs("1750200000000")).toBe(1750200000000)
    expect(parseTimeMs("2026-06-18T00:00:00.000Z")).toBe(Date.parse("2026-06-18T00:00:00.000Z"))
  })

  it("returns undefined for junk", () => {
    expect(parseTimeMs("not-a-time")).toBeUndefined()
  })
})

describe("buildQuery", () => {
  it("omits the window when requested (follow mode)", () => {
    const args = parseArgs(["--level", "warn", "--since", "1h", "--env", "preview"])
    const query = buildQuery(args, { omitWindow: true })
    expect(query).toEqual({ level: "warn", environment: "preview" })
  })
})

describe("formatLine", () => {
  it("renders timestamp, padded level, and message", () => {
    const line = formatLine({
      id: "x",
      timestamp: "2026-06-18T00:10:00.000Z",
      level: "warn",
      message: "slow query",
    })
    expect(line).toMatch(/WARN /)
    expect(line).toContain("slow query")
  })
})
