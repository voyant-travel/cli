import { createHash } from "node:crypto"

import {
  createCloudClient,
  type ResolveCloudAuthOptions,
  resolveCloudAuth,
} from "./cloud-client.js"
import {
  THEME_PROJECT_LINK_SCHEMA_VERSION,
  type ThemeProjectLink,
  type ThemeTargetSelectors,
} from "./theme-project-link.js"

export const THEME_DEVELOPMENT_RUNTIME_ADAPTER_ID = "voyant-platform" as const
export const THEME_DEVELOPMENT_CAPABILITY_ENV = "VOYANT_THEME_DEVELOPMENT_CAPABILITY" as const

export interface ThemeDevelopmentRuntimeDescriptor {
  schemaVersion: "voyant.theme-development-runtime.v1"
  sessionId: string
  themeId: string
  siteId: string
  installationId: string
  manifestDigest: `sha256:${string}`
  perspective: "published" | "development"
  contentEndpoint: string
  publicApiEndpoint: string
  editor: { baseUrl: string; protocolVersion: "voyant.theme-editor.v1" }
  expiresAt: string
}

export interface CreateThemeDevelopmentSessionInput {
  themeId: string
  siteId: string
  installationId: string
  localOrigin: string
  contractVersion: string
  manifest: unknown
  manifestDigest: `sha256:${string}`
}

export interface CreatedThemeDevelopmentSession {
  sessionToken: string
  runtime: ThemeDevelopmentRuntimeDescriptor
}

export interface ReplaceThemeDevelopmentManifestInput {
  expectedManifestDigest: `sha256:${string}`
  manifest: unknown
  manifestDigest: `sha256:${string}`
}

export interface ThemePlatformAdapter {
  resolveTarget(input: {
    selectors: ThemeTargetSelectors
    contractVersion: string
    manifest: unknown
    manifestDigest: `sha256:${string}`
  }): Promise<ThemeProjectLink & { siteId: string; installationId: string }>
  createSession(input: CreateThemeDevelopmentSessionInput): Promise<CreatedThemeDevelopmentSession>
  replaceSessionManifest(
    sessionId: string,
    input: ReplaceThemeDevelopmentManifestInput,
  ): Promise<ThemeDevelopmentRuntimeDescriptor>
  revokeSession(sessionId: string): Promise<void>
}

export function createThemePlatformAdapter(options: ResolveCloudAuthOptions): ThemePlatformAdapter {
  const auth = resolveCloudAuth(options)
  const apiPath = (path: string) => withApiBasePath(auth.apiUrl, path)
  const client = createCloudClient({
    token: auth.accessToken,
    apiUrl: auth.apiUrl,
    org: auth.organizationId ?? auth.organizationSlug,
  })

  return {
    async resolveTarget(input) {
      if (!input.selectors.theme || !input.selectors.site || !input.selectors.installation) {
        throw new ThemePlatformError(
          "theme_development_target_required",
          "A Theme, Site, and installation selector are required.",
        )
      }
      const response = await client.transport.request<unknown>(
        apiPath("/cloud/v1/theme-development-targets/resolve"),
        {
          method: "POST",
          body: {
            theme: input.selectors.theme,
            site: input.selectors.site,
            installation: input.selectors.installation,
            contractVersion: input.contractVersion,
            manifest: input.manifest,
            manifestDigest: input.manifestDigest,
          },
        },
      )
      if (!isRecord(response) || !isRecord(response.data)) throw invalidTargetResponse()
      const target = response.data
      if (
        typeof target.organizationId !== "string" ||
        typeof target.themeId !== "string" ||
        typeof target.siteId !== "string" ||
        typeof target.installationId !== "string" ||
        target.manifestDigest !== input.manifestDigest
      ) {
        throw invalidTargetResponse()
      }
      if (
        input.selectors.organization &&
        auth.organizationId &&
        input.selectors.organization !== auth.organizationId &&
        input.selectors.organization !== auth.organizationSlug
      ) {
        throw new ThemePlatformError(
          "theme_organization_mismatch",
          `The selected credentials do not belong to ${input.selectors.organization}.`,
        )
      }
      return {
        schemaVersion: THEME_PROJECT_LINK_SCHEMA_VERSION,
        apiUrl: auth.apiUrl,
        organizationId: target.organizationId,
        themeId: target.themeId,
        siteId: target.siteId,
        installationId: target.installationId,
      }
    },
    async createSession(input) {
      const response = await client.transport.request<unknown>(
        apiPath("/cloud/v1/theme-development-sessions"),
        { method: "POST", body: input },
      )
      if (
        !isRecord(response) ||
        !isRecord(response.data) ||
        typeof response.data.sessionToken !== "string" ||
        !response.data.sessionToken.startsWith("vyd_") ||
        !isRecord(response.data.runtime)
      ) {
        throw new ThemePlatformError(
          "theme_development_response_invalid",
          "The Voyant platform returned an incompatible Theme Development Session response. Upgrade the CLI or try again after the platform rollout completes.",
        )
      }
      return {
        sessionToken: response.data.sessionToken,
        runtime: response.data.runtime as unknown as ThemeDevelopmentRuntimeDescriptor,
      }
    },
    async replaceSessionManifest(sessionId, input) {
      const response = await client.transport.request<unknown>(
        apiPath(`/cloud/v1/theme-development-sessions/${encodeURIComponent(sessionId)}/manifest`),
        { method: "PUT", body: input },
      )
      if (!isRecord(response) || !isRecord(response.data) || !isRecord(response.data.runtime)) {
        throw new ThemePlatformError(
          "theme_development_response_invalid",
          "The Voyant platform returned an incompatible Theme Development Runtime after updating the manifest.",
        )
      }
      return response.data.runtime as unknown as ThemeDevelopmentRuntimeDescriptor
    },
    async revokeSession(sessionId) {
      await client.transport.request(
        apiPath(`/cloud/v1/theme-development-sessions/${encodeURIComponent(sessionId)}`),
        { method: "DELETE" },
      )
    },
  }
}

function withApiBasePath(apiUrl: string, path: string): string {
  const prefix = new URL(apiUrl).pathname.replace(/\/+$/, "")
  return `${prefix}${path}`
}

function invalidTargetResponse(): ThemePlatformError {
  return new ThemePlatformError(
    "theme_target_response_invalid",
    "The Voyant platform returned an invalid Theme development target response.",
  )
}

export function themeManifestDigest(manifest: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`
}

export function parseThemeDevelopmentRuntimeDescriptor(
  value: unknown,
): ThemeDevelopmentRuntimeDescriptor {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "voyant.theme-development-runtime.v1" ||
    typeof value.sessionId !== "string" ||
    typeof value.themeId !== "string" ||
    typeof value.siteId !== "string" ||
    typeof value.installationId !== "string" ||
    typeof value.manifestDigest !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    throw new ThemePlatformError(
      "theme_development_response_invalid",
      "The Voyant platform returned an invalid Theme Development Runtime descriptor.",
    )
  }
  return value as unknown as ThemeDevelopmentRuntimeDescriptor
}

export class ThemePlatformError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ThemePlatformError"
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error("Theme manifest contains a non-JSON value.")
    return serialized
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
