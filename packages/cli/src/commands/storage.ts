import { parseArgs } from "../lib/args.js"
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

const USAGE = `Usage: voyant storage <command>

Manage Voyant Cloud storage (R2) buckets in the active organization.

Commands:
  buckets list                   List buckets
  buckets create <name>          Create a bucket
  buckets delete <id> --yes      Delete a bucket

Options:
  --org <slug|id> --token <t> --api-url <url>
  --json                         Machine-readable output

Examples:
  voyant storage buckets list --json
  voyant storage buckets create uploads
`

export function storageCommand(ctx: CommandContext): CommandResult | Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [group, sub, ...rest] = args.positionals

  if (!group || group === "help") {
    ctx.stdout(USAGE)
    return group ? 0 : 1
  }
  if (group !== "buckets") {
    return fail(ctx, args, `Unknown storage group: ${group}`, "usage")
  }

  const client = clientFromFlags(ctx, args)
  if (!client) return 1

  return runCloud(ctx, args, async () => {
    switch (sub) {
      case "list": {
        const buckets = await client.storage.buckets.list()
        if (wantsJson(args)) return printJson(ctx, buckets)
        if (buckets.length === 0) return out(ctx, "No buckets.\n")
        for (const b of buckets) ctx.stdout(`${b.id.padEnd(28)} ${b.name}\n`)
        return 0
      }
      case "create": {
        const [name] = rest
        if (!name) return fail(ctx, args, "Usage: voyant storage buckets create <name>", "usage")
        const bucket = await client.storage.buckets.create({ name })
        if (wantsJson(args)) return printJson(ctx, bucket)
        return out(ctx, `Created bucket ${bucket.name} (${bucket.id}).\n`)
      }
      case "delete": {
        const [id] = rest
        if (!id) return fail(ctx, args, "Usage: voyant storage buckets delete <id> --yes", "usage")
        if (!confirmDestructive(ctx, args, `delete bucket ${id}`)) return 1
        await client.storage.buckets.delete(id)
        if (wantsJson(args)) return printJson(ctx, { deleted: id })
        return out(ctx, `Deleted bucket ${id}.\n`)
      }
      default:
        return fail(ctx, args, `Usage: voyant storage buckets <list|create|delete>`, "usage")
    }
  })
}
