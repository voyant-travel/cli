import { spawn } from "node:child_process"
import { hostname, platform } from "node:os"

import { getStringFlag, parseArgs } from "../lib/args.js"
import { createCloudClient, DEFAULT_CLOUD_API_URL } from "../lib/cloud-client.js"
import { setOrgCredential } from "../lib/credentials.js"
import { DeviceFlowError, type DeviceFlowResult, runDeviceCodeFlow } from "../lib/device-code.js"
import { type CloudOrganizationInfo, fetchOrganization } from "../lib/org.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant login [--token <value>] [--api-url <url>] [--no-validate] [--no-browser]`
 *
 * Two modes:
 *
 *   1. Paste-token mode (`--token <value>`): stores the token after
 *      validating it with `vault.listVaults()`. Useful in CI and headless
 *      environments where a browser isn't available.
 *
 *   2. Device-code mode (no flags): runs the RFC 8628 dance against
 *      `/cli/v1/device/{authorize,token}`, prints (and optionally opens)
 *      the browser URL, polls until the user approves.
 *
 * In either mode the resolved credential gets stored in
 * `~/.voyant/credentials.json` keyed by the apiUrl.
 */
export async function loginCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const token = getStringFlag(args, "token")
  const apiUrl =
    getStringFlag(args, "api-url") || process.env.VOYANT_CLOUD_API_URL || DEFAULT_CLOUD_API_URL

  if (token) {
    return runPasteTokenLogin({ ctx, token, apiUrl, args })
  }

  return runDeviceCodeLogin({ ctx, apiUrl, args })
}

interface PasteTokenLoginOptions {
  ctx: CommandContext
  token: string
  apiUrl: string
  args: ReturnType<typeof parseArgs>
}

async function runPasteTokenLogin(opts: PasteTokenLoginOptions): Promise<CommandResult> {
  const { ctx, token, apiUrl, args } = opts
  const skipValidate = args.flags.validate === false

  // Resolve the org the token is bound to. The call doubles as validation: a
  // rejected token throws and we refuse to store it. We call the route directly
  // (rather than the error-swallowing fetchOrganization) so a 401/403 surfaces
  // as a rejection; a non-org body (older API) just yields a null org.
  let org: CloudOrganizationInfo | null = null
  if (!skipValidate) {
    try {
      const client = createCloudClient({ token, apiUrl })
      const result = await client.transport.request<unknown>("/cloud/v1/organization")
      org =
        result && typeof (result as CloudOrganizationInfo).id === "string"
          ? (result as CloudOrganizationInfo)
          : null
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.stderr(`Token rejected by ${apiUrl}: ${reason}\n`)
      return 1
    }
  }

  setOrgCredential(apiUrl, {
    accessToken: token,
    organizationId: org?.id ?? "default",
    organizationSlug: org?.slug,
    createdAt: new Date().toISOString(),
  })

  ctx.stdout(
    org ? `Logged in to ${apiUrl} (org ${org.slug ?? org.id})\n` : `Logged in to ${apiUrl}\n`,
  )
  return 0
}

interface DeviceCodeLoginOptions {
  ctx: CommandContext
  apiUrl: string
  args: ReturnType<typeof parseArgs>
}

async function runDeviceCodeLogin(opts: DeviceCodeLoginOptions): Promise<CommandResult> {
  const { ctx, apiUrl, args } = opts
  const noBrowser = args.flags.browser === false

  ctx.stdout(`Starting device authorization at ${apiUrl}\n`)

  let result: DeviceFlowResult
  try {
    result = await runDeviceCodeFlow({
      apiUrl,
      name: `voyant-cli on ${hostname()}`,
      clientInfo: {
        hostname: hostname(),
        platform: platform(),
      },
      onCodes: ({ userCode, verificationUri, verificationUriComplete }) => {
        ctx.stdout(`\n  Open this URL to authorize:\n    ${verificationUriComplete}\n\n`)
        ctx.stdout(`  Or enter ${userCode} at ${verificationUri}\n\n`)
        if (!noBrowser) tryOpenBrowser(verificationUriComplete)
        ctx.stdout("Waiting for approval...\n")
      },
    })
  } catch (err) {
    if (err instanceof DeviceFlowError) {
      ctx.stderr(`${err.message}\n`)
      return 1
    }
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Login failed: ${reason}\n`)
    return 1
  }

  // Best-effort: resolve the org slug for a friendlier display + storage key.
  let slug: string | undefined
  try {
    const client = createCloudClient({ token: result.accessToken, apiUrl })
    slug = (await fetchOrganization(client))?.slug
  } catch {
    // Non-fatal — we already have the org id from the device flow.
  }

  setOrgCredential(apiUrl, {
    accessToken: result.accessToken,
    organizationId: result.organizationId,
    organizationSlug: slug,
    userId: result.userId,
    createdAt: new Date().toISOString(),
  })

  ctx.stdout(`\nLogged in to ${apiUrl} (org ${slug ?? result.organizationId})\n`)
  return 0
}

/**
 * Best-effort browser open. Failures are intentionally swallowed —
 * the URL is already on stdout, so the user can copy/paste manually.
 */
function tryOpenBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawn(cmd, argv, { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch {
    // ignore
  }
}
