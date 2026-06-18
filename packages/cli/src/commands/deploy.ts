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

const USAGE = `Usage: voyant deploy <app> [--env <name>]
       voyant deploy <command> <app> [args]

Trigger and manage app deployments.

  voyant deploy <app>            Trigger a deployment (default: production)
  list <app>                     List deployments
  get <app> <id>                 Show one deployment
  logs <app> <id>                Show build logs
  cancel <app> <id> --yes        Cancel a running deployment
  rollback <app> <id> --yes      Roll back to a previous deployment

Options:
  --env <name>                   Environment (default: production)
  --org <slug|id> --token <t> --api-url <url>
  --json                         Machine-readable output

Examples:
  voyant deploy web
  voyant deploy list web --json
  voyant deploy rollback web dep_123 --yes
`

const SUBCOMMANDS = new Set(["list", "get", "logs", "cancel", "rollback", "help"])

export function deployCommand(ctx: CommandContext): CommandResult | Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [head, ...rest] = args.positionals

  if (!head || head === "help") {
    ctx.stdout(USAGE)
    return head ? 0 : 1
  }

  const client = clientFromFlags(ctx, args)
  if (!client) return 1

  // `voyant deploy <app>` (no known subcommand) triggers a deployment.
  if (!SUBCOMMANDS.has(head)) {
    const appSlug = head
    return runCloud(ctx, args, async () => {
      const environment = getStringFlag(args, "env") ?? "production"
      const deployment = await client.apps.deployments.create(appSlug, { environment })
      if (wantsJson(args)) return printJson(ctx, deployment)
      return out(ctx, `Triggered deployment ${deployment.id} for ${appSlug} (${environment}).\n`)
    })
  }

  const sub = head
  const [appSlug, deploymentId] = rest
  if (!appSlug) return fail(ctx, args, `Usage: voyant deploy ${sub} <app> ...`, "usage")

  return runCloud(ctx, args, async () => {
    switch (sub) {
      case "list": {
        const deployments = await client.apps.deployments.list(appSlug)
        if (wantsJson(args)) return printJson(ctx, deployments)
        if (deployments.length === 0) return out(ctx, "No deployments.\n")
        for (const d of deployments) {
          ctx.stdout(`${d.id.padEnd(24)} ${d.status.padEnd(10)} ${d.createdAt}\n`)
        }
        return 0
      }
      case "get": {
        if (!deploymentId) return fail(ctx, args, "Usage: voyant deploy get <app> <id>", "usage")
        return printJson(ctx, await client.apps.deployments.get(appSlug, deploymentId))
      }
      case "logs": {
        if (!deploymentId) return fail(ctx, args, "Usage: voyant deploy logs <app> <id>", "usage")
        const page = await client.apps.deployments.logs(appSlug, deploymentId)
        if (wantsJson(args)) return printJson(ctx, page)
        for (const line of page.entries) ctx.stdout(`${line.timestamp}  ${line.message}\n`)
        return 0
      }
      case "cancel": {
        if (!deploymentId) return fail(ctx, args, "Usage: voyant deploy cancel <app> <id>", "usage")
        if (!confirmDestructive(ctx, args, `cancel deployment ${deploymentId}`)) return 1
        const d = await client.apps.deployments.cancel(appSlug, deploymentId)
        if (wantsJson(args)) return printJson(ctx, d)
        return out(ctx, `Cancelled ${deploymentId}.\n`)
      }
      case "rollback": {
        if (!deploymentId)
          return fail(ctx, args, "Usage: voyant deploy rollback <app> <id>", "usage")
        if (!confirmDestructive(ctx, args, `roll back to deployment ${deploymentId}`)) return 1
        const d = await client.apps.deployments.rollback(appSlug, deploymentId)
        if (wantsJson(args)) return printJson(ctx, d)
        return out(ctx, `Rolled back to ${deploymentId} (new deployment ${d.id}).\n`)
      }
      default:
        return fail(ctx, args, `Unknown deploy subcommand: ${sub}`, "usage")
    }
  })
}
