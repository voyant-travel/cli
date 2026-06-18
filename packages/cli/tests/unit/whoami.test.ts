import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { whoamiCommand } from "../../src/commands/whoami.js"
import { setOrgCredential } from "../../src/lib/credentials.js"

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

describe("whoamiCommand", () => {
  let tmp: string
  let prevCredFile: string | undefined
  let prevApiKey: string | undefined
  let prevFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-whoami-"))
    prevCredFile = process.env.VOYANT_CREDENTIALS_FILE
    process.env.VOYANT_CREDENTIALS_FILE = join(tmp, "credentials.json")
    prevApiKey = process.env.VOYANT_CLOUD_API_KEY
    delete process.env.VOYANT_CLOUD_API_KEY
    // whoami best-effort-fetches the org; return one so we exercise that path
    // without a real network call.
    prevFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: { id: "org_x", slug: "acme", name: "Acme" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    if (prevCredFile === undefined) delete process.env.VOYANT_CREDENTIALS_FILE
    else process.env.VOYANT_CREDENTIALS_FILE = prevCredFile
    if (prevApiKey === undefined) delete process.env.VOYANT_CLOUD_API_KEY
    else process.env.VOYANT_CLOUD_API_KEY = prevApiKey
    globalThis.fetch = prevFetch as typeof globalThis.fetch
  })

  it("prints the credentials-file source and resolved org", async () => {
    setCredential("https://api.voyant.travel", { accessToken: "tok_file", createdAt: "x" })
    const { ctx, stdout } = makeCtx([])
    const code = await whoamiCommand(ctx)
    expect(code).toBe(0)
    const text = stdout.join("")
    expect(text).toContain("API URL:      https://api.voyant.travel")
    expect(text).toContain("Token source: credentials")
    expect(text).toContain("Acme")
  })

  it("prefers --token flag and reports source as 'flag'", async () => {
    setCredential("https://api.voyant.travel", { accessToken: "tok_file", createdAt: "x" })
    const { ctx, stdout } = makeCtx(["--token", "tok_flag"])
    const code = await whoamiCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("Token source: flag")
  })

  it("emits a JSON identity envelope with --json", async () => {
    setCredential("https://api.voyant.travel", { accessToken: "tok_file", createdAt: "x" })
    const { ctx, stdout } = makeCtx(["--json"])
    const code = await whoamiCommand(ctx)
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.join(""))
    expect(parsed.tokenSource).toBe("credentials")
    expect(parsed.organizationSlug).toBe("acme")
  })

  it("errors when no credentials are resolvable", async () => {
    const { ctx, stderr } = makeCtx([])
    const code = await whoamiCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("No Voyant Cloud credentials")
  })

  it("uses --api-url for the lookup", async () => {
    setCredential("https://staging.api.voyant.travel", { accessToken: "tok_stg", createdAt: "x" })
    const { ctx, stdout } = makeCtx(["--api-url", "https://staging.api.voyant.travel"])
    const code = await whoamiCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("API URL:      https://staging.api.voyant.travel")
  })
})
