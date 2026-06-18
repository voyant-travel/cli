import { parseArgs } from "../lib/args.js"
import { CloudAuthError, createCloudClient, resolveCloudAuth } from "../lib/cloud-client.js"
import { fetchOrganization } from "../lib/org.js"
import { fail, printJson, resolveGlobalFlags, wantsJson } from "../lib/output.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant whoami [--org <slug|id>] [--api-url <url>] [--token <tok>] [--json]`
 *
 * Resolves the active credential and asks the server which organization the
 * token is bound to (`GET /cloud/v1/organization`). Agents can use this to
 * confirm identity and which org subsequent commands will target.
 */
export async function whoamiCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const flags = resolveGlobalFlags(args)

  let auth: ReturnType<typeof resolveCloudAuth>
  try {
    auth = resolveCloudAuth(flags)
  } catch (err) {
    if (err instanceof CloudAuthError) return fail(ctx, args, err.message, "not_authenticated")
    throw err
  }

  // Best-effort: resolve the org behind the token from the server.
  const org = await fetchOrganization(createCloudClient(flags)).catch(() => null)

  if (wantsJson(args)) {
    printJson(ctx, {
      apiUrl: auth.apiUrl,
      tokenSource: auth.source,
      organizationId: org?.id ?? auth.organizationId ?? null,
      organizationSlug: org?.slug ?? auth.organizationSlug ?? null,
      organizationName: org?.name ?? null,
    })
    return 0
  }

  ctx.stdout(`API URL:      ${auth.apiUrl}\n`)
  ctx.stdout(`Token source: ${auth.source}\n`)
  const orgLabel = org?.slug ?? auth.organizationSlug ?? auth.organizationId
  if (orgLabel) {
    ctx.stdout(`Organization: ${org?.name ? `${org.name} (${orgLabel})` : orgLabel}\n`)
  }
  return 0
}
