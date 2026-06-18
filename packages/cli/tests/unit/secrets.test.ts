import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { secretsCommand } from "../../src/commands/secrets.js"

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

const SAMPLE_SECRETS = [
  {
    key: "DATABASE_URL",
    version: 3,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
  },
  {
    key: "STRIPE_KEY",
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
]

describe("secretsCommand", () => {
  let prevFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    prevFetch = globalThis.fetch
  })

  afterEach(() => {
    if (prevFetch === undefined) {
      globalThis.fetch = undefined as unknown as typeof globalThis.fetch
    } else {
      globalThis.fetch = prevFetch
    }
  })

  it("prints usage without a subcommand", async () => {
    const { ctx, stdout } = makeCtx([])
    const code = await secretsCommand(ctx)
    expect(code).toBe(1)
    expect(stdout.join("")).toContain("Usage: voyant secrets <list|set|rm>")
  })

  it("errors on unknown subcommand", async () => {
    const { ctx, stderr } = makeCtx(["bogus"])
    const code = await secretsCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Unknown secrets subcommand: bogus")
  })

  describe("list", () => {
    it("errors without a vault arg", async () => {
      const { ctx, stderr } = makeCtx(["list", "--token", "tok"])
      const code = await secretsCommand(ctx)
      expect(code).toBe(1)
      expect(stderr.join("")).toContain("Usage: voyant secrets list <vault>")
    })

    it("lists secret keys with version + updatedAt", async () => {
      let calledUrl: string | undefined
      globalThis.fetch = async (input) => {
        calledUrl = String(input)
        return new Response(JSON.stringify(SAMPLE_SECRETS), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      const { ctx, stdout } = makeCtx(["list", "production", "--token", "tok"])
      const code = await secretsCommand(ctx)
      expect(code).toBe(0)
      expect(calledUrl).toContain("/vault/v1/production/secrets")
      const text = stdout.join("")
      expect(text).toContain("DATABASE_URL  v3")
      expect(text).toContain("STRIPE_KEY  v1")
    })

    it("--json prints the raw array", async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify(SAMPLE_SECRETS), {
          status: 200,
          headers: { "content-type": "application/json" },
        })

      const { ctx, stdout } = makeCtx(["list", "production", "--token", "tok", "--json"])
      const code = await secretsCommand(ctx)
      expect(code).toBe(0)
      const parsed = JSON.parse(stdout.join("")) as Array<{ key: string }>
      expect(parsed.map((s) => s.key)).toEqual(["DATABASE_URL", "STRIPE_KEY"])
    })

    it("prints a friendly message when the vault is empty", async () => {
      globalThis.fetch = async () =>
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } })

      const { ctx, stdout } = makeCtx(["list", "production", "--token", "tok"])
      const code = await secretsCommand(ctx)
      expect(code).toBe(0)
      expect(stdout.join("")).toContain("No secrets in production.")
    })

    it("surfaces transport failures", async () => {
      globalThis.fetch = async () =>
        new Response("Forbidden", { status: 403, statusText: "Forbidden" })

      const { ctx, stderr } = makeCtx(["list", "production", "--token", "tok"])
      const code = await secretsCommand(ctx)
      expect(code).toBe(1)
      expect(stderr.join("")).toContain("Forbidden")
    })
  })

  describe("get (removed — the CLI cannot decrypt)", () => {
    it("refuses with a clear message and never calls the network", async () => {
      let called = false
      globalThis.fetch = async () => {
        called = true
        return new Response("{}", { status: 200 })
      }
      const { ctx, stderr } = makeCtx(["get", "production", "DATABASE_URL", "--token", "tok"])
      const code = await secretsCommand(ctx)
      expect(code).toBe(1)
      expect(stderr.join("")).toContain("cannot decrypt secrets")
      expect(called).toBe(false)
    })
  })

  describe("set", () => {
    it("errors without vault and key", async () => {
      const { ctx, stderr } = makeCtx(["set", "production", "--token", "tok"])
      const code = await secretsCommand(ctx)
      expect(code).toBe(1)
      expect(stderr.join("")).toContain("Usage: voyant secrets set <vault> <key>")
    })

    it("POSTs the value and prints the new version (plain mode)", async () => {
      let calledUrl: string | undefined
      let calledMethod: string | undefined
      let calledBody: string | undefined
      globalThis.fetch = async (input, init) => {
        calledUrl = String(input)
        calledMethod = init?.method
        calledBody = init?.body as string
        return new Response(
          JSON.stringify({
            key: "STRIPE_KEY",
            version: 2,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-04-30T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }

      const { ctx, stdout } = makeCtx([
        "set",
        "production",
        "STRIPE_KEY",
        "sk_live_xyz",
        "--token",
        "tok",
      ])
      const code = await secretsCommand(ctx)
      expect(code).toBe(0)
      expect(calledMethod).toBe("POST")
      expect(calledUrl).toContain("/vault/v1/production/secrets/STRIPE_KEY")
      expect(calledBody).toContain("sk_live_xyz")
      expect(stdout.join("")).toContain("Set production/STRIPE_KEY (v2)")
    })

    it("--json prints the response envelope", async () => {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            key: "K",
            version: 1,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        )

      const { ctx, stdout } = makeCtx([
        "set",
        "production",
        "K",
        "value",
        "--token",
        "tok",
        "--json",
      ])
      const code = await secretsCommand(ctx)
      expect(code).toBe(0)
      const parsed = JSON.parse(stdout.join("")) as {
        key: string
        version: number
      }
      expect(parsed.key).toBe("K")
      expect(parsed.version).toBe(1)
    })

    it("surfaces transport failures", async () => {
      globalThis.fetch = async () =>
        new Response("Forbidden", { status: 403, statusText: "Forbidden" })

      const { ctx, stderr } = makeCtx(["set", "production", "K", "value", "--token", "tok"])
      const code = await secretsCommand(ctx)
      expect(code).toBe(1)
      expect(stderr.join("")).toContain("Forbidden")
    })
  })

  describe("rm", () => {
    it("errors without vault and key", async () => {
      const { ctx, stderr } = makeCtx(["rm", "production", "--token", "tok"])
      const code = await secretsCommand(ctx)
      expect(code).toBe(1)
      expect(stderr.join("")).toContain("Usage: voyant secrets rm <vault> <key>")
    })

    it("DELETEs and prints confirmation", async () => {
      let calledUrl: string | undefined
      let calledMethod: string | undefined
      globalThis.fetch = async (input, init) => {
        calledUrl = String(input)
        calledMethod = init?.method
        return new Response(null, { status: 204 })
      }

      const { ctx, stdout } = makeCtx(["rm", "production", "STRIPE_KEY", "--token", "tok"])
      const code = await secretsCommand(ctx)
      expect(code).toBe(0)
      expect(calledMethod).toBe("DELETE")
      expect(calledUrl).toContain("/vault/v1/production/secrets/STRIPE_KEY")
      expect(stdout.join("")).toContain("Deleted production/STRIPE_KEY")
    })

    it("surfaces 404 from a missing secret", async () => {
      globalThis.fetch = async () =>
        new Response("Not Found", { status: 404, statusText: "Not Found" })

      const { ctx, stderr } = makeCtx(["rm", "production", "MISSING", "--token", "tok"])
      const code = await secretsCommand(ctx)
      expect(code).toBe(1)
      expect(stderr.join("")).toContain("Not Found")
    })
  })
})
