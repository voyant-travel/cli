import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  clearCredential,
  getApiUrlCredentials,
  getCredentialsPath,
  listOrgCredentials,
  loadCredentials,
  type OrgCredential,
  resolveOrgCredential,
  saveCredentials,
  setActiveOrg,
  setOrgCredential,
} from "../../src/lib/credentials.js"

const cred = (overrides: Partial<OrgCredential> = {}): OrgCredential => ({
  accessToken: "tok",
  organizationId: "org_x",
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
})

describe("credentials", () => {
  let tmp: string
  let path: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-cred-"))
    path = join(tmp, "credentials.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns {} when file is missing", () => {
    expect(loadCredentials(path)).toEqual({})
  })

  it("round-trips an org credential and sets it active", () => {
    setOrgCredential(
      "https://api.voyant.travel",
      cred({ accessToken: "tok_abc", organizationId: "org_x", organizationSlug: "acme" }),
      {},
      path,
    )
    const got = resolveOrgCredential("https://api.voyant.travel", undefined, path)
    expect(got?.accessToken).toBe("tok_abc")
    expect(getApiUrlCredentials("https://api.voyant.travel", path)?.activeOrg).toBe("org_x")
  })

  it("resolves the sole org without an explicit selection", () => {
    setOrgCredential("https://a", cred({ organizationId: "only" }), { setActive: false }, path)
    expect(resolveOrgCredential("https://a", undefined, path)?.organizationId).toBe("only")
  })

  it("refuses to guess when multiple orgs exist and none is active", () => {
    setOrgCredential("https://a", cred({ organizationId: "o1" }), { setActive: false }, path)
    setOrgCredential("https://a", cred({ organizationId: "o2" }), { setActive: false }, path)
    expect(resolveOrgCredential("https://a", undefined, path)).toBeUndefined()
    // ...but an explicit selection (by id or slug) resolves.
    expect(resolveOrgCredential("https://a", "o2", path)?.organizationId).toBe("o2")
  })

  it("setActiveOrg switches which org resolves by default", () => {
    setOrgCredential("https://a", cred({ organizationId: "o1", organizationSlug: "one" }), {}, path)
    setOrgCredential("https://a", cred({ organizationId: "o2", organizationSlug: "two" }), {}, path)
    setActiveOrg("https://a", "one", path)
    expect(resolveOrgCredential("https://a", undefined, path)?.organizationId).toBe("o1")
  })

  it("migrates a legacy flat credential into the multi-org shape", () => {
    writeFileSync(
      path,
      JSON.stringify({
        "https://api.voyant.travel": {
          accessToken: "legacy",
          organizationId: "org_legacy",
          createdAt: "2026-01-01T00:00:00Z",
        },
      }),
      "utf8",
    )
    const got = resolveOrgCredential("https://api.voyant.travel", undefined, path)
    expect(got?.accessToken).toBe("legacy")
    expect(got?.organizationId).toBe("org_legacy")
  })

  it("normalizes trailing slashes on the apiUrl key", () => {
    setOrgCredential("https://api.voyant.travel/", cred(), {}, path)
    expect(resolveOrgCredential("https://api.voyant.travel", undefined, path)?.accessToken).toBe(
      "tok",
    )
    expect(resolveOrgCredential("https://api.voyant.travel//", undefined, path)?.accessToken).toBe(
      "tok",
    )
  })

  it("writes the file with mode 0600 (and re-applies on overwrite)", () => {
    if (process.platform === "win32") return
    setOrgCredential("https://a", cred({ accessToken: "1" }), {}, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    chmodSync(path, 0o644)
    setOrgCredential("https://a", cred({ accessToken: "2" }), {}, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("clearCredential removes a single org, then the apiUrl, then the file", () => {
    setOrgCredential("https://a", cred({ organizationId: "o1" }), {}, path)
    setOrgCredential("https://a", cred({ organizationId: "o2" }), {}, path)
    clearCredential("https://a", "o1", path)
    expect(listOrgCredentials("https://a", path).map((c) => c.organizationId)).toEqual(["o2"])
    clearCredential("https://a", undefined, path)
    expect(loadCredentials(path)).toEqual({})
  })

  it("ignores unparseable / empty / array files", () => {
    writeFileSync(path, "{not-json", "utf8")
    expect(loadCredentials(path)).toEqual({})
    writeFileSync(path, "", "utf8")
    expect(loadCredentials(path)).toEqual({})
    writeFileSync(path, "[1,2,3]", "utf8")
    expect(loadCredentials(path)).toEqual({})
  })

  it("saveCredentials creates the parent directory", () => {
    const nested = join(tmp, "nested", "deep", "credentials.json")
    saveCredentials(
      { "https://a": { activeOrg: "o1", orgs: { o1: cred({ organizationId: "o1" }) } } },
      nested,
    )
    expect(resolveOrgCredential("https://a", undefined, nested)?.organizationId).toBe("o1")
  })

  it("getCredentialsPath honors VOYANT_CREDENTIALS_FILE", () => {
    const prev = process.env.VOYANT_CREDENTIALS_FILE
    process.env.VOYANT_CREDENTIALS_FILE = "/custom/voyant.json"
    try {
      expect(getCredentialsPath()).toBe("/custom/voyant.json")
    } finally {
      if (prev === undefined) delete process.env.VOYANT_CREDENTIALS_FILE
      else process.env.VOYANT_CREDENTIALS_FILE = prev
    }
  })

  it("getCredentialsPath ignores empty-string VOYANT_CREDENTIALS_FILE", () => {
    const prev = process.env.VOYANT_CREDENTIALS_FILE
    process.env.VOYANT_CREDENTIALS_FILE = ""
    try {
      expect(getCredentialsPath()).toMatch(/voyant.+credentials\.json$/)
    } finally {
      if (prev === undefined) delete process.env.VOYANT_CREDENTIALS_FILE
      else process.env.VOYANT_CREDENTIALS_FILE = prev
    }
  })
})
