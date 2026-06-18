import { getStringFlag, parseArgs } from "../lib/args.js"
import { DEFAULT_CLOUD_API_URL } from "../lib/cloud-client.js"
import { clearCredential, listOrgCredentials } from "../lib/credentials.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant logout [--org <slug|id>] [--api-url <url>]`
 *
 * Removes stored credentials for the resolved API URL. With `--org`, removes
 * just that org; otherwise removes every org for the API URL. Does NOT call the
 * server — `logout` always succeeds offline. Token revocation lives in the
 * dashboard tokens UI.
 */
export function logoutCommand(ctx: CommandContext): CommandResult {
  const args = parseArgs(ctx.argv)
  const apiUrl =
    getStringFlag(args, "api-url") || process.env.VOYANT_CLOUD_API_URL || DEFAULT_CLOUD_API_URL
  const org = getStringFlag(args, "org") || process.env.VOYANT_CLOUD_ORG

  const stored = listOrgCredentials(apiUrl)
  if (stored.length === 0) {
    ctx.stdout(`Not logged in to ${apiUrl}.\n`)
    return 0
  }

  if (org) {
    const match = stored.find((c) => c.organizationId === org || c.organizationSlug === org)
    if (!match) {
      ctx.stderr(`Not logged in to org "${org}" at ${apiUrl}.\n`)
      return 1
    }
    clearCredential(apiUrl, match.organizationId)
    ctx.stdout(
      `Logged out of org ${match.organizationSlug ?? match.organizationId} at ${apiUrl}.\n`,
    )
    return 0
  }

  clearCredential(apiUrl)
  ctx.stdout(`Logged out of ${apiUrl}.\n`)
  return 0
}
