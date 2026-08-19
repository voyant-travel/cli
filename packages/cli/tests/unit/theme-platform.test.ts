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
      apiUrl: "https://sandbox.onvoyant.com",
      accessToken: "cloud-secret",
      source: "credentials",
      organizationId: "org_123",
    })
  })

  it("resolves selectors to canonical IDs without putting credentials in the request", async () => {
    mocks.request.mockResolvedValueOnce({
      data: {
        organizationId: "org_123",
        themeId: "thm_123",
        siteId: "site_123",
        installationId: "thi_123",
        manifestDigest: `sha256:${"a".repeat(64)}`,
      },
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
    expect(mocks.request).toHaveBeenCalledWith("/cloud/v1/theme-development-targets/resolve", {
      method: "POST",
      body: {
        theme: "bucharest",
        site: "preview-site",
        installation: "thi_123",
        contractVersion: "v1",
        manifest: { id: "bucharest" },
        manifestDigest: `sha256:${"a".repeat(64)}`,
      },
    })
    expect(JSON.stringify(mocks.request.mock.calls)).not.toContain("cloud-secret")
  })

  it("accepts only the session envelope and leaves descriptor semantics to the pinned SDK", async () => {
    const runtime = { schemaVersion: "voyant.theme-development-runtime.v1", sessionId: "tds_123" }
    mocks.request.mockResolvedValueOnce({
      data: { sessionToken: "vyd_private", runtime },
    })
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

  it("canonicalizes object keys when computing the platform manifest digest", () => {
    expect(themeManifestDigest({ b: [2, 1], a: { d: false, c: null } })).toBe(
      themeManifestDigest({ a: { c: null, d: false }, b: [2, 1] }),
    )
  })
})
