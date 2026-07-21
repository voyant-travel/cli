import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { DEPLOYMENT_ARTIFACT_SCHEMA_VERSION } from "./deployment-artifact-reader.js"
import {
  computeGraphContentHash,
  type ProjectMigrationPlan,
  parseMigrationPlan,
  projectRelativePath,
  RESOLVED_GRAPH_SCHEMA_VERSION,
  type ResolvedProject,
  type ResolvedProjectGraph,
  type ResolveProjectOptions,
  resolveProject,
  stableJson,
  writeFrameworkProjectArtifacts,
} from "./project-resolution.js"

export const PROJECT_ARTIFACTS_SCHEMA_VERSION = DEPLOYMENT_ARTIFACT_SCHEMA_VERSION
export const PROJECT_ARTIFACT_DIRECTORY = ".voyant" as const
export const PROJECT_ARTIFACT_MANIFEST = "deployment-artifacts.generated.json" as const
export const PROJECT_GRAPH_ARTIFACT = "deployment-graph.generated.json" as const
export const PROJECT_MIGRATION_PLAN_ARTIFACT = "migration-plan.generated.json" as const

const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

const CORE_ARTIFACT_PATHS = new Set<string>([
  PROJECT_ARTIFACT_MANIFEST,
  PROJECT_GRAPH_ARTIFACT,
  PROJECT_MIGRATION_PLAN_ARTIFACT,
])

export interface ProjectArtifactManifest {
  schemaVersion: typeof PROJECT_ARTIFACTS_SCHEMA_VERSION
  graphHash: string
  config: string
  graph: typeof PROJECT_GRAPH_ARTIFACT
  runtimeEntry: string
  runtimeEntries: readonly [
    {
      id: "project"
      target: "node"
      kind: "application"
      file: string
      graphHash: string
    },
  ]
  migrationPlan: typeof PROJECT_MIGRATION_PLAN_ARTIFACT
  migrationRunner: string
  files: readonly string[]
}

export interface LoadedProjectArtifacts {
  projectRoot: string
  artifactRoot: string
  manifest: ProjectArtifactManifest
  graph: ResolvedProjectGraph
  migrationPlan: ProjectMigrationPlan
  runtimeEntryPath: string
  migrationRunnerPath: string
}

export interface CheckedProjectArtifacts extends LoadedProjectArtifacts {
  resolution: ResolvedProject
}

/** Resolve with the installed framework, replace generated files, then reload every artifact. */
export async function prepareProjectArtifacts(
  cwd: string,
  options: ResolveProjectOptions = {},
): Promise<CheckedProjectArtifacts> {
  const resolution = await resolveProject(cwd, options)
  await writeProjectArtifacts(resolution)
  const loaded = await loadProjectArtifacts(resolution.projectRoot)
  return { ...loaded, resolution }
}

/** Resolve without writing and verify that persisted outputs represent the current config. */
export async function checkProjectArtifacts(
  cwd: string,
  options: ResolveProjectOptions = {},
): Promise<CheckedProjectArtifacts> {
  const resolution = await resolveProject(cwd, options)
  assertNoGraphErrors(resolution.graph)
  const result = await writeFrameworkProjectArtifacts(
    resolution,
    completeProjectArtifacts(resolution),
    "check",
  )
  if (!result.ok) throw artifactCheckError(result.files)
  const loaded = await loadProjectArtifacts(resolution.projectRoot)
  return { ...loaded, resolution }
}

export async function writeProjectArtifacts(resolution: ResolvedProject): Promise<void> {
  assertNoGraphErrors(resolution.graph)
  await writeFrameworkProjectArtifacts(resolution, completeProjectArtifacts(resolution), "write")
}

function completeProjectArtifacts(resolution: ResolvedProject): ResolvedProject["artifacts"] {
  const frameworkFiles = resolution.artifacts.files
  for (const file of frameworkFiles) {
    if (CORE_ARTIFACT_PATHS.has(file.path)) {
      throw new ProjectArtifactError(
        "artifact_invalid",
        `Framework generated file ${file.path} conflicts with a CLI-owned project artifact`,
      )
    }
  }

  const files = [
    PROJECT_GRAPH_ARTIFACT,
    PROJECT_MIGRATION_PLAN_ARTIFACT,
    ...frameworkFiles.map((file) => file.path),
  ].sort((left, right) => left.localeCompare(right))
  const manifest: ProjectArtifactManifest = {
    schemaVersion: PROJECT_ARTIFACTS_SCHEMA_VERSION,
    graphHash: resolution.graph.contentHash,
    config: projectRelativePath(resolution.projectRoot, resolution.configPath),
    graph: PROJECT_GRAPH_ARTIFACT,
    runtimeEntry: resolution.artifacts.runtimeEntry,
    runtimeEntries: [
      {
        id: "project",
        target: "node",
        kind: "application",
        file: resolution.artifacts.runtimeEntry,
        graphHash: resolution.graph.contentHash,
      },
    ],
    migrationPlan: PROJECT_MIGRATION_PLAN_ARTIFACT,
    migrationRunner: resolution.artifacts.migrationRunner,
    files,
  }

  return {
    ...resolution.artifacts,
    files: [
      ...frameworkFiles,
      { path: PROJECT_GRAPH_ARTIFACT, contents: stableJson(resolution.graph) },
      {
        path: PROJECT_MIGRATION_PLAN_ARTIFACT,
        contents: stableJson(resolution.artifacts.migrationPlan),
      },
      { path: PROJECT_ARTIFACT_MANIFEST, contents: stableJson(manifest) },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  }
}

export async function loadProjectArtifacts(projectRoot: string): Promise<LoadedProjectArtifacts> {
  const artifactRoot = join(projectRoot, PROJECT_ARTIFACT_DIRECTORY)
  const manifestPath = join(artifactRoot, PROJECT_ARTIFACT_MANIFEST)
  if (!existsSync(manifestPath)) {
    throw new ProjectArtifactError(
      "artifact_missing",
      `Generated project artifacts are missing at ${manifestPath}. Run \`voyant build\` or \`voyant develop\` to create .voyant/.`,
    )
  }

  const manifest = parseManifest(await readJson(manifestPath, "project artifact manifest"))
  for (const file of manifest.files) {
    if (!existsSync(join(artifactRoot, file))) {
      throw new ProjectArtifactError(
        "artifact_missing",
        `Generated project artifact is missing: ${join(PROJECT_ARTIFACT_DIRECTORY, file)}. Run \`voyant build\` or \`voyant develop\` to refresh .voyant/.`,
      )
    }
  }

  const graph = (await readJson(
    join(artifactRoot, manifest.graph),
    "generated deployment graph",
  )) as ResolvedProjectGraph
  if (graph.schemaVersion !== RESOLVED_GRAPH_SCHEMA_VERSION) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      `Generated deployment graph schema must be ${RESOLVED_GRAPH_SCHEMA_VERSION}`,
    )
  }
  if (graph.contentHash !== manifest.graphHash) {
    throw hashMismatch("deployment graph", graph.contentHash, manifest.graphHash)
  }
  const computedHash = computeGraphContentHash(graph)
  if (computedHash !== manifest.graphHash) {
    throw hashMismatch("canonical deployment graph", computedHash, manifest.graphHash)
  }

  let migrationPlan: ProjectMigrationPlan
  try {
    migrationPlan = parseMigrationPlan(
      await readJson(join(artifactRoot, manifest.migrationPlan), "generated migration plan"),
      manifest.graphHash,
    )
  } catch (error) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      error instanceof Error ? error.message : String(error),
    )
  }

  const runtimeEntryPath = join(artifactRoot, manifest.runtimeEntry)
  const runtimeSource = await readFile(runtimeEntryPath, "utf8")
  if (!runtimeSource.includes(manifest.graphHash)) {
    throw new ProjectArtifactError(
      "artifact_stale",
      `Generated runtime entry ${manifest.runtimeEntry} does not reference ${manifest.graphHash}. Run \`voyant build\` or \`voyant develop\` to refresh .voyant/.`,
    )
  }

  const migrationRunnerPath = join(artifactRoot, manifest.migrationRunner)
  const migrationRunnerSource = await readFile(migrationRunnerPath, "utf8")
  if (!migrationRunnerSource.includes(manifest.graphHash)) {
    throw new ProjectArtifactError(
      "artifact_stale",
      `Generated migration runner ${manifest.migrationRunner} does not reference ${manifest.graphHash}. Run \`voyant build\` or \`voyant develop\` to refresh .voyant/.`,
    )
  }

  return {
    projectRoot,
    artifactRoot,
    manifest,
    graph,
    migrationPlan,
    runtimeEntryPath,
    migrationRunnerPath,
  }
}

export class ProjectArtifactError extends Error {
  constructor(
    readonly code: "artifact_missing" | "artifact_stale" | "artifact_invalid",
    message: string,
  ) {
    super(message)
    this.name = "ProjectArtifactError"
  }
}

function assertNoGraphErrors(graph: ResolvedProjectGraph): void {
  const errors = graph.diagnostics.filter((diagnostic) => diagnostic.severity === "error")
  if (errors.length === 0) return
  const details = errors
    .map(
      (diagnostic) =>
        `${String(diagnostic.code ?? "UNKNOWN")}: ${String(diagnostic.message ?? "Graph resolution failed")}`,
    )
    .join("; ")
  throw new ProjectArtifactError(
    "artifact_invalid",
    `Resolved project graph contains ${errors.length} error diagnostic(s): ${details}`,
  )
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      `Could not read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function artifactCheckError(
  files: readonly { path: string; status: string }[],
): ProjectArtifactError {
  const missing = files.filter((file) => file.status === "missing").map((file) => file.path)
  const stale = files.filter((file) => file.status === "stale").map((file) => file.path)
  const details = [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined,
    stale.length > 0 ? `stale: ${stale.join(", ")}` : undefined,
  ].filter((detail): detail is string => detail !== undefined)
  const summary =
    missing.length > 0 ? (stale.length > 0 ? "are missing or stale" : "are missing") : "are stale"
  return new ProjectArtifactError(
    missing.length > 0 ? "artifact_missing" : "artifact_stale",
    `Generated project artifacts ${summary} (${details.join("; ")}). Run \`voyant build\` or \`voyant develop\` to refresh .voyant/.`,
  )
}

function parseManifest(value: unknown): ProjectArtifactManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      "Project artifact manifest must be an object",
    )
  }
  const manifest = value as Partial<ProjectArtifactManifest>
  if (manifest.schemaVersion !== PROJECT_ARTIFACTS_SCHEMA_VERSION) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      `Project artifact manifest schema must be ${PROJECT_ARTIFACTS_SCHEMA_VERSION}, got ${String(manifest.schemaVersion)}`,
    )
  }
  if (typeof manifest.graphHash !== "string" || !CONTENT_HASH_PATTERN.test(manifest.graphHash)) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      "Project artifact graphHash must match sha256:<64 lowercase hex characters>",
    )
  }
  if (manifest.graph !== PROJECT_GRAPH_ARTIFACT) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      `Project artifact graph must be ${PROJECT_GRAPH_ARTIFACT}`,
    )
  }
  if (manifest.migrationPlan !== PROJECT_MIGRATION_PLAN_ARTIFACT) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      `Project artifact migrationPlan must be ${PROJECT_MIGRATION_PLAN_ARTIFACT}`,
    )
  }
  if (
    typeof manifest.config !== "string" ||
    typeof manifest.runtimeEntry !== "string" ||
    typeof manifest.migrationRunner !== "string"
  ) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      "Project artifact config, runtimeEntry, and migrationRunner must be paths",
    )
  }
  if (
    !Array.isArray(manifest.runtimeEntries) ||
    manifest.runtimeEntries.length !== 1 ||
    manifest.runtimeEntries[0]?.id !== "project" ||
    manifest.runtimeEntries[0]?.target !== "node" ||
    manifest.runtimeEntries[0]?.kind !== "application" ||
    manifest.runtimeEntries[0]?.file !== manifest.runtimeEntry ||
    manifest.runtimeEntries[0]?.graphHash !== manifest.graphHash
  ) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      "Project artifact runtimeEntries must describe the generated Node application runtime",
    )
  }
  if (!Array.isArray(manifest.files) || !manifest.files.every(isSafeRelativePath)) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      "Project artifact files must contain safe relative paths",
    )
  }
  if (new Set(manifest.files).size !== manifest.files.length) {
    throw new ProjectArtifactError("artifact_invalid", "Project artifact files must be unique")
  }
  if (!isSafeRelativePath(manifest.runtimeEntry)) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      "Project artifact runtimeEntry must stay beneath .voyant/",
    )
  }
  if (!isSafeRelativePath(manifest.migrationRunner)) {
    throw new ProjectArtifactError(
      "artifact_invalid",
      "Project artifact migrationRunner must stay beneath .voyant/",
    )
  }
  for (const required of [
    manifest.graph,
    manifest.migrationPlan,
    manifest.runtimeEntry,
    manifest.migrationRunner,
  ]) {
    if (!manifest.files.includes(required)) {
      throw new ProjectArtifactError(
        "artifact_invalid",
        `Project artifact files must include ${required}`,
      )
    }
  }
  return manifest as ProjectArtifactManifest
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.replaceAll("\\", "/").split("/").includes("..") &&
    resolve("/artifact-root", value).startsWith("/artifact-root/")
  )
}

function hashMismatch(label: string, actual: unknown, expected: string): ProjectArtifactError {
  return new ProjectArtifactError(
    "artifact_stale",
    `Generated ${label} hash ${String(actual)} does not match ${expected}. Run \`voyant build\` or \`voyant develop\` to refresh .voyant/.`,
  )
}
