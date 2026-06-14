import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { whoamiCommand } from "../../src/commands/whoami.js"
import { setCredential } from "../../src/lib/credentials.js"

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

describe("whoamiCommand", () => {
  let tmp: string
  let prevCredFile: string | undefined
  let prevApiKey: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-whoami-"))
    prevCredFile = process.env.VOYANT_CREDENTIALS_FILE
    process.env.VOYANT_CREDENTIALS_FILE = join(tmp, "credentials.json")
    prevApiKey = process.env.VOYANT_CLOUD_API_KEY
    delete process.env.VOYANT_CLOUD_API_KEY
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    if (prevCredFile === undefined) delete process.env.VOYANT_CREDENTIALS_FILE
    else process.env.VOYANT_CREDENTIALS_FILE = prevCredFile
    if (prevApiKey === undefined) delete process.env.VOYANT_CLOUD_API_KEY
    else process.env.VOYANT_CLOUD_API_KEY = prevApiKey
  })

  it("prints the credentials-file source when only a stored cred exists", () => {
    setCredential("https://api.voyant.travel", { accessToken: "tok_file", createdAt: "x" })
    const { ctx, stdout } = makeCtx([])
    const code = whoamiCommand(ctx)
    expect(code).toBe(0)
    const text = stdout.join("")
    expect(text).toContain("API URL:      https://api.voyant.travel")
    expect(text).toContain("Token source: credentials")
  })

  it("prefers --token flag and reports source as 'flag'", () => {
    setCredential("https://api.voyant.travel", { accessToken: "tok_file", createdAt: "x" })
    const { ctx, stdout } = makeCtx(["--token", "tok_flag"])
    const code = whoamiCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("Token source: flag")
  })

  it("errors when no credentials are resolvable", () => {
    const { ctx, stderr } = makeCtx([])
    const code = whoamiCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("No Voyant Cloud credentials")
  })

  it("uses --api-url for the lookup", () => {
    setCredential("https://staging.api.voyant.travel", {
      accessToken: "tok_stg",
      createdAt: "x",
    })
    const { ctx, stdout } = makeCtx(["--api-url", "https://staging.api.voyant.travel"])
    const code = whoamiCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("API URL:      https://staging.api.voyant.travel")
  })
})
