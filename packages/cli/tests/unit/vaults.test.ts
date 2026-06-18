import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { vaultsCommand } from "../../src/commands/vaults.js"

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

const SAMPLE_VAULTS = [
  {
    id: "vlt_1",
    slug: "production",
    name: "Production",
    description: null,
    secretCount: 12,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "vlt_2",
    slug: "staging",
    name: "Staging",
    description: "Pre-prod secrets",
    secretCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
]

describe("vaultsCommand", () => {
  let prevFetch: typeof globalThis.fetch | undefined
  let prevApiKey: string | undefined

  beforeEach(() => {
    prevFetch = globalThis.fetch
    prevApiKey = process.env.VOYANT_CLOUD_API_KEY
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

  it("prints usage without a subcommand", async () => {
    const { ctx, stdout } = makeCtx([])
    const code = await vaultsCommand(ctx)
    expect(code).toBe(1)
    expect(stdout.join("")).toContain("Usage: voyant vaults")
  })

  it("errors on unknown subcommand", async () => {
    const { ctx, stderr } = makeCtx(["bogus"])
    const code = await vaultsCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Unknown vaults subcommand: bogus")
  })

  it("lists vaults in human-readable form", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(SAMPLE_VAULTS), {
        status: 200,
        headers: { "content-type": "application/json" },
      })

    const { ctx, stdout } = makeCtx(["list", "--token", "tok"])
    const code = await vaultsCommand(ctx)
    expect(code).toBe(0)
    const text = stdout.join("")
    expect(text).toContain("production — Production (12 secrets)")
    expect(text).toContain("staging — Staging (1 secret)")
  })

  it("lists vaults as JSON when --json is passed", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(SAMPLE_VAULTS), {
        status: 200,
        headers: { "content-type": "application/json" },
      })

    const { ctx, stdout } = makeCtx(["list", "--token", "tok", "--json"])
    const code = await vaultsCommand(ctx)
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.join("")) as Array<{ slug: string }>
    expect(parsed.map((v) => v.slug)).toEqual(["production", "staging"])
  })

  it("prints a friendly message when there are no vaults", async () => {
    globalThis.fetch = async () =>
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } })

    const { ctx, stdout } = makeCtx(["list", "--token", "tok"])
    const code = await vaultsCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("No vaults found.")
  })

  it("surfaces transport failures", async () => {
    globalThis.fetch = async () =>
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })

    const { ctx, stderr } = makeCtx(["list", "--token", "tok_bad"])
    const code = await vaultsCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Unauthorized")
  })

  it("surfaces missing-credentials as a clean error", async () => {
    delete process.env.VOYANT_CLOUD_API_KEY
    const { ctx, stderr } = makeCtx(["list", "--api-url", "https://offline.example"])
    // No --token, no env, and no credentials file at the default path for
    // this URL → CloudAuthError.
    const code = await vaultsCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("No Voyant Cloud credentials")
  })
})
