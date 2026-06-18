import { getStringFlag, parseArgs } from "../lib/args.js"
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

const USAGE = `Usage: voyant apps <command>

Manage Voyant Cloud apps in the active organization.

Commands:
  list                       List apps
  get <app>                  Show one app
  create <slug> [--name <n>] Create an app
  delete <app> --yes         Delete an app (and its external resources)

Options:
  --org <slug|id>            Target organization (when in more than one)
  --token <token>            Voyant Cloud API token
  --api-url <url>            Voyant Cloud API base URL
  --json                     Machine-readable output

Examples:
  voyant apps list --json
  voyant apps get web
  voyant apps create web --name "Web"
  voyant apps delete web --yes
`

export function appsCommand(ctx: CommandContext): CommandResult | Promise<CommandResult> {
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
        const apps = await client.apps.list()
        if (wantsJson(args)) return printJson(ctx, apps)
        if (apps.length === 0) return out(ctx, "No apps.\n")
        for (const a of apps) {
          ctx.stdout(`${a.slug.padEnd(24)} ${a.status.padEnd(10)} ${a.displayName}\n`)
        }
        return 0
      }
      case "get": {
        const [slug] = rest
        if (!slug) return fail(ctx, args, "Usage: voyant apps get <app>", "usage")
        const app = await client.apps.get(slug)
        return printJson(ctx, app)
      }
      case "create": {
        const [slug] = rest
        if (!slug) return fail(ctx, args, "Usage: voyant apps create <slug> [--name <n>]", "usage")
        const displayName = getStringFlag(args, "name") ?? slug
        const app = await client.apps.create({ slug, displayName })
        if (wantsJson(args)) return printJson(ctx, app)
        return out(ctx, `Created app ${app.slug}.\n`)
      }
      case "delete": {
        const [slug] = rest
        if (!slug) return fail(ctx, args, "Usage: voyant apps delete <app> --yes", "usage")
        if (!confirmDestructive(ctx, args, `delete app ${slug}`)) return 1
        await client.apps.delete(slug)
        if (wantsJson(args)) return printJson(ctx, { deleted: slug })
        return out(ctx, `Deleted app ${slug}.\n`)
      }
      default:
        return fail(ctx, args, `Unknown apps subcommand: ${sub}`, "usage")
    }
  })
}
