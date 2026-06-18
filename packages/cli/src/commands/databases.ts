import type { CreateCloudDatabaseInput } from "@voyant-travel/cloud-sdk"
import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import {
  clientFromFlags,
  confirmDestructive,
  fail,
  out,
  printJson,
  runCloud,
  wantsJson,
} from "../lib/output.js"
import type { CommandContext, CommandResult } from "../types.js"

const USAGE = `Usage: voyant databases <command>

Manage Voyant Cloud managed databases (Neon / D1 / Vectorize) in the active org.

Commands:
  list                           List databases
  get <id>                       Show one database
  create <name> [--kind neon]    Create a database (kind: neon | d1)
  delete <id> --yes              Delete a database
  branches <id>                  List branches
  connection <id> [--branch <b>] [--direct]
                                 Print a connection string

Options:
  --org <slug|id> --token <t> --api-url <url>
  --json                         Machine-readable output

Examples:
  voyant databases list --json
  voyant databases create app-db --kind neon
  voyant databases connection db_123 --json
`

export function databasesCommand(ctx: CommandContext): CommandResult | Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [sub, ...rest] = args.positionals

  if (!sub || sub === "help") {
    ctx.stdout(USAGE)
    return sub ? 0 : 1
  }

  const client = clientFromFlags(ctx, args)
  if (!client) return 1

  return runCloud(ctx, args, async () => {
    switch (sub) {
      case "list": {
        const dbs = await client.databases.list()
        if (wantsJson(args)) return printJson(ctx, dbs)
        if (dbs.length === 0) return out(ctx, "No databases.\n")
        for (const d of dbs) ctx.stdout(`${d.id.padEnd(24)} ${d.kind.padEnd(10)} ${d.name}\n`)
        return 0
      }
      case "get": {
        const [id] = rest
        if (!id) return fail(ctx, args, "Usage: voyant databases get <id>", "usage")
        return printJson(ctx, await client.databases.get(id))
      }
      case "create": {
        const [name] = rest
        if (!name)
          return fail(ctx, args, "Usage: voyant databases create <name> [--kind neon]", "usage")
        const kind = (getStringFlag(args, "kind") ?? "neon") as "neon" | "d1"
        if (kind !== "neon" && kind !== "d1") {
          return fail(ctx, args, `Unsupported --kind "${kind}" (use neon or d1).`, "usage")
        }
        const input = { kind, name } as CreateCloudDatabaseInput
        const db = await client.databases.create(input)
        if (wantsJson(args)) return printJson(ctx, db)
        return out(ctx, `Created ${kind} database ${db.name} (${db.id}).\n`)
      }
      case "delete": {
        const [id] = rest
        if (!id) return fail(ctx, args, "Usage: voyant databases delete <id> --yes", "usage")
        if (!confirmDestructive(ctx, args, `delete database ${id}`)) return 1
        await client.databases.delete(id)
        if (wantsJson(args)) return printJson(ctx, { deleted: id })
        return out(ctx, `Deleted database ${id}.\n`)
      }
      case "branches": {
        const [id] = rest
        if (!id) return fail(ctx, args, "Usage: voyant databases branches <id>", "usage")
        const branches = await client.databases.branches.list(id)
        if (wantsJson(args)) return printJson(ctx, branches)
        for (const b of branches) ctx.stdout(`${b.id.padEnd(28)} ${b.name}\n`)
        return 0
      }
      case "connection": {
        const [id] = rest
        if (!id) return fail(ctx, args, "Usage: voyant databases connection <id>", "usage")
        const conn = await client.databases.connectionUri(id, {
          branchId: getStringFlag(args, "branch"),
          pooled: !getBooleanFlag(args, "direct"),
        })
        if (wantsJson(args)) return printJson(ctx, conn)
        // Bare URL, no trailing newline — friendly for `$(voyant databases connection ...)`.
        return out(ctx, conn.connectionUrl)
      }
      default:
        return fail(ctx, args, `Unknown databases subcommand: ${sub}`, "usage")
    }
  })
}
