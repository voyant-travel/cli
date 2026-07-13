import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  DeploymentArtifactError,
  readDeploymentGraphArtifact,
} from "../lib/deployment-artifact-reader.js"
import { type CheckedProjectArtifacts, prepareProjectArtifacts } from "../lib/project-artifacts.js"
import { type ProjectMigrationPlan, parseMigrationPlan } from "../lib/project-resolution.js"

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
  return {
    contentHash: checked.manifest.graphHash,
    migrationPlan: checked.migrationPlan,
    migrationRunnerPath: checked.migrationRunnerPath,
  }
}

/** Execute the exact admitted Node runner bound to the checked migration plan. */
export async function executeMigrations(
  options: PlanMigrationsOptions & { dryRun?: boolean },
  deps: PlanMigrationsDeps = {},
): Promise<{ plan: ProjectMigrationPlan; report: MigrationExecutionReport }> {
  const planned = await planMigrations(options, deps)
  const runner = await (deps.loadRunner ?? importMigrationRunner)(
    planned.migrationRunnerPath,
    planned.contentHash,
  )
  assertRunnerContract(runner, planned.contentHash)
  const report = await runner.runVoyantMigrations({ dryRun: options.dryRun })
  assertExecutionReport(report, planned.contentHash)
  return { plan: planned.migrationPlan, report }
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
  return { contentHash: artifact.contentHash, migrationPlan, migrationRunnerPath }
}

async function importMigrationRunner(
  path: string,
  contentHash: string,
): Promise<MigrationRunnerModule> {
  return import(
    `${pathToFileURL(path).href}?graph=${encodeURIComponent(contentHash)}`
  ) as Promise<MigrationRunnerModule>
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
