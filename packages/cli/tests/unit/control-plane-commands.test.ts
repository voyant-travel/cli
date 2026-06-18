import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { appsCommand } from "../../src/commands/apps.js"
import { databasesCommand } from "../../src/commands/databases.js"
import { envCommand } from "../../src/commands/env.js"

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

/** Route mocked responses by URL substring + method. */
function mockFetch(
  routes: Array<{ match: string; method?: string; status?: number; body: unknown }>,
) {
  const calls: Array<{ url: string; method: string }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ url, method })
    const route = routes.find((r) => url.includes(r.match) && (!r.method || r.method === method))
    if (!route) return new Response("not mocked", { status: 404 })
    return new Response(JSON.stringify({ data: route.body }), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return calls
}

describe("control-plane commands", () => {
  let prevFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    prevFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = prevFetch as typeof globalThis.fetch
  })

  it("apps list prints slug/status/name", async () => {
    mockFetch([
      { match: "/cloud/v1/apps", body: [{ slug: "web", status: "active", displayName: "Web" }] },
    ])
    const { ctx, stdout } = makeCtx(["list", "--token", "tok", "--api-url", "https://api.test"])
    expect(await appsCommand(ctx)).toBe(0)
    expect(stdout.join("")).toContain("web")
    expect(stdout.join("")).toContain("Web")
  })

  it("apps maps an auth failure to a not_authenticated JSON error", async () => {
    const { ctx, stderr } = makeCtx(["list", "--api-url", "https://offline.test", "--json"])
    delete process.env.VOYANT_CLOUD_API_KEY
    expect(await appsCommand(ctx)).toBe(1)
    expect(JSON.parse(stderr.join("")).error.code).toBe("not_authenticated")
  })

  it("env list resolves the environment name to its id before listing vars", async () => {
    const calls = mockFetch([
      // More specific match first — the env-vars URL also contains "/environments".
      {
        match: "/env-vars",
        body: [{ id: "v1", key: "K", value: "***", isSecret: true, usedAt: "both" }],
      },
      { match: "/environments", body: [{ id: "env_42", name: "production" }] },
    ])
    const { ctx, stdout } = makeCtx([
      "list",
      "web",
      "--env",
      "production",
      "--token",
      "tok",
      "--api-url",
      "https://api.test",
    ])
    expect(await envCommand(ctx)).toBe(0)
    expect(stdout.join("")).toContain("K=***")
    expect(calls.some((c) => c.url.includes("/environments/env_42/env-vars"))).toBe(true)
  })

  it("databases connection prints the bare URL", async () => {
    mockFetch([{ match: "/connection", body: { connectionUrl: "postgres://x" } }])
    const { ctx, stdout } = makeCtx([
      "connection",
      "db_1",
      "--token",
      "tok",
      "--api-url",
      "https://api.test",
    ])
    expect(await databasesCommand(ctx)).toBe(0)
    expect(stdout.join("")).toBe("postgres://x")
  })
})
