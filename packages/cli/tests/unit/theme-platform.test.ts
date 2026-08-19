import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  resolveCloudAuth: vi.fn(),
}))

vi.mock("../../src/lib/cloud-client.js", () => ({
  resolveCloudAuth: mocks.resolveCloudAuth,
  createCloudClient: () => ({ transport: { request: mocks.request } }),
}))

import {
  createThemePlatformAdapter,
  parseThemeDevelopmentRuntimeDescriptor,
  themeManifestDigest,
} from "../../src/lib/theme-platform.js"

describe("Theme platform Adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveCloudAuth.mockReturnValue({
      apiUrl: "https://sandbox.onvoyant.com/__voyant/themes-sandbox-api",
      accessToken: "cloud-secret",
      source: "credentials",
      organizationId: "org_123",
    })
  })

  it("lists development targets through the API base path without exposing credentials", async () => {
    const data = {
      organizationId: "org_123",
      themes: [{ id: "thm_123", slug: "bucharest", name: "Bucharest", status: "active" }],
      sites: [
        {
          id: "site_123",
          slug: "preview",
          platformHostname: "preview.sandbox.onvoyant.com",
          status: "active",
          installations: [{ id: "thi_123", themeId: "thm_123", archived: false }],
        },
      ],
    }
    mocks.request.mockResolvedValueOnce(data)
    const adapter = createThemePlatformAdapter({ org: "org_123" })

    await expect(adapter.listTargets()).resolves.toEqual(data)
    expect(mocks.request).toHaveBeenCalledWith(
      "/__voyant/themes-sandbox-api/cloud/v1/theme-development-targets",
    )
    expect(JSON.stringify(mocks.request.mock.calls)).not.toContain("cloud-secret")
  })

  it("rejects malformed development target discovery responses", async () => {
    mocks.request.mockResolvedValueOnce({
      organizationId: "org_123",
      themes: [],
      sites: [{ id: "site_123", installations: "not-an-array" }],
    })
    const adapter = createThemePlatformAdapter({})

    await expect(adapter.listTargets()).rejects.toMatchObject({
      code: "theme_targets_response_invalid",
    })
  })

  it("rejects a wrapped target response instead of masking an SDK contract mismatch", async () => {
    mocks.request.mockResolvedValueOnce({
      data: { organizationId: "org_123", themes: [], sites: [] },
    })
    const adapter = createThemePlatformAdapter({})

    await expect(adapter.listTargets()).rejects.toMatchObject({
      code: "theme_targets_response_invalid",
    })
  })

  it("resolves selectors to canonical IDs without putting credentials in the request", async () => {
    mocks.request.mockResolvedValueOnce({
      organizationId: "org_123",
      themeId: "thm_123",
      siteId: "site_123",
      installationId: "thi_123",
      manifestDigest: `sha256:${"a".repeat(64)}`,
    })
    const adapter = createThemePlatformAdapter({ org: "org_123" })

    await expect(
      adapter.resolveTarget({
        selectors: {
          theme: "bucharest",
          site: "preview-site",
          installation: "thi_123",
          organization: "org_123",
        },
        contractVersion: "v1",
        manifest: { id: "bucharest" },
        manifestDigest: `sha256:${"a".repeat(64)}`,
      }),
    ).resolves.toMatchObject({
      organizationId: "org_123",
      themeId: "thm_123",
      siteId: "site_123",
      installationId: "thi_123",
    })
    expect(mocks.request).toHaveBeenCalledWith(
      "/__voyant/themes-sandbox-api/cloud/v1/theme-development-targets/resolve",
      {
        method: "POST",
        body: {
          theme: "bucharest",
          site: "preview-site",
          installation: "thi_123",
          contractVersion: "v1",
          manifest: { id: "bucharest" },
          manifestDigest: `sha256:${"a".repeat(64)}`,
        },
      },
    )
    expect(JSON.stringify(mocks.request.mock.calls)).not.toContain("cloud-secret")
  })

  it("accepts only the session envelope and leaves descriptor semantics to the pinned SDK", async () => {
    const runtime = { schemaVersion: "voyant.theme-development-runtime.v1", sessionId: "tds_123" }
    mocks.request.mockResolvedValueOnce({ sessionToken: "vyd_private", runtime })
    const adapter = createThemePlatformAdapter({})

    await expect(
      adapter.createSession({
        themeId: "thm_123",
        siteId: "site_123",
        installationId: "thi_123",
        localOrigin: "http://127.0.0.1:4321",
        contractVersion: "v1",
        manifest: { id: "bucharest" },
        manifestDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).resolves.toEqual({ sessionToken: "vyd_private", runtime })
    expect(() => parseThemeDevelopmentRuntimeDescriptor(runtime)).toThrow(
      "invalid Theme Development Runtime descriptor",
    )
  })

  it("CAS-updates a session manifest and returns its replacement runtime", async () => {
    const runtime = {
      schemaVersion: "voyant.theme-development-runtime.v1",
      sessionId: "tds_123",
      manifestDigest: `sha256:${"c".repeat(64)}`,
    }
    mocks.request.mockResolvedValueOnce({ runtime })
    const adapter = createThemePlatformAdapter({})
    const input = {
      expectedManifestDigest: `sha256:${"b".repeat(64)}` as const,
      manifest: { id: "bucharest", version: "0.2.0" },
      manifestDigest: `sha256:${"c".repeat(64)}` as const,
    }

    await expect(adapter.replaceSessionManifest("tds_123", input)).resolves.toEqual(runtime)
    expect(mocks.request).toHaveBeenCalledWith(
      "/__voyant/themes-sandbox-api/cloud/v1/theme-development-sessions/tds_123/manifest",
      { method: "PUT", body: input },
    )
    expect(JSON.stringify(mocks.request.mock.calls)).not.toContain("cloud-secret")
  })

  it("canonicalizes object keys when computing the platform manifest digest", () => {
    expect(themeManifestDigest({ b: [2, 1], a: { d: false, c: null } })).toBe(
      themeManifestDigest({ a: { c: null, d: false }, b: [2, 1] }),
    )
  })
})
