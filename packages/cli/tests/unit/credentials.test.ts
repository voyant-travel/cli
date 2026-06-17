import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  clearCredential,
  getCredential,
  getCredentialsPath,
  loadCredentials,
  saveCredentials,
  setCredential,
} from "../../src/lib/credentials.js"

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

  it("round-trips a credential keyed by apiUrl", () => {
    setCredential(
      "https://api.voyant.travel",
      {
        accessToken: "tok_abc",
        organizationId: "org_x",
        userId: "user_x",
        createdAt: "2026-01-01T00:00:00Z",
      },
      path,
    )
    const got = getCredential("https://api.voyant.travel", path)
    expect(got?.accessToken).toBe("tok_abc")
    expect(got?.organizationId).toBe("org_x")
  })

  it("normalizes trailing slashes on the apiUrl key", () => {
    setCredential(
      "https://api.voyant.travel/",
      { accessToken: "tok", createdAt: "2026-01-01T00:00:00Z" },
      path,
    )
    expect(getCredential("https://api.voyant.travel", path)?.accessToken).toBe("tok")
    expect(getCredential("https://api.voyant.travel//", path)?.accessToken).toBe("tok")
  })

  it("supports multiple apiUrls in one file", () => {
    setCredential("https://a", { accessToken: "1", createdAt: "x" }, path)
    setCredential("https://b", { accessToken: "2", createdAt: "x" }, path)
    expect(getCredential("https://a", path)?.accessToken).toBe("1")
    expect(getCredential("https://b", path)?.accessToken).toBe("2")
  })

  it("writes the file with mode 0600", () => {
    if (process.platform === "win32") return
    setCredential(
      "https://api.voyant.travel",
      { accessToken: "tok", createdAt: "2026-01-01T00:00:00Z" },
      path,
    )
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("re-applies mode 0600 on overwrite", () => {
    if (process.platform === "win32") return
    setCredential("https://a", { accessToken: "1", createdAt: "x" }, path)
    // Simulate an externally-loosened mode.
    chmodSync(path, 0o644)
    setCredential("https://a", { accessToken: "2", createdAt: "x" }, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("clearCredential removes a single key", () => {
    setCredential("https://a", { accessToken: "1", createdAt: "x" }, path)
    setCredential("https://b", { accessToken: "2", createdAt: "x" }, path)
    clearCredential("https://a", path)
    expect(getCredential("https://a", path)).toBeUndefined()
    expect(getCredential("https://b", path)?.accessToken).toBe("2")
  })

  it("clearCredential deletes the file when the last key is removed", () => {
    setCredential("https://a", { accessToken: "1", createdAt: "x" }, path)
    clearCredential("https://a", path)
    expect(loadCredentials(path)).toEqual({})
  })

  it("ignores unparseable JSON", () => {
    writeFileSync(path, "{not-json", "utf8")
    expect(loadCredentials(path)).toEqual({})
  })

  it("ignores empty files", () => {
    writeFileSync(path, "", "utf8")
    expect(loadCredentials(path)).toEqual({})
  })

  it("ignores arrays at the top level", () => {
    writeFileSync(path, "[1,2,3]", "utf8")
    expect(loadCredentials(path)).toEqual({})
  })

  it("saveCredentials creates the parent directory", () => {
    const nested = join(tmp, "nested", "deep", "credentials.json")
    saveCredentials({ "https://a": { accessToken: "1", createdAt: "x" } }, nested)
    expect(loadCredentials(nested)["https://a"]?.accessToken).toBe("1")
  })

  it("getCredentialsPath honors VOYANT_CREDENTIALS_FILE", () => {
    const prev = process.env.VOYANT_CREDENTIALS_FILE
    process.env.VOYANT_CREDENTIALS_FILE = "/custom/voyant.json"
    try {
      expect(getCredentialsPath()).toBe("/custom/voyant.json")
    } finally {
      if (prev === undefined) {
        delete process.env.VOYANT_CREDENTIALS_FILE
      } else {
        process.env.VOYANT_CREDENTIALS_FILE = prev
      }
    }
  })

  it("getCredentialsPath ignores empty-string VOYANT_CREDENTIALS_FILE", () => {
    const prev = process.env.VOYANT_CREDENTIALS_FILE
    process.env.VOYANT_CREDENTIALS_FILE = ""
    try {
      expect(getCredentialsPath()).toMatch(/voyant.+credentials\.json$/)
    } finally {
      if (prev === undefined) {
        delete process.env.VOYANT_CREDENTIALS_FILE
      } else {
        process.env.VOYANT_CREDENTIALS_FILE = prev
      }
    }
  })
})
