import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import { errorMessage, fail, printJson, wantsJson } from "../lib/output.js"
import type { CommandContext, CommandResult } from "../types.js"
import {
  executeMigrations,
  type MigrationExecutionReport,
  type PlanMigrationsDeps,
  planMigrations,
} from "./migrate.js"

export async function migrateCommand(
  ctx: CommandContext,
  deps: PlanMigrationsDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, { booleanFlags: ["plan", "dry-run", "json", "help"] })
  if (args.flags.help === true || args.flags.h === true) {
    ctx.stdout(`${MIGRATE_USAGE}\n`)
    return 0
  }

  const options = {
    cwd: ctx.cwd,
    configPath: getStringFlag(args, "config"),
    deploymentArtifactsPath: getStringFlag(args, "deployment-artifacts"),
  }
  try {
    if (getBooleanFlag(args, "plan")) {
      const planned = await planMigrations(options, deps)
      const report = {
        schemaVersion: "voyant.migrate-plan.v1",
        ok: true,
        contentHash: planned.contentHash,
        migrationCount: planned.migrationPlan.migrations.length,
        plan: planned.migrationPlan,
      }
      if (wantsJson(args)) return printJson(ctx, report)
      printPlan(ctx, planned.contentHash, planned.migrationPlan.migrations.length)
      return 0
    }

    const executed = await executeMigrations(
      { ...options, dryRun: getBooleanFlag(args, "dry-run") },
      deps,
    )
    const report = {
      ...executed.report,
      ok: executed.report.failed.length === 0,
      migrationCount: executed.plan.migrations.length,
      dryRun: getBooleanFlag(args, "dry-run"),
    }
    if (wantsJson(args)) {
      printJson(ctx, report)
    } else {
      printExecution(ctx, report)
    }
    return report.ok ? 0 : 1
  } catch (error) {
    return fail(ctx, args, `voyant migrate: ${errorMessage(error)}`, errorCode(error))
  }
}

const MIGRATE_USAGE = `voyant migrate - execute the current resolved graph migration plan

usage:
  voyant migrate [--config <path>] [--plan | --dry-run] [--json]
  voyant migrate --deployment-artifacts <path> [--plan | --dry-run] [--json]
`

function printPlan(ctx: CommandContext, contentHash: string, migrationCount: number): void {
  ctx.stdout(`voyant migrate: plan ${contentHash}\n`)
  ctx.stdout(`  migrations ${migrationCount}\n`)
}

function printExecution(
  ctx: CommandContext,
  report: MigrationExecutionReport & { dryRun: boolean },
): void {
  ctx.stdout(`voyant migrate: ${report.dryRun ? "dry-run" : "apply"} ${report.contentHash}\n`)
  ctx.stdout(`  applied ${report.applied.length}\n`)
  ctx.stdout(`  skipped ${report.skipped.length}\n`)
  ctx.stdout(`  failed  ${report.failed.length}\n`)
  for (const failure of report.failed) {
    ctx.stderr(`  ${failure.id}: ${failure.detail ?? "migration failed"}\n`)
  }
}

function errorCode(error: unknown): string {
  return hasErrorCode(error) ? error.code : "migration_failed"
}

function hasErrorCode(error: unknown): error is { code: string } {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  )
}
