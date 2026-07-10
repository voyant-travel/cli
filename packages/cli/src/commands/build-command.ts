import { getStringFlag, parseArgs } from "../lib/args.js"
import { errorMessage, fail, printJson, wantsJson } from "../lib/output.js"
import type { CommandContext, CommandResult } from "../types.js"
import { type BuildProjectDeps, buildProject } from "./build.js"

export async function buildCommand(
  ctx: CommandContext,
  deps: BuildProjectDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  if (args.flags.help === true || args.flags.h === true) {
    ctx.stdout(`${BUILD_USAGE}\n`)
    return 0
  }

  try {
    const built = await buildProject(
      { cwd: ctx.cwd, configPath: getStringFlag(args, "config") },
      deps,
    )
    const report = {
      schemaVersion: "voyant.build.v1",
      ok: true,
      contentHash: built.manifest.graphHash,
      artifactRoot: built.artifactRoot,
      runtimeEntry: built.manifest.runtimeEntry,
      migrationCount: built.migrationPlan.migrations.length,
      files: built.manifest.files,
    }
    if (wantsJson(args)) return printJson(ctx, report)

    ctx.stdout(`voyant build: ${built.manifest.graphHash}\n`)
    ctx.stdout(`  artifacts  ${built.artifactRoot}\n`)
    ctx.stdout(`  runtime    ${built.manifest.runtimeEntry}\n`)
    ctx.stdout(`  migrations ${built.migrationPlan.migrations.length}\n`)
    return 0
  } catch (error) {
    return fail(ctx, args, `voyant build: ${errorMessage(error)}`, errorCode(error))
  }
}

const BUILD_USAGE = `voyant build - resolve the project and write deterministic .voyant artifacts

usage:
  voyant build [--config <path>] [--json]
`

function errorCode(error: unknown): string {
  return hasErrorCode(error) ? error.code : "build_failed"
}

function hasErrorCode(error: unknown): error is { code: string } {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  )
}
