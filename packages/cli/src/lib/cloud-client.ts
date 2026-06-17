import {
  getVoyantCloudClient,
  type VoyantCloudClient,
  VoyantCloudConfigError,
} from "@voyant-travel/cloud-sdk"

import { getCredential } from "./credentials.js"

/**
 * Default Voyant Cloud production base URL. Matches the default baked into
 * `@voyant-travel/cloud-sdk` so CLI behavior stays consistent with programmatic
 * use of the SDK.
 */
export const DEFAULT_CLOUD_API_URL = "https://api.voyant.travel"

export interface ResolveCloudAuthOptions {
  /** From `--token <value>` flag. Highest priority. */
  token?: string
  /** From `--api-url <value>` flag. Used as both client base URL and credentials key. */
  apiUrl?: string
  /** Override the env source — defaults to `process.env`. Tests pass a literal map. */
  env?: Record<string, string | undefined>
  /** Override the credentials file path — tests pass a tmpdir path. */
  credentialsPath?: string
}

export interface ResolvedCloudAuth {
  apiUrl: string
  accessToken: string
  /** Where the token came from. Useful for logging and `voyant whoami`. */
  source: "flag" | "env" | "credentials"
}

/**
 * Thrown when no credentials can be resolved for the requested API URL.
 * The message includes the URL so users with multiple environments
 * understand which one they're missing a token for.
 */
export class CloudAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CloudAuthError"
  }
}

/**
 * Resolve a Voyant Cloud token + API URL from the available sources.
 *
 * Order of precedence:
 *   1. `opts.token` (`--token` flag)
 *   2. `VOYANT_CLOUD_API_KEY` env var
 *   3. credentials file (`~/.voyant/credentials.json`), keyed by API URL
 *
 * Throws {@link CloudAuthError} if none of the above produce a token.
 */
export function resolveCloudAuth(opts: ResolveCloudAuthOptions = {}): ResolvedCloudAuth {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  const apiUrl =
    nonEmpty(opts.apiUrl) ?? nonEmpty(env.VOYANT_CLOUD_API_URL) ?? DEFAULT_CLOUD_API_URL

  const flagToken = nonEmpty(opts.token)
  if (flagToken) return { apiUrl, accessToken: flagToken, source: "flag" }

  const envToken = nonEmpty(env.VOYANT_CLOUD_API_KEY)
  if (envToken) return { apiUrl, accessToken: envToken, source: "env" }

  const cred = getCredential(apiUrl, opts.credentialsPath)
  const credToken = nonEmpty(cred?.accessToken)
  if (credToken) return { apiUrl, accessToken: credToken, source: "credentials" }

  throw new CloudAuthError(
    `No Voyant Cloud credentials found for ${apiUrl}. ` +
      "Run `voyant login`, set VOYANT_CLOUD_API_KEY, or pass --token.",
  )
}

/**
 * Construct a configured {@link VoyantCloudClient} using the same resolution
 * order as {@link resolveCloudAuth}. Throws {@link CloudAuthError} on missing
 * credentials.
 */
export function createCloudClient(opts: ResolveCloudAuthOptions = {}): VoyantCloudClient {
  const auth = resolveCloudAuth(opts)
  try {
    return getVoyantCloudClient({
      VOYANT_CLOUD_API_KEY: auth.accessToken,
      VOYANT_CLOUD_API_URL: auth.apiUrl,
    })
  } catch (err) {
    if (err instanceof VoyantCloudConfigError) {
      throw new CloudAuthError(err.message)
    }
    throw err
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
