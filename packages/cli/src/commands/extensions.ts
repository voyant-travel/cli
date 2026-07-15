import { getStringFlag, parseArgs } from "../lib/args.js"
import { clientFromFlags, fail, out, printJson, runCloud, wantsJson } from "../lib/output.js"
import type { CommandContext, CommandResult } from "../types.js"
import { type ExtensionSummary, extensionSdk } from "./publish.js"

const USAGE = `Usage: voyant extensions <command>

Read admin UI extension catalog and installs.

Commands:
  list [--filter listed|installed|mine]  List extensions
  installs                              List installed extensions

Options:
  --org <slug|id>                       Target organization
  --token <token>                       Voyant Cloud API token
  --api-url <url>                       Voyant Cloud API base URL
  --json                                Machine-readable output

Examples:
  voyant extensions list --filter mine
  voyant extensions installs --json
`

const FILTERS = new Set(["listed", "installed", "mine"])

export function extensionsCommand(ctx: CommandContext): CommandResult | Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [sub] = args.positionals

  if (!sub || sub === "help") {
    ctx.stdout(USAGE)
    return sub ? 0 : 1
  }

  const client = clientFromFlags(ctx, args)
  if (!client) return 1
  const extensions = extensionSdk(client)

  return runCloud(ctx, args, async () => {
    switch (sub) {
      case "list": {
        const filter = getStringFlag(args, "filter")
        if (filter && !FILTERS.has(filter)) {
          return fail(
            ctx,
            args,
            `Unsupported extensions filter: ${filter}. Expected listed, installed, or mine.`,
            "usage",
          )
        }
        const rows = await extensions.list(filter ? { filter } : undefined)
        if (wantsJson(args)) return printJson(ctx, rows)
        return printExtensions(ctx, rows, "No extensions.\n")
      }
      case "installs": {
        const rows = await extensions.listInstalls()
        if (wantsJson(args)) return printJson(ctx, rows)
        return printInstalls(ctx, rows)
      }
      default:
        return fail(ctx, args, `Unknown extensions subcommand: ${sub}`, "usage")
    }
  })
}

function printExtensions(
  ctx: CommandContext,
  rows: ExtensionSummary[],
  emptyMessage: string,
): CommandResult {
  if (rows.length === 0) return out(ctx, emptyMessage)
  for (const row of rows) {
    const version = row.latestVersion ?? row.status ?? ""
    const visibility = row.visibility ?? ""
    const name = row.displayName ?? ""
    ctx.stdout(`${row.key.padEnd(28)} ${version.padEnd(12)} ${visibility.padEnd(10)} ${name}\n`)
  }
  return 0
}

function printInstalls(ctx: CommandContext, rows: ExtensionSummary[]): CommandResult {
  if (rows.length === 0) return out(ctx, "No extension installs.\n")
  for (const row of rows) {
    const app = row.appSlug ?? ""
    const env = row.environment ?? ""
    const version = row.latestVersion ?? row.status ?? ""
    ctx.stdout(`${row.key.padEnd(28)} ${app.padEnd(18)} ${env.padEnd(14)} ${version}\n`)
  }
  return 0
}
