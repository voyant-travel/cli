import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { orgCommand } from "../../src/commands/org.js"
import { setOrgCredential } from "../../src/lib/credentials.js"

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

const API = "https://api.test"
const cred = (organizationId: string, organizationSlug: string) => ({
  accessToken: `tok_${organizationId}`,
  organizationId,
  organizationSlug,
  createdAt: "x",
})

describe("orgCommand", () => {
  let tmp: string
  let prev: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-org-"))
    prev = process.env.VOYANT_CREDENTIALS_FILE
    process.env.VOYANT_CREDENTIALS_FILE = join(tmp, "credentials.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    if (prev === undefined) delete process.env.VOYANT_CREDENTIALS_FILE
    else process.env.VOYANT_CREDENTIALS_FILE = prev
  })

  it("lists orgs and marks the active one", () => {
    setOrgCredential(API, cred("o1", "one"), {})
    setOrgCredential(API, cred("o2", "two"), {}) // o2 becomes active (last set)
    const { ctx, stdout } = makeCtx(["list", "--api-url", API])
    expect(orgCommand(ctx)).toBe(0)
    const text = stdout.join("")
    expect(text).toContain("★ two")
    expect(text).toContain("  one")
  })

  it("switches the active org with `use`", () => {
    setOrgCredential(API, cred("o1", "one"), {})
    setOrgCredential(API, cred("o2", "two"), {})
    expect(orgCommand(makeCtx(["use", "one", "--api-url", API]).ctx)).toBe(0)
    const { ctx, stdout } = makeCtx(["current", "--api-url", API, "--json"])
    expect(orgCommand(ctx)).toBe(0)
    expect(JSON.parse(stdout.join("")).organizationSlug).toBe("one")
  })

  it("errors when `use` targets an unknown org", () => {
    setOrgCredential(API, cred("o1", "one"), {})
    const { ctx, stderr } = makeCtx(["use", "nope", "--api-url", API, "--json"])
    expect(orgCommand(ctx)).toBe(1)
    expect(JSON.parse(stderr.join("")).error.code).toBe("org_not_found")
  })
})
