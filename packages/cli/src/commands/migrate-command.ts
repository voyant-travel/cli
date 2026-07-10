import { getStringFlag, parseArgs } from "../lib/args.js"
import { errorMessage, fail, printJson, wantsJson } from "../lib/output.js"
import type { CommandContext, CommandResult } from "../types.js"
import { type PlanMigrationsDeps, planMigrations } from "./migrate.js"

export async function migrateCommand(
  ctx: CommandContext,
  deps: PlanMigrationsDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  if (args.flags.help === true || args.flags.h === true) {
    ctx.stdout(`${MIGRATE_USAGE}\n`)
    return 0
  }

  try {
    const planned = await planMigrations(
      { cwd: ctx.cwd, configPath: getStringFlag(args, "config") },
      deps,
    )
    const report = {
      schemaVersion: "voyant.migrate-plan.v1",
      ok: true,
      contentHash: planned.manifest.graphHash,
      migrationCount: planned.migrationPlan.migrations.length,
      plan: planned.migrationPlan,
    }
    if (wantsJson(args)) return printJson(ctx, report)

    ctx.stdout(`voyant migrate: plan ${planned.manifest.graphHash}\n`)
    ctx.stdout(`  migrations ${planned.migrationPlan.migrations.length}\n`)
    return 0
  } catch (error) {
    return fail(ctx, args, `voyant migrate: ${errorMessage(error)}`, errorCode(error))
  }
}

const MIGRATE_USAGE = `voyant migrate - inspect the current resolved graph migration plan

usage:
  voyant migrate [--config <path>] [--json]
`

function errorCode(error: unknown): string {
  return hasErrorCode(error) ? error.code : "migration_plan_failed"
}

function hasErrorCode(error: unknown): error is { code: string } {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  )
}
