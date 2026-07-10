import { type CheckedProjectArtifacts, checkProjectArtifacts } from "../lib/project-artifacts.js"

export interface PlanMigrationsOptions {
  cwd: string
  configPath?: string
}

export interface PlanMigrationsDeps {
  checkArtifacts?: typeof checkProjectArtifacts
}

/** Load the current graph's framework-authored migration plan without applying it. */
export async function planMigrations(
  options: PlanMigrationsOptions,
  deps: PlanMigrationsDeps = {},
): Promise<CheckedProjectArtifacts> {
  return (deps.checkArtifacts ?? checkProjectArtifacts)(options.cwd, {
    configPath: options.configPath,
  })
}
