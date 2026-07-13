import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import { errorMessage, fail, printJson, wantsJson } from "../lib/output.js"
import { loadProjectEnv, resolveProjectEnvRoot } from "../lib/project-env.js"
import {
  loadProjectTooling,
  requireToolingFunction,
  type VoyantProjectToolingModule,
} from "../lib/project-tooling.js"
import type { CommandContext, CommandResult } from "../types.js"
import { type BuildProjectDeps, buildProject } from "./build.js"

export { buildProject } from "./build.js"

export interface BuildCommandDeps extends BuildProjectDeps {
  env?: Record<string, string | undefined>
  loadEnv?: typeof loadProjectEnv
  loadTooling?: (projectRoot: string) => Promise<VoyantProjectToolingModule>
}

export async function buildCommand(
  ctx: CommandContext,
  deps: BuildCommandDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, { booleanFlags: ["help", "json", "artifacts-only"] })
  if (args.flags.help === true || args.flags.h === true) {
    ctx.stdout(`${BUILD_USAGE}\n`)
    return 0
  }

  try {
    const configPath = getStringFlag(args, "config")
    await (deps.loadEnv ?? loadProjectEnv)(
      resolveProjectEnvRoot(ctx.cwd, configPath),
      deps.env ?? process.env,
    )
    const built = await buildProject({ cwd: ctx.cwd, configPath }, deps)
    const report = {
      schemaVersion: "voyant.build.v1",
      ok: true,
      contentHash: built.manifest.graphHash,
      artifactRoot: built.artifactRoot,
      runtimeEntry: built.manifest.runtimeEntry,
      migrationCount: built.migrationPlan.migrations.length,
      files: built.manifest.files,
    }
    if (!getBooleanFlag(args, "artifacts-only")) {
      const tooling = await (deps.loadTooling ?? loadProjectTooling)(built.projectRoot)
      const buildVoyantProject = requireToolingFunction(tooling, "buildVoyantProject", "build")
      await buildVoyantProject({ projectRoot: built.projectRoot })
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

const BUILD_USAGE = `voyant build - prepare and build the full application

usage:
  voyant build [--config <path>] [--artifacts-only] [--json]

options:
  --config <path>    Use an explicit voyant.config.* file
  --artifacts-only   Stop after writing deterministic .voyant artifacts
  --json             Print the artifact report as JSON
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
