import type { VaultSummary } from "@voyant-travel/cloud-sdk"

import { getStringFlag, parseArgs } from "../lib/args.js"
import { CloudAuthError, createCloudClient } from "../lib/cloud-client.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant vaults <subcommand>` — Voyant Cloud Vault operations.
 *
 * Subcommands:
 *   - `list` — list vaults visible to the current credential
 *
 * Mostly a first cloud surface that exercises the createCloudClient →
 * cloud-sdk pipe end-to-end. More subcommands (`get`, secret CRUD) follow
 * once the device-code login lands.
 */
export async function vaultsCommand(ctx: CommandContext): Promise<CommandResult> {
  const [sub, ...rest] = ctx.argv
  if (!sub) {
    ctx.stderr("Usage: voyant vaults <list>\n")
    return 1
  }

  if (sub === "list") {
    return vaultsListCommand({ ...ctx, argv: rest })
  }

  ctx.stderr(`Unknown vaults subcommand: ${sub}. Expected "list".\n`)
  return 1
}

async function vaultsListCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const json = args.flags.json === true

  let client: ReturnType<typeof createCloudClient>
  try {
    client = createCloudClient({
      token: getStringFlag(args, "token"),
      apiUrl: getStringFlag(args, "api-url"),
    })
  } catch (err) {
    if (err instanceof CloudAuthError) {
      ctx.stderr(`${err.message}\n`)
      return 1
    }
    throw err
  }

  let vaults: VaultSummary[]
  try {
    vaults = await client.vault.listVaults()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to list vaults: ${reason}\n`)
    return 1
  }

  if (json) {
    ctx.stdout(`${JSON.stringify(vaults, null, 2)}\n`)
    return 0
  }

  if (vaults.length === 0) {
    ctx.stdout("No vaults found.\n")
    return 0
  }

  for (const v of vaults) {
    const noun = v.secretCount === 1 ? "secret" : "secrets"
    ctx.stdout(`${v.slug} — ${v.name} (${v.secretCount} ${noun})\n`)
  }
  return 0
}
