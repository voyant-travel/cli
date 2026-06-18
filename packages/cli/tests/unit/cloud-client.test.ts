import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  CloudAuthError,
  createCloudClient,
  DEFAULT_CLOUD_API_URL,
  resolveCloudAuth,
} from "../../src/lib/cloud-client.js"
import { setOrgCredential } from "../../src/lib/credentials.js"

// Test shim: the credentials store is now multi-org. Default a synthetic org id
// so the existing single-credential assertions keep working unchanged.
function setCredential(
  apiUrl: string,
  cred: { accessToken: string; organizationId?: string; userId?: string; createdAt: string },
  path?: string,
) {
  setOrgCredential(apiUrl, { organizationId: "org_x", ...cred }, {}, path)
}

describe("resolveCloudAuth", () => {
  let tmp: string
  let credentialsPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-auth-"))
    credentialsPath = join(tmp, "credentials.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("uses --token first, even when env and credentials are present", () => {
    setCredential(
      DEFAULT_CLOUD_API_URL,
      { accessToken: "tok_file", createdAt: "2026-01-01T00:00:00Z" },
      credentialsPath,
    )
    const got = resolveCloudAuth({
      token: "tok_flag",
      env: { VOYANT_CLOUD_API_KEY: "tok_env" },
      credentialsPath,
    })
    expect(got).toEqual({
      apiUrl: DEFAULT_CLOUD_API_URL,
      accessToken: "tok_flag",
      source: "flag",
    })
  })

  it("falls back to VOYANT_CLOUD_API_KEY env when no flag", () => {
    setCredential(
      DEFAULT_CLOUD_API_URL,
      { accessToken: "tok_file", createdAt: "x" },
      credentialsPath,
    )
    const got = resolveCloudAuth({
      env: { VOYANT_CLOUD_API_KEY: "tok_env" },
      credentialsPath,
    })
    expect(got.accessToken).toBe("tok_env")
    expect(got.source).toBe("env")
  })

  it("falls back to credentials file when no flag and no env", () => {
    setCredential(
      DEFAULT_CLOUD_API_URL,
      { accessToken: "tok_file", createdAt: "x" },
      credentialsPath,
    )
    const got = resolveCloudAuth({ env: {}, credentialsPath })
    expect(got.accessToken).toBe("tok_file")
    expect(got.source).toBe("credentials")
  })

  it("uses --api-url for both base URL and credentials lookup", () => {
    setCredential(
      "https://staging.api.voyant.travel",
      { accessToken: "tok_staging", createdAt: "x" },
      credentialsPath,
    )
    const got = resolveCloudAuth({
      apiUrl: "https://staging.api.voyant.travel",
      env: {},
      credentialsPath,
    })
    expect(got.apiUrl).toBe("https://staging.api.voyant.travel")
    expect(got.accessToken).toBe("tok_staging")
    expect(got.source).toBe("credentials")
  })

  it("uses VOYANT_CLOUD_API_URL env when --api-url is missing", () => {
    setCredential(
      "https://custom.example.com",
      { accessToken: "tok_custom", createdAt: "x" },
      credentialsPath,
    )
    const got = resolveCloudAuth({
      env: { VOYANT_CLOUD_API_URL: "https://custom.example.com" },
      credentialsPath,
    })
    expect(got.apiUrl).toBe("https://custom.example.com")
    expect(got.source).toBe("credentials")
  })

  it("--api-url flag wins over VOYANT_CLOUD_API_URL env", () => {
    setCredential(
      "https://flag.example.com",
      { accessToken: "tok_flag_url", createdAt: "x" },
      credentialsPath,
    )
    const got = resolveCloudAuth({
      apiUrl: "https://flag.example.com",
      env: { VOYANT_CLOUD_API_URL: "https://env.example.com" },
      credentialsPath,
    })
    expect(got.apiUrl).toBe("https://flag.example.com")
  })

  it("treats empty-string env values as missing", () => {
    setCredential(
      DEFAULT_CLOUD_API_URL,
      { accessToken: "tok_file", createdAt: "x" },
      credentialsPath,
    )
    const got = resolveCloudAuth({
      env: { VOYANT_CLOUD_API_KEY: "", VOYANT_CLOUD_API_URL: "" },
      credentialsPath,
    })
    expect(got.apiUrl).toBe(DEFAULT_CLOUD_API_URL)
    expect(got.accessToken).toBe("tok_file")
    expect(got.source).toBe("credentials")
  })

  it("throws CloudAuthError when no source produces a token", () => {
    expect(() => resolveCloudAuth({ env: {}, credentialsPath })).toThrow(CloudAuthError)
    expect(() => resolveCloudAuth({ env: {}, credentialsPath })).toThrow(
      /No Voyant Cloud credentials found for https:\/\/api\.voyant\.travel/,
    )
  })

  it("throws with the resolved apiUrl in the message (helps when staging is misconfigured)", () => {
    expect(() =>
      resolveCloudAuth({
        apiUrl: "https://staging.api.voyant.travel",
        env: {},
        credentialsPath,
      }),
    ).toThrow(/staging\.api\.voyant\.travel/)
  })
})

describe("createCloudClient", () => {
  let tmp: string
  let credentialsPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-client-"))
    credentialsPath = join(tmp, "credentials.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns a configured VoyantCloudClient when auth resolves", () => {
    const client = createCloudClient({
      token: "tok_flag",
      env: {},
      credentialsPath,
    })
    expect(client).toBeDefined()
    expect(client.transport.baseUrl).toBe(DEFAULT_CLOUD_API_URL)
  })

  it("threads --api-url into the client baseUrl", () => {
    const client = createCloudClient({
      token: "tok_flag",
      apiUrl: "https://staging.api.voyant.travel",
      env: {},
      credentialsPath,
    })
    expect(client.transport.baseUrl).toBe("https://staging.api.voyant.travel")
  })

  it("throws CloudAuthError when no credentials are available", () => {
    expect(() => createCloudClient({ env: {}, credentialsPath })).toThrow(CloudAuthError)
  })
})
