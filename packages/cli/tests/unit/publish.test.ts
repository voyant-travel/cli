import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createExtensionBundleArchive,
  publishCommand,
  validateExtensionManifest,
} from "../../src/commands/publish.js"

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "voyant.extension-manifest.v1",
    key: "acme.widget",
    displayName: "Acme Widget",
    version: "1.2.3",
    extensionApi: "^1.0.0",
    entry: "index.js",
    targets: [{ slot: "dashboard.header" }],
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
    return new Response(JSON.stringify({ data: route.body }), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return calls
}

describe("publish command", () => {
  let prevFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    prevFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = prevFetch as typeof globalThis.fetch
  })

  it("validates extension manifests with per-field errors", () => {
    expect(validateExtensionManifest(manifest()).key).toBe("acme.widget")
    expect(() =>
      validateExtensionManifest(
        manifest({
          key: "Bad Key",
          version: "latest",
          targets: [{ slot: "unknown.slot" }],
        }),
      ),
    ).toThrow(/key: must use lowercase/)
  })

  it("creates a normalized ustar gzip bundle and requires the entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "voyant-publish-test-"))
    const dist = join(root, "dist")
    mkdirSync(join(dist, "nested"), { recursive: true })
    writeFileSync(join(dist, "index.js"), "export default {}")
    writeFileSync(join(dist, "nested", "view.js"), "export const view = true")

    const archive = await createExtensionBundleArchive(dist, "index.js")
    const names = tarNames(gunzipSync(archive))
    expect(names).toEqual(["index.js", "nested/view.js"])
    await expect(createExtensionBundleArchive(dist, "missing.js")).rejects.toThrow(
      /entry not found/,
    )
  })

  it("enforces the 5MB gzipped bundle cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "voyant-publish-cap-"))
    const dist = join(root, "dist")
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, "index.js"), randomBytes(5 * 1024 * 1024 + 256 * 1024))

    await expect(createExtensionBundleArchive(dist, "index.js")).rejects.toThrow(
      /maximum is 5.00MB/,
    )
  })

  it("creates unknown extension keys and publishes multipart versions", async () => {
    const root = mkdtempSync(join(tmpdir(), "voyant-publish-flow-"))
    const dist = join(root, "dist")
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(root, "voyant-extension.json"), JSON.stringify(manifest(), null, 2))
    writeFileSync(join(dist, "index.js"), "export default {}")
    const calls = mockFetch([
      {
        match: "/cloud/v1/extensions/acme.widget",
        method: "GET",
        status: 404,
        body: { error: "missing", code: "not_found" },
      },
      { match: "/cloud/v1/extensions", method: "POST", body: { key: "acme.widget" } },
      {
        match: "/cloud/v1/extensions/acme.widget/versions",
        method: "POST",
        body: { id: "ver_1" },
      },
    ])

    const { ctx, stdout } = makeCtx(root, [
      "--token",
      "tok",
      "--api-url",
      "https://api.test",
      "--yes",
    ])
    expect(await publishCommand(ctx)).toBe(0)
    expect(stdout.join("")).toContain("Published acme.widget@1.2.3")
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"])
    expect(calls[2]?.body).toBeInstanceOf(FormData)
  })
})

function tarNames(buffer: Buffer): string[] {
  const names: string[] = []
  for (let offset = 0; offset < buffer.byteLength; offset += 512) {
    const name = buffer
      .subarray(offset, offset + 100)
      .toString("utf8")
      .replace(/\0.*$/, "")
    if (!name) break
    const sizeText = buffer
      .subarray(offset + 124, offset + 136)
      .toString("ascii")
      .replace(/\0.*$/, "")
      .trim()
    names.push(name)
    const size = Number.parseInt(sizeText || "0", 8)
    offset += Math.ceil(size / 512) * 512
  }
  return names
}
