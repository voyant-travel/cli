import { parseArgs } from "../lib/args.js"
import { clientFromFlags, out, printJson, runCloud, wantsJson } from "../lib/output.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant vaults <subcommand>` — Voyant Cloud Vault operations.
 *
 * Subcommands:
 *   - `list` — list vaults in the active organization (names + secret counts)
 *
 * Listing returns metadata only; the CLI never decrypts. Manage individual
 * secrets with `voyant secrets <list|set|rm>`.
 */
export async function vaultsCommand(ctx: CommandContext): Promise<CommandResult> {
  const [sub, ...rest] = ctx.argv
  if (!sub || sub === "help") {
    ctx.stdout("Usage: voyant vaults <list>\n")
    return sub ? 0 : 1
  }

  if (sub === "list") {
    return vaultsListCommand({ ...ctx, argv: rest })
  }

  ctx.stderr(`Unknown vaults subcommand: ${sub}. Expected "list".\n`)
  return 1
}

async function vaultsListCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const client = clientFromFlags(ctx, args)
  if (!client) return 1

  return runCloud(ctx, args, async () => {
    const vaults = await client.vault.listVaults()
    if (wantsJson(args)) return printJson(ctx, vaults)
    if (vaults.length === 0) return out(ctx, "No vaults found.\n")
    for (const v of vaults) {
      const noun = v.secretCount === 1 ? "secret" : "secrets"
      ctx.stdout(`${v.slug} — ${v.name} (${v.secretCount} ${noun})\n`)
    }
    return 0
  })
}
