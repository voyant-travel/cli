import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { extensionsCommand } from "../../src/commands/extensions.js"

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

function mockFetch(routes: Array<{ match: string; method?: string; body: unknown }>) {
  const calls: Array<{ url: string; method: string }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ url, method })
    const route = routes.find((r) => url.includes(r.match) && (!r.method || r.method === method))
    if (!route) return new Response("not mocked", { status: 404 })
    return new Response(JSON.stringify({ data: route.body }), {
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return calls
}

describe("extensions command", () => {
  let prevFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    prevFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = prevFetch as typeof globalThis.fetch
  })

  it("lists extensions with a filter", async () => {
    const calls = mockFetch([
      {
        match: "/cloud/v1/extensions",
        body: [
          {
            key: "acme.widget",
            latestVersion: "1.2.3",
            visibility: "private",
            displayName: "Acme Widget",
          },
        ],
      },
    ])
    const { ctx, stdout } = makeCtx([
      "list",
      "--filter",
      "mine",
      "--token",
      "tok",
      "--api-url",
      "https://api.test",
    ])

    expect(await extensionsCommand(ctx)).toBe(0)
    expect(stdout.join("")).toContain("acme.widget")
    expect(calls[0]?.url).toContain("filter=mine")
  })

  it("prints extension installs", async () => {
    mockFetch([
      {
        match: "/cloud/v1/extensions/installs",
        body: [
          { key: "acme.widget", appSlug: "web", environment: "production", latestVersion: "1.2.3" },
        ],
      },
    ])
    const { ctx, stdout } = makeCtx(["installs", "--token", "tok", "--api-url", "https://api.test"])

    expect(await extensionsCommand(ctx)).toBe(0)
    expect(stdout.join("")).toContain("web")
    expect(stdout.join("")).toContain("production")
  })
})
