import { type CheckedProjectArtifacts, prepareProjectArtifacts } from "../lib/project-artifacts.js"

export interface BuildProjectOptions {
  cwd: string
  configPath?: string
}

export interface BuildProjectDeps {
  prepareArtifacts?: typeof prepareProjectArtifacts
}

/** Resolve and materialize the target-neutral project build under `.voyant/`. */
export async function buildProject(
  options: BuildProjectOptions,
  deps: BuildProjectDeps = {},
): Promise<CheckedProjectArtifacts> {
  return (deps.prepareArtifacts ?? prepareProjectArtifacts)(options.cwd, {
    configPath: options.configPath,
  })
}
