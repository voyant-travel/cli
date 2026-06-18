import { getStringFlag, parseArgs } from "../lib/args.js"
import { DEFAULT_CLOUD_API_URL } from "../lib/cloud-client.js"
import { getApiUrlCredentials, resolveOrgCredential, setActiveOrg } from "../lib/credentials.js"
import { fail, printJson, wantsJson } from "../lib/output.js"
import type { CommandContext, CommandResult } from "../types.js"

const USAGE = `Usage: voyant org <command>

Manage which organization the CLI targets. API tokens are organization-bound,
so each org you log in to is stored separately; switching org switches token.

Commands:
  list                List orgs you are logged in to (★ = active)
  use <slug|id>       Make an org the active one for subsequent commands
  current             Show the active org

Options:
  --api-url <url>     Voyant Cloud API base URL
  --json              Machine-readable output

Examples:
  voyant org list --json
  voyant org use acme
  voyant org current
`

export function orgCommand(ctx: CommandContext): CommandResult {
  const args = parseArgs(ctx.argv)
  const [sub, ...rest] = args.positionals
  const apiUrl =
    getStringFlag(args, "api-url") || process.env.VOYANT_CLOUD_API_URL || DEFAULT_CLOUD_API_URL

  if (!sub || sub === "help") {
    ctx.stdout(USAGE)
    return sub ? 0 : 1
  }

  if (sub === "list") {
    const entry = getApiUrlCredentials(apiUrl)
    const orgs = entry ? Object.values(entry.orgs) : []
    if (wantsJson(args)) {
      printJson(
        ctx,
        orgs.map((o) => ({
          organizationId: o.organizationId,
          organizationSlug: o.organizationSlug ?? null,
          active: entry?.activeOrg === o.organizationId,
        })),
      )
      return 0
    }
    if (orgs.length === 0) {
      ctx.stdout(`Not logged in to ${apiUrl}. Run \`voyant login\`.\n`)
      return 0
    }
    for (const o of orgs) {
      const marker = entry?.activeOrg === o.organizationId ? "★" : " "
      ctx.stdout(`${marker} ${o.organizationSlug ?? o.organizationId}  (${o.organizationId})\n`)
    }
    return 0
  }

  if (sub === "current") {
    const active = resolveOrgCredential(apiUrl, undefined)
    if (!active) {
      return fail(
        ctx,
        args,
        `No active org for ${apiUrl}. Run \`voyant org use <slug>\`.`,
        "no_active_org",
      )
    }
    if (wantsJson(args)) {
      printJson(ctx, {
        organizationId: active.organizationId,
        organizationSlug: active.organizationSlug ?? null,
      })
      return 0
    }
    ctx.stdout(`${active.organizationSlug ?? active.organizationId}\n`)
    return 0
  }

  if (sub === "use") {
    const [target] = rest
    if (!target) return fail(ctx, args, "Usage: voyant org use <slug|id>", "usage")
    const match = setActiveOrg(apiUrl, target)
    if (!match) {
      return fail(
        ctx,
        args,
        `Not logged in to org "${target}" at ${apiUrl}. Run \`voyant org list\`.`,
        "org_not_found",
      )
    }
    if (wantsJson(args)) {
      printJson(ctx, {
        organizationId: match.organizationId,
        organizationSlug: match.organizationSlug ?? null,
      })
      return 0
    }
    ctx.stdout(
      `Active org for ${apiUrl} is now ${match.organizationSlug ?? match.organizationId}.\n`,
    )
    return 0
  }

  return fail(ctx, args, `Unknown org subcommand: ${sub}`, "usage")
}
