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

describe("extensions command", () => {
  let prevFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    prevFetch = globalThis.fetch
    vi.clearAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = prevFetch as typeof globalThis.fetch
  })

  it("lists extensions with a filter", async () => {
    mockExtensions.list.mockResolvedValue([
      {
        key: "acme-widget",
        latestVersion: "1.2.3",
        visibility: "private",
        displayName: "Acme Widget",
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
    expect(stdout.join("")).toContain("acme-widget")
    expect(mockExtensions.list).toHaveBeenCalledWith("mine")
  })

  it("prints extension installs", async () => {
    mockExtensions.listInstalls.mockResolvedValue([
      { key: "acme-widget", appSlug: "web", environment: "production", latestVersion: "1.2.3" },
    ])
    const { ctx, stdout } = makeCtx(["installs", "--token", "tok", "--api-url", "https://api.test"])

    expect(await extensionsCommand(ctx)).toBe(0)
    expect(stdout.join("")).toContain("web")
    expect(stdout.join("")).toContain("production")
  })
})
