import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { connectorCommand, validateConnectorManifest } from "../../src/commands/connector.js"

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    key: "acme.connector",
    displayName: "Acme Connector",
    authModel: "platform_managed",
    accessModel: "approval_required",
    capabilities: ["availability"],
    categoryCoverage: ["lodging"],
    supportedDirections: ["outbound"],
    metadata: {
      externalAdapter: {
        type: "external_adapter",
        baseUrl: "https://adapter.test",
      },
    },
    ...overrides,
  }
}

function makeCtx(cwd: string, argv: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    ctx: {
      argv,
      cwd,
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
    stdout,
    stderr,
  }
}

function writeManifest(root: string, value = manifest()) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "connector.json"), JSON.stringify(value, null, 2))
}

function mockFetch(
  routes: Array<{ match: string; method?: string; status?: number; body: unknown }>,
) {
  const calls: Array<{ url: string; method: string; body?: BodyInit | null }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ url, method, body: init?.body })
    const route = routes.find((r) => url.includes(r.match) && (!r.method || r.method === method))
    if (!route)
      return new Response(JSON.stringify({ error: "not mocked", code: "not_found" }), {
        status: 404,
      })
    const body =
      url.includes("/.well-known/voyant-connect/manifest") || (route.status && route.status >= 400)
        ? route.body
        : { data: route.body }
    return new Response(JSON.stringify(body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return calls
}

describe("connector command", () => {
  let prevFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    prevFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = prevFetch as typeof globalThis.fetch
  })

  it("validates connector manifests and reports field errors", () => {
    expect(validateConnectorManifest(manifest()).key).toBe("acme.connector")
    expect(() =>
      validateConnectorManifest(
        manifest({
          key: "Bad Key",
          capabilities: [],
          metadata: { hostedWorker: { script: "worker" } },
        }),
      ),
    ).toThrow(/metadata.externalAdapter: is required/)
  })

  it("rejects invalid external adapter URLs and hosted worker overlap", () => {
    expect(() =>
      validateConnectorManifest(
        manifest({
          metadata: {
            externalAdapter: {
              type: "external_adapter",
              baseUrl: "https://user:pass@adapter.test/path?x=1#frag",
            },
            hostedWorker: {},
          },
        }),
      ),
    ).toThrow(/credentials, query, or fragment/)
  })

  it("validates with a successful well-known probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "voyant-connector-probe-"))
    writeManifest(root)
    mockFetch([
      {
        match: "/.well-known/voyant-connect/manifest",
        body: { key: "acme.connector" },
      },
    ])

    const { ctx, stdout } = makeCtx(root, ["validate", "connector.json", "--probe"])
    expect(await connectorCommand(ctx)).toBe(0)
    expect(stdout.join("")).toContain("key matches acme.connector")
  })

  it("treats an absent well-known probe as non-fatal", async () => {
    const root = mkdtempSync(join(tmpdir(), "voyant-connector-probe-404-"))
    writeManifest(root)
    mockFetch([
      {
        match: "/.well-known/voyant-connect/manifest",
        status: 404,
        body: { error: "missing", code: "not_found" },
      },
    ])

    const { ctx, stdout } = makeCtx(root, ["validate", "connector.json", "--probe"])
    expect(await connectorCommand(ctx)).toBe(0)
    expect(stdout.join("")).toContain("continuing because this well-known endpoint is optional")
  })

  it("registers connector providers and prints the one-time signing secret", async () => {
    const root = mkdtempSync(join(tmpdir(), "voyant-connector-register-"))
    writeManifest(root)
    const calls = mockFetch([
      {
        match: "/connect/v1/connector-providers",
        method: "POST",
        body: { key: "acme.connector", signingSecret: "signing_secret_once" },
      },
    ])

    const { ctx, stdout } = makeCtx(root, [
      "register",
      "connector.json",
      "--token",
      "tok",
      "--api-url",
      "https://api.test",
    ])
    expect(await connectorCommand(ctx)).toBe(0)
    expect(stdout.join("")).toContain("shown once, store it now")
    expect(stdout.join("")).toContain("signing_secret_once")
    expect(calls[0]?.method).toBe("POST")
  })

  it("maps register 403 and 409 responses", async () => {
    const root = mkdtempSync(join(tmpdir(), "voyant-connector-errors-"))
    writeManifest(root)
    mockFetch([
      {
        match: "/connect/v1/connector-providers",
        method: "POST",
        status: 403,
        body: { error: "forbidden", code: "forbidden" },
      },
    ])
    const forbidden = makeCtx(root, [
      "register",
      "connector.json",
      "--token",
      "tok",
      "--api-url",
      "https://api.test",
    ])
    expect(await connectorCommand(forbidden.ctx)).toBe(1)
    expect(forbidden.stderr.join("")).toContain("connect:providers:write")

    mockFetch([
      {
        match: "/connect/v1/connector-providers",
        method: "POST",
        status: 409,
        body: { error: "conflict", code: "conflict" },
      },
    ])
    const conflict = makeCtx(root, [
      "register",
      "connector.json",
      "--token",
      "tok",
      "--api-url",
      "https://api.test",
    ])
    expect(await connectorCommand(conflict.ctx)).toBe(1)
    expect(conflict.stderr.join("")).toContain("already exists")
  })
})
