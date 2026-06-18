import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { logoutCommand } from "../../src/commands/logout.js"
import { resolveOrgCredential, setOrgCredential } from "../../src/lib/credentials.js"

// Test shims bridging the old single-credential API onto the multi-org store.
const getCredential = (apiUrl: string) => resolveOrgCredential(apiUrl, undefined)
const setCredential = (apiUrl: string, cred: { accessToken: string; createdAt: string }) =>
  setOrgCredential(apiUrl, { organizationId: "org_x", ...cred }, {})

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

describe("logoutCommand", () => {
  let tmp: string
  let prev: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-logout-"))
    prev = process.env.VOYANT_CREDENTIALS_FILE
    process.env.VOYANT_CREDENTIALS_FILE = join(tmp, "credentials.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    if (prev === undefined) delete process.env.VOYANT_CREDENTIALS_FILE
    else process.env.VOYANT_CREDENTIALS_FILE = prev
  })

  it("clears the credential for the resolved API URL", () => {
    setCredential("https://api.test", { accessToken: "tok", createdAt: "x" })
    const { ctx, stdout } = makeCtx(["--api-url", "https://api.test"])
    const code = logoutCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("Logged out of https://api.test")
    expect(getCredential("https://api.test")).toBeUndefined()
  })

  it("is a no-op when not logged in", () => {
    const { ctx, stdout } = makeCtx(["--api-url", "https://api.test"])
    const code = logoutCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("Not logged in to https://api.test")
  })

  it("only clears the requested apiUrl, leaves others alone", () => {
    setCredential("https://api.a", { accessToken: "1", createdAt: "x" })
    setCredential("https://api.b", { accessToken: "2", createdAt: "x" })
    const { ctx } = makeCtx(["--api-url", "https://api.a"])
    logoutCommand(ctx)
    expect(getCredential("https://api.a")).toBeUndefined()
    expect(getCredential("https://api.b")?.accessToken).toBe("2")
  })
})
