import type { VoyantCloudClient } from "@voyant-travel/cloud-sdk"
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

const USAGE = `Usage: voyant env <command> <app> [args] [--env <name>]

Manage an app environment's variables. Values are always masked on read.

Commands:
  list <app>                     List env vars for an environment
  set <app> <KEY> <value>        Create or update an env var
  rm <app> <KEY>                 Delete an env var

Options:
  --env <name>                   Environment name (default: production)
  --secret                       (set) Mark the value as a secret
  --org <slug|id>                Target organization
  --token <token> --api-url <url>
  --json                         Machine-readable output

Examples:
  voyant env list web --env production --json
  voyant env set web STRIPE_KEY sk_live_xyz --secret
  voyant env rm web OLD_KEY --yes
`

export function envCommand(ctx: CommandContext): CommandResult | Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [sub, appSlug, ...rest] = args.positionals

  if (!sub || sub === "help") {
    ctx.stdout(USAGE)
    return sub ? 0 : 1
  }
  if (!appSlug) return fail(ctx, args, `Usage: voyant env ${sub} <app> ...`, "usage")

  const client = clientFromFlags(ctx, args)
  if (!client) return 1
  const envName = getStringFlag(args, "env") ?? "production"

  return runCloud(ctx, args, async () => {
    const environmentId = await resolveEnvironmentId(client, appSlug, envName)
    if (!environmentId) {
      return fail(ctx, args, `App "${appSlug}" has no environment "${envName}".`, "env_not_found")
    }

    switch (sub) {
      case "list": {
        const vars = await client.apps.envVars.list(appSlug, environmentId)
        if (wantsJson(args)) return printJson(ctx, vars)
        if (vars.length === 0) return out(ctx, "No env vars.\n")
        for (const v of vars) ctx.stdout(`${v.key}=${v.value}\n`)
        return 0
      }
      case "set": {
        const [key, value] = rest
        if (!key || value === undefined) {
          return fail(ctx, args, "Usage: voyant env set <app> <KEY> <value>", "usage")
        }
        const created = await client.apps.envVars.create(appSlug, environmentId, {
          key,
          value,
          isSecret: getBooleanFlag(args, "secret"),
        })
        if (wantsJson(args)) return printJson(ctx, created)
        return out(ctx, `Set ${key} on ${appSlug}/${envName}.\n`)
      }
      case "rm": {
        const [key] = rest
        if (!key) return fail(ctx, args, "Usage: voyant env rm <app> <KEY>", "usage")
        const existing = await client.apps.envVars.list(appSlug, environmentId)
        const target = existing.find((v) => v.key === key)
        if (!target)
          return fail(ctx, args, `No env var "${key}" on ${appSlug}/${envName}.`, "not_found")
        if (!confirmDestructive(ctx, args, `delete ${key} on ${appSlug}/${envName}`)) return 1
        await client.apps.envVars.delete(appSlug, environmentId, target.id)
        if (wantsJson(args)) return printJson(ctx, { deleted: key })
        return out(ctx, `Deleted ${key} from ${appSlug}/${envName}.\n`)
      }
      default:
        return fail(ctx, args, `Unknown env subcommand: ${sub}`, "usage")
    }
  })
}

/** Resolve an environment name (e.g. "production") to its id for the SDK calls. */
async function resolveEnvironmentId(
  client: VoyantCloudClient,
  appSlug: string,
  envName: string,
): Promise<string | undefined> {
  const environments = await client.apps.environments.list(appSlug)
  return environments.find((e) => e.name === envName)?.id
}
