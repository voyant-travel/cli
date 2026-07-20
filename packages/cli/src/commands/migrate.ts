import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { LinkDefinition } from "@voyant-travel/core/links"
import {
  DeploymentArtifactError,
  readDeploymentGraphArtifact,
} from "../lib/deployment-artifact-reader.js"
import { type CheckedProjectArtifacts, prepareProjectArtifacts } from "../lib/project-artifacts.js"
import {
  loadProjectLinksArtifact,
  materializeProjectLinks,
  type ProjectLinkMigrationReport,
} from "../lib/project-link-migration.js"
import { loadProjectModule } from "../lib/project-module-loader.js"
import { type ProjectMigrationPlan, parseMigrationPlan } from "../lib/project-resolution.js"

const PROJECT_LINKS_ARTIFACT = "runtime/project-links.generated.ts"

export interface PlanMigrationsOptions {
  cwd: string
  configPath?: string
  deploymentArtifactsPath?: string
}

export interface MigrationStatus {
  id: string
  migrationKind: "schema" | "setup"
  status: "applied" | "skipped" | "failed"
  detail?: string
}

export interface MigrationExecutionReport {
  schemaVersion: "voyant.migration-result.v1"
  contentHash: string
  applied: readonly MigrationStatus[]
  skipped: readonly MigrationStatus[]
  failed: readonly MigrationStatus[]
}

interface MigrationArtifactSet {
  contentHash: string
  migrationPlan: ProjectMigrationPlan
  migrationRunnerPath: string
  projectLinkCount: number
  projectLinksPath?: string
}

interface MigrationRunnerModule {
  schemaVersion?: unknown
  contentHash?: unknown
  runVoyantMigrations?: (options: {
    dryRun?: boolean
  }) => MigrationExecutionReport | Promise<MigrationExecutionReport>
}

export interface PlanMigrationsDeps {
  prepareArtifacts?: typeof prepareProjectArtifacts
  loadRunner?: (path: string, contentHash: string) => Promise<MigrationRunnerModule>
  loadProjectLinks?: (path: string) => Promise<readonly LinkDefinition[]>
  syncProjectLinks?: (definitions: readonly LinkDefinition[]) => Promise<ProjectLinkMigrationReport>
}

/** Load and freshness-check the current graph's framework-authored migration plan. */
export async function planMigrations(
  options: PlanMigrationsOptions,
  deps: PlanMigrationsDeps = {},
): Promise<MigrationArtifactSet> {
  if (options.deploymentArtifactsPath) {
    return loadExplicitMigrationArtifacts(options.cwd, options.deploymentArtifactsPath)
  }
  const checked: CheckedProjectArtifacts = await (deps.prepareArtifacts ?? prepareProjectArtifacts)(
    options.cwd,
    { configPath: options.configPath },
  )
  const links = resolveProjectLinkArtifacts(
    checked.graph,
    checked.artifactRoot,
    checked.manifest.files,
  )
  return {
    contentHash: checked.manifest.graphHash,
    migrationPlan: checked.migrationPlan,
    migrationRunnerPath: checked.migrationRunnerPath,
    ...links,
  }
}

/** Execute the exact admitted Node runner bound to the checked migration plan. */
export async function executeMigrations(
  options: PlanMigrationsOptions & { dryRun?: boolean },
  deps: PlanMigrationsDeps = {},
): Promise<{
  plan: ProjectMigrationPlan
  report: MigrationExecutionReport
  links: ProjectLinkMigrationReport
}> {
  const planned = await planMigrations(options, deps)
  const definitions = planned.projectLinksPath
    ? await (deps.loadProjectLinks ?? loadProjectLinksArtifact)(planned.projectLinksPath)
    : []
  if (definitions.length !== planned.projectLinkCount) {
    throw new DeploymentArtifactError(
      "artifact_stale",
      `${PROJECT_LINKS_ARTIFACT} exports ${definitions.length} link definition(s), but the resolved graph selects ${planned.projectLinkCount}. Run \`voyant build\` to refresh project artifacts.`,
    )
  }
  const runner = await (deps.loadRunner ?? importMigrationRunner)(
    planned.migrationRunnerPath,
    planned.contentHash,
  )
  assertRunnerContract(runner, planned.contentHash)
  const report = await runner.runVoyantMigrations({ dryRun: options.dryRun })
  assertExecutionReport(report, planned.contentHash)
  const links =
    !options.dryRun && report.failed.length === 0
      ? await (deps.syncProjectLinks ?? materializeProjectLinks)(definitions)
      : pendingLinkReport(definitions)
  return { plan: planned.migrationPlan, report, links }
}

async function loadExplicitMigrationArtifacts(
  cwd: string,
  manifestPath: string,
): Promise<MigrationArtifactSet> {
  const artifact = readDeploymentGraphArtifact({ cwd, manifestPath })
  const migrationPlanRef = requireArtifactReference(
    artifact.manifest.migrationPlan,
    "migrationPlan",
  )
  const migrationRunnerRef = requireArtifactReference(
    artifact.manifest.migrationRunner,
    "migrationRunner",
  )
  const migrationPlanPath = resolveArtifactReference(artifact.rootDir, migrationPlanRef)
  const migrationRunnerPath = resolveArtifactReference(artifact.rootDir, migrationRunnerRef)
  if (!existsSync(migrationPlanPath) || !existsSync(migrationRunnerPath)) {
    throw new DeploymentArtifactError(
      "artifact_missing",
      "explicit deployment artifact must include its migration plan and executable runner",
    )
  }

  let rawPlan: unknown
  try {
    rawPlan = JSON.parse(await readFile(migrationPlanPath, "utf8"))
  } catch (error) {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      `could not read migration plan: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let migrationPlan: ProjectMigrationPlan
  try {
    migrationPlan = parseMigrationPlan(rawPlan, artifact.contentHash)
  } catch (error) {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      error instanceof Error ? error.message : String(error),
    )
  }
  const runnerSource = await readFile(migrationRunnerPath, "utf8")
  if (!runnerSource.includes(artifact.contentHash)) {
    throw new DeploymentArtifactError(
      "artifact_stale",
      `migration runner ${migrationRunnerRef} does not reference ${artifact.contentHash}`,
    )
  }
  return {
    contentHash: artifact.contentHash,
    migrationPlan,
    migrationRunnerPath,
    ...resolveProjectLinkArtifacts(
      artifact.graph,
      artifact.rootDir,
      Array.isArray(artifact.manifest.files) ? artifact.manifest.files : [],
    ),
  }
}

function resolveProjectLinkArtifacts(
  graph: Record<string, unknown>,
  artifactRoot: string,
  files: readonly unknown[],
): Pick<MigrationArtifactSet, "projectLinkCount" | "projectLinksPath"> {
  const projectLinkCount = countProjectLinks(graph)
  if (projectLinkCount === 0) return { projectLinkCount }
  if (!files.includes(PROJECT_LINKS_ARTIFACT)) {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      `Resolved graph selects ${projectLinkCount} link definition(s), but ${PROJECT_LINKS_ARTIFACT} is absent. Run \`voyant build\` with a current framework and retry \`voyant migrate\`; no separate link-sync command is required.`,
    )
  }
  const projectLinksPath = resolve(artifactRoot, PROJECT_LINKS_ARTIFACT)
  if (!existsSync(projectLinksPath)) {
    throw new DeploymentArtifactError(
      "artifact_missing",
      `Resolved graph selects ${projectLinkCount} link definition(s), but ${PROJECT_LINKS_ARTIFACT} is missing. Run \`voyant build\` and retry \`voyant migrate\`.`,
    )
  }
  return { projectLinkCount, projectLinksPath }
}

/**
 * Count the link definitions the framework artifact writer materializes into
 * `runtime/project-links.generated.ts`. This MUST stay aligned with the
 * framework's selection (see project-resolver.ts `selectedLinks` +
 * `generateSelectedLinksSource`): every `kind: "definition"` link that carries
 * a `source` and `export`, deduplicated by `id`, across all unit collections
 * (modules, extensions, plugins, adapters, providers). Project-convention link
 * files also land in the graph as `kind: "definition"` entries, so counting by
 * kind covers them without double-counting. `kind: "linkable"` entity
 * registrations emit no table and must be excluded.
 */
function countProjectLinks(graph: Record<string, unknown>): number {
  const seen = new Set<string>()
  for (const units of [
    graph.modules,
    graph.extensions,
    graph.plugins,
    graph.adapters,
    graph.providers,
  ]) {
    if (!Array.isArray(units)) continue
    for (const value of units) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const unit = value as Record<string, unknown>
      if (!Array.isArray(unit.links)) continue
      for (const entry of unit.links) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
        const link = entry as Record<string, unknown>
        if (
          link.kind !== "definition" ||
          typeof link.source !== "string" ||
          typeof link.export !== "string" ||
          typeof link.id !== "string"
        ) {
          continue
        }
        seen.add(link.id)
      }
    }
  }
  return seen.size
}

function pendingLinkReport(definitions: readonly LinkDefinition[]): ProjectLinkMigrationReport {
  const readOnly = definitions.filter((definition) => definition.readOnly).length
  return { discovered: definitions.length, materialized: 0, readOnly }
}

async function importMigrationRunner(
  path: string,
  _contentHash: string,
): Promise<MigrationRunnerModule> {
  // Load through the project module loader (jiti) rather than a native
  // `import()`. In a workspace worktree `@voyant-travel/framework` resolves to
  // TypeScript source, and the generated runner imports it (plus `.ts` setup
  // handlers) with NodeNext `.js` specifiers that native ESM cannot resolve.
  // jiti strips types and rewrites `.js`->`.ts` transitively, matching how the
  // resolver and link artifact are already loaded. `moduleCache: false` inside
  // the loader gives us the fresh evaluation the graph-hash query used to force.
  return loadProjectModule<MigrationRunnerModule>(path)
}

function assertRunnerContract(
  runner: MigrationRunnerModule,
  contentHash: string,
): asserts runner is {
  schemaVersion: "voyant.node-migration-runner.v1"
  contentHash: string
  runVoyantMigrations: NonNullable<MigrationRunnerModule["runVoyantMigrations"]>
} {
  if (runner.schemaVersion !== "voyant.node-migration-runner.v1") {
    throw new DeploymentArtifactError(
      "artifact_unsupported",
      `migration runner schema must be voyant.node-migration-runner.v1, got ${String(runner.schemaVersion)}`,
    )
  }
  if (runner.contentHash !== contentHash) {
    throw new DeploymentArtifactError(
      "artifact_stale",
      `migration runner hash ${String(runner.contentHash)} does not match ${contentHash}`,
    )
  }
  if (typeof runner.runVoyantMigrations !== "function") {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      "migration runner must export runVoyantMigrations(options)",
    )
  }
}

function assertExecutionReport(report: MigrationExecutionReport, contentHash: string): void {
  if (
    report?.schemaVersion !== "voyant.migration-result.v1" ||
    report.contentHash !== contentHash ||
    !Array.isArray(report.applied) ||
    !Array.isArray(report.skipped) ||
    !Array.isArray(report.failed)
  ) {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      "migration runner returned an invalid or stale execution report",
    )
  }
}

function requireArtifactReference(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      `deployment artifact ${label} must be a relative path`,
    )
  }
  return value
}

function resolveArtifactReference(root: string, reference: string): string {
  if (isAbsolute(reference)) {
    throw new DeploymentArtifactError("artifact_invalid", "artifact references must be relative")
  }
  const path = resolve(root, reference)
  const relativePath = relative(root, path)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new DeploymentArtifactError("artifact_invalid", `artifact reference escapes ${root}`)
  }
  return path
}
