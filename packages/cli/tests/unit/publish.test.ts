import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

import { VoyantApiError } from "@voyant-travel/cloud-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockExtensions = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  listInstalls: vi.fn(),
  publishVersion: vi.fn(),
}))

vi.mock("@voyant-travel/cloud-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@voyant-travel/cloud-sdk")>()
  return {
    ...actual,
    getVoyantCloudClient: vi.fn(() => ({
      extensions: mockExtensions,
    })),
  }
})

import {
  createExtensionBundleArchive,
  publishCommand,
  validateExtensionManifest,
} from "../../src/commands/publish.js"

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "voyant.extension-manifest.v1",
    key: "acme-widget",
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

describe("publish command", () => {
  let prevFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    prevFetch = globalThis.fetch
    vi.clearAllMocks()
    mockExtensions.create.mockResolvedValue({ key: "acme-widget" })
    mockExtensions.publishVersion.mockResolvedValue({ id: "ver_1" })
  })

  afterEach(() => {
    globalThis.fetch = prevFetch as typeof globalThis.fetch
  })

  it("validates extension manifests with per-field errors", () => {
    expect(validateExtensionManifest(manifest()).key).toBe("acme-widget")
    expect(validateExtensionManifest(manifest({ key: "0".repeat(64) })).key).toBe("0".repeat(64))
    expect(() =>
      validateExtensionManifest(
        manifest({
          key: "Bad Key",
          version: "latest",
          targets: [{ slot: "unknown.slot" }],
        }),
      ),
    ).toThrow(/key: must use lowercase letters/)
    expect(() => validateExtensionManifest(manifest({ key: "acme.widget" }))).toThrow(
      /key: must use lowercase letters/,
    )
    expect(() => validateExtensionManifest(manifest({ key: "acme_widget" }))).toThrow(
      /key: must use lowercase letters/,
    )
    expect(() => validateExtensionManifest(manifest({ key: `${"a".repeat(64)}b` }))).toThrow(
      /key: must use lowercase letters/,
    )
  })

  it("validates supported extensionApi range forms", () => {
    for (const extensionApi of ["*", "1", "1.2", "1.2.3", "1.x", "1.2.x", "^1", "^1.2", "^1.2.3"]) {
      expect(validateExtensionManifest(manifest({ extensionApi })).extensionApi).toBe(extensionApi)
    }
    for (const extensionApi of ["~1.2.3", ">=1.0.0", "1.*", "^1.x", "v1.2.3"]) {
      expect(() => validateExtensionManifest(manifest({ extensionApi }))).toThrow(
        /extensionApi: must be one of/,
      )
    }
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
    mockExtensions.get.mockRejectedValue(
      new VoyantApiError("missing", {
        body: { error: "missing", code: "not_found" },
        code: "not_found",
        requestId: null,
        status: 404,
      }),
    )

    const { ctx, stdout } = makeCtx(root, [
      "--token",
      "tok",
      "--api-url",
      "https://api.test",
      "--yes",
    ])
    expect(await publishCommand(ctx)).toBe(0)
    expect(stdout.join("")).toContain("Published acme-widget@1.2.3")
    expect(mockExtensions.create).toHaveBeenCalledWith({
      key: "acme-widget",
      displayName: "Acme Widget",
      description: undefined,
    })
    expect(mockExtensions.publishVersion).toHaveBeenCalledWith("acme-widget", {
      manifest: manifest(),
      bundle: expect.any(Uint8Array),
    })
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
