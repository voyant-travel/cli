import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { loginCommand } from "../../src/commands/login.js"
import { resolveOrgCredential } from "../../src/lib/credentials.js"

// Test shim: read back whichever org credential was just stored.
const getCredential = (apiUrl: string) => resolveOrgCredential(apiUrl, undefined)

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

describe("loginCommand", () => {
  let tmp: string
  let prevCredFile: string | undefined
  let prevFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-login-"))
    prevCredFile = process.env.VOYANT_CREDENTIALS_FILE
    process.env.VOYANT_CREDENTIALS_FILE = join(tmp, "credentials.json")
    prevFetch = globalThis.fetch
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    if (prevCredFile === undefined) delete process.env.VOYANT_CREDENTIALS_FILE
    else process.env.VOYANT_CREDENTIALS_FILE = prevCredFile
    if (prevFetch === undefined) {
      globalThis.fetch = undefined as unknown as typeof globalThis.fetch
    } else {
      globalThis.fetch = prevFetch
    }
  })

  it("validates and stores the token on success", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })

    const { ctx, stdout } = makeCtx(["--token", "tok_abc", "--api-url", "https://api.test"])
    const code = await loginCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("Logged in to https://api.test")

    const stored = getCredential("https://api.test")
    expect(stored?.accessToken).toBe("tok_abc")
    expect(stored?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("rejects a 401 token without storing it", async () => {
    globalThis.fetch = async () =>
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })

    const { ctx, stderr } = makeCtx(["--token", "tok_bad", "--api-url", "https://api.test"])
    const code = await loginCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Token rejected by https://api.test")
    expect(getCredential("https://api.test")).toBeUndefined()
  })

  it("--no-validate skips the network check and stores anyway", async () => {
    globalThis.fetch = async () => {
      throw new Error("fetch should not be called")
    }

    const { ctx, stdout } = makeCtx([
      "--token",
      "tok_skip",
      "--api-url",
      "https://api.test",
      "--no-validate",
    ])
    const code = await loginCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("Logged in to https://api.test")
    expect(getCredential("https://api.test")?.accessToken).toBe("tok_skip")
  })

  describe("device-code flow (no --token)", () => {
    function mockDeviceFlow(pollResponses: Array<{ status?: number; body: unknown }>) {
      const authorizeBody = {
        device_code: "dev_secret",
        user_code: "ABCD-1234",
        verification_uri: "https://api.test/cli",
        verification_uri_complete: "https://api.test/cli?user_code=ABCD-1234",
        expires_in: 600,
        interval: 0,
      }

      let pollCursor = 0
      globalThis.fetch = async (input) => {
        const url = String(input)
        if (url.endsWith("/cli/v1/device/authorize")) {
          return new Response(JSON.stringify(authorizeBody), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.endsWith("/cli/v1/device/token")) {
          const r = pollResponses[pollCursor]
          pollCursor += 1
          if (!r) throw new Error("No more poll responses queued")
          return new Response(JSON.stringify(r.body), {
            status: r.status ?? 200,
            headers: { "content-type": "application/json" },
          })
        }
        throw new Error(`Unexpected URL in test: ${url}`)
      }
    }

    it("stores token + org + user from a successful poll", async () => {
      mockDeviceFlow([
        { status: 400, body: { error: "authorization_pending" } },
        {
          status: 200,
          body: {
            access_token: "tok_device",
            organization_id: "org_x",
            user_id: "user_y",
          },
        },
      ])

      const { ctx, stdout } = makeCtx(["--api-url", "https://api.test", "--no-browser"])
      const code = await loginCommand(ctx)
      expect(code).toBe(0)
      const text = stdout.join("")
      expect(text).toContain("ABCD-1234")
      expect(text).toContain("https://api.test/cli?user_code=ABCD-1234")
      expect(text).toContain("Logged in to https://api.test (org org_x)")

      const stored = getCredential("https://api.test")
      expect(stored?.accessToken).toBe("tok_device")
      expect(stored?.organizationId).toBe("org_x")
      expect(stored?.userId).toBe("user_y")
    })

    it("reports access_denied without storing a credential", async () => {
      mockDeviceFlow([{ status: 400, body: { error: "access_denied" } }])

      const { ctx, stderr } = makeCtx(["--api-url", "https://api.test", "--no-browser"])
      const code = await loginCommand(ctx)
      expect(code).toBe(1)
      expect(stderr.join("")).toContain("Login was denied in the browser")
      expect(getCredential("https://api.test")).toBeUndefined()
    })

    it("reports expired_token without storing a credential", async () => {
      mockDeviceFlow([{ status: 400, body: { error: "expired_token" } }])

      const { ctx, stderr } = makeCtx(["--api-url", "https://api.test", "--no-browser"])
      const code = await loginCommand(ctx)
      expect(code).toBe(1)
      expect(stderr.join("")).toContain("Login window expired")
      expect(getCredential("https://api.test")).toBeUndefined()
    })
  })
})
