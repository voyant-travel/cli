import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { dirname, relative, resolve } from "node:path"

import { resolveConfigPath } from "./config-loader.js"
import { loadProjectConfigModule, loadProjectModule } from "./project-module-loader.js"

export const FRAMEWORK_PROJECT_RESOLVER_EXPORT = "resolveProject" as const
export const RESOLVED_GRAPH_SCHEMA_VERSION = "voyant.resolved-graph.v1" as const
export const MIGRATION_PLAN_SCHEMA_VERSION = "voyant.migration-plan.v1" as const

const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

export interface ResolvedProjectGraph {
  schemaVersion: typeof RESOLVED_GRAPH_SCHEMA_VERSION
  contentHash: string
  deployment?: {
    target?: unknown
    [key: string]: unknown
  }
  diagnostics: readonly ProjectGraphDiagnostic[]
  [key: string]: unknown
}

export interface ProjectGraphDiagnostic {
  code?: unknown
  severity?: unknown
  message?: unknown
  [key: string]: unknown
}

export interface ProjectMigrationPlan {
  schemaVersion: typeof MIGRATION_PLAN_SCHEMA_VERSION
  contentHash: string
  migrations: readonly ProjectMigration[]
  [key: string]: unknown
}

interface ProjectMigrationBase {
  id: string
  migrationKind: "schema" | "setup"
  order: number
  idempotencyKey: string
  owner: string
}

export type ProjectSchemaMigration = ProjectMigrationBase & {
  migrationKind: "schema"
} & (
    | {
        packageName: string
        source: { kind: "package"; packageName: string; path: string }
      }
    | {
        source: { kind: "deployment"; path: string }
      }
  )

export interface ProjectSetupMigration extends ProjectMigrationBase {
  migrationKind: "setup"
  packageName: string
  source: string
  runtime: { entry: string; export: string }
  dependsOn: readonly string[]
}

export type ProjectMigration = ProjectSchemaMigration | ProjectSetupMigration

export interface FrameworkGeneratedProjectFile {
  path: string
  contents: string
}

export type ProjectArtifactWriteMode = "write" | "check"
export type ProjectArtifactWriteStatus = "written" | "unchanged" | "missing" | "stale"

export interface ProjectArtifactWriteResult {
  mode: ProjectArtifactWriteMode
  outputRoot: string
  ok: boolean
  files: readonly {
    path: string
    status: ProjectArtifactWriteStatus
  }[]
}

export interface ResolvedProject {
  configPath: string
  projectRoot: string
  frameworkProjectModulePath: string
  graph: ResolvedProjectGraph
  artifacts: {
    runtimeEntry: string
    migrationRunner: string
    files: readonly FrameworkGeneratedProjectFile[]
    migrationPlan: ProjectMigrationPlan
  }
}

export interface ResolveProjectOptions {
  configPath?: string
}

interface FrameworkProjectResolverInput {
  project: unknown
  projectRoot: string
  configPath: string
}

interface FrameworkProjectResolverModule {
  resolveProject?: (input: FrameworkProjectResolverInput) => unknown | Promise<unknown>
  writeProjectArtifacts?: (input: {
    projectRoot: string
    artifacts: ResolvedProject["artifacts"]
    mode: ProjectArtifactWriteMode
  }) => unknown | Promise<unknown>
}

/**
 * Load the project's config and its installed framework resolver. The CLI owns
 * orchestration and persistence only; package discovery and graph closure stay
 * in the framework version selected by the project.
 */
export async function resolveProject(
  cwd: string,
  options: ResolveProjectOptions = {},
): Promise<ResolvedProject> {
  const configPath = resolveConfigPath({ cwd, path: options.configPath })
  if (!configPath) {
    throw new ProjectResolutionError(
      "config_missing",
      options.configPath
        ? `Voyant project config was not found: ${options.configPath}`
        : "No voyant.config.* found. Create voyant.config.ts with defineProject(...).",
    )
  }

  const projectRoot = dirname(configPath)
  const frameworkProjectModulePath = resolveFrameworkProjectModule(projectRoot)
  const frameworkModule = await loadProjectModule<FrameworkProjectResolverModule | undefined>(
    frameworkProjectModulePath,
  )
  const resolver = frameworkModule?.[FRAMEWORK_PROJECT_RESOLVER_EXPORT]
  if (typeof resolver !== "function") {
    throw new ProjectResolutionError(
      "framework_contract",
      `${frameworkProjectModulePath} must export ${FRAMEWORK_PROJECT_RESOLVER_EXPORT}({ project, projectRoot, configPath })`,
    )
  }

  const project = await loadProjectConfig(configPath)
  let rawResolution: unknown
  try {
    rawResolution = await resolver({ project, projectRoot, configPath })
  } catch (error) {
    throw new ProjectResolutionError(
      "resolution_failed",
      `Framework project resolution failed: ${errorMessage(error)}`,
    )
  }

  const resolution = parseFrameworkResolution(rawResolution)
  return {
    configPath,
    projectRoot,
    frameworkProjectModulePath,
    ...resolution,
  }
}

/** Persist or check artifacts through the framework version installed by the project. */
export async function writeFrameworkProjectArtifacts(
  resolution: ResolvedProject,
  artifacts: ResolvedProject["artifacts"],
  mode: ProjectArtifactWriteMode,
): Promise<ProjectArtifactWriteResult> {
  const frameworkModule = await loadProjectModule<FrameworkProjectResolverModule>(
    resolution.frameworkProjectModulePath,
  )
  const writer = frameworkModule.writeProjectArtifacts
  if (typeof writer !== "function") {
    throw new ProjectResolutionError(
      "framework_contract",
      `${resolution.frameworkProjectModulePath} must export writeProjectArtifacts({ projectRoot, artifacts, mode })`,
    )
  }

  let rawResult: unknown
  try {
    rawResult = await writer({ projectRoot: resolution.projectRoot, artifacts, mode })
  } catch (error) {
    throw new ProjectResolutionError(
      "resolution_failed",
      `Framework project artifact ${mode} failed: ${errorMessage(error)}`,
    )
  }
  return parseProjectArtifactWriteResult(rawResult, mode)
}

export class ProjectResolutionError extends Error {
  constructor(
    readonly code:
      | "config_missing"
      | "framework_missing"
      | "framework_contract"
      | "config_load_failed"
      | "resolution_failed",
    message: string,
  ) {
    super(message)
    this.name = "ProjectResolutionError"
  }
}

function resolveFrameworkProjectModule(projectRoot: string): string {
  const projectRequire = createRequire(resolve(projectRoot, "package.json"))
  try {
    return projectRequire.resolve("@voyant-travel/framework/project")
  } catch (error) {
    throw new ProjectResolutionError(
      "framework_missing",
      `Could not load the project's @voyant-travel/framework/project export: ${errorMessage(error)}`,
    )
  }
}

async function loadProjectConfig(configPath: string): Promise<unknown> {
  try {
    const imported = await loadProjectConfigModule<{ default?: unknown }>(configPath)
    if (imported.default === undefined) {
      throw new Error("config has no default export")
    }
    return imported.default
  } catch (error) {
    throw new ProjectResolutionError(
      "config_load_failed",
      `Failed to load Voyant project config at ${configPath}: ${errorMessage(error)}`,
    )
  }
}

function parseFrameworkResolution(value: unknown): Pick<ResolvedProject, "graph" | "artifacts"> {
  const resolution = requireRecord(value, "framework project resolution")
  const graph = parseResolvedGraph(resolution.graph)
  const artifacts = requireRecord(resolution.artifacts, "framework project resolution artifacts")
  const runtimeEntry = requireSafeRelativePath(
    artifacts.runtimeEntry,
    "framework project resolution artifacts.runtimeEntry",
  )
  const migrationRunner = requireSafeRelativePath(
    artifacts.migrationRunner,
    "framework project resolution artifacts.migrationRunner",
  )
  const files = parseGeneratedFiles(artifacts.files)
  if (!files.some((file) => file.path === runtimeEntry)) {
    throw contractError(`artifacts.runtimeEntry ${runtimeEntry} is not present in artifacts.files`)
  }
  if (!files.some((file) => file.path === migrationRunner)) {
    throw contractError(
      `artifacts.migrationRunner ${migrationRunner} is not present in artifacts.files`,
    )
  }
  const runtimeFile = files.find((file) => file.path === runtimeEntry)
  if (!runtimeFile?.contents.includes(graph.contentHash)) {
    throw contractError(`runtime entry ${runtimeEntry} must embed graph hash ${graph.contentHash}`)
  }

  const migrationPlan = parseMigrationPlan(artifacts.migrationPlan, graph.contentHash)
  const migrationRunnerFile = files.find((file) => file.path === migrationRunner)
  if (!migrationRunnerFile?.contents.includes(graph.contentHash)) {
    throw contractError(
      `migration runner ${migrationRunner} must embed graph hash ${graph.contentHash}`,
    )
  }
  return { graph, artifacts: { runtimeEntry, migrationRunner, files, migrationPlan } }
}

function parseResolvedGraph(value: unknown): ResolvedProjectGraph {
  const graph = requireRecord(value, "resolved graph")
  if (graph.schemaVersion !== RESOLVED_GRAPH_SCHEMA_VERSION) {
    throw contractError(
      `resolved graph schemaVersion must be ${RESOLVED_GRAPH_SCHEMA_VERSION}, got ${String(graph.schemaVersion)}`,
    )
  }
  const contentHash = requireContentHash(graph.contentHash, "resolved graph contentHash")
  const computedHash = computeGraphContentHash(graph)
  if (contentHash !== computedHash) {
    throw contractError(
      `resolved graph contentHash ${contentHash} does not match canonical graph hash ${computedHash}`,
    )
  }
  const deployment = graph.deployment
  if (deployment !== undefined) {
    const parsedDeployment = requireRecord(deployment, "resolved graph deployment")
    if (parsedDeployment.target !== undefined) {
      throw contractError(
        `resolved graph must be target-neutral; deployment.target was ${String(parsedDeployment.target)}`,
      )
    }
  }
  if (!Array.isArray(graph.diagnostics)) {
    throw contractError("resolved graph diagnostics must be an array")
  }
  for (const [index, diagnostic] of graph.diagnostics.entries()) {
    requireRecord(diagnostic, `resolved graph diagnostics[${index}]`)
  }
  return graph as ResolvedProjectGraph
}

function parseGeneratedFiles(value: unknown): FrameworkGeneratedProjectFile[] {
  if (!Array.isArray(value)) throw contractError("artifacts.files must be an array")
  const files = value.map((entry, index) => {
    const file = requireRecord(entry, `artifacts.files[${index}]`)
    const path = requireSafeRelativePath(file.path, `artifacts.files[${index}].path`)
    if (typeof file.contents !== "string") {
      throw contractError(`artifacts.files[${index}].contents must be a string`)
    }
    return { path, contents: file.contents }
  })
  const paths = files.map((file) => file.path)
  if (new Set(paths).size !== paths.length) {
    throw contractError("artifacts.files contains duplicate paths")
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function parseProjectArtifactWriteResult(
  value: unknown,
  expectedMode: ProjectArtifactWriteMode,
): ProjectArtifactWriteResult {
  const result = requireRecord(value, "framework project artifact write result")
  if (result.mode !== expectedMode) {
    throw contractError(
      `project artifact write result mode must be ${expectedMode}, got ${String(result.mode)}`,
    )
  }
  if (typeof result.outputRoot !== "string" || typeof result.ok !== "boolean") {
    throw contractError("project artifact write result outputRoot and ok are invalid")
  }
  if (!Array.isArray(result.files)) {
    throw contractError("project artifact write result files must be an array")
  }
  const files = result.files.map((value, index) => {
    const file = requireRecord(value, `project artifact write result files[${index}]`)
    const path = requireSafeRelativePath(
      file.path,
      `project artifact write result files[${index}].path`,
    )
    if (!isProjectArtifactWriteStatus(file.status)) {
      throw contractError(
        `project artifact write result files[${index}].status is invalid: ${String(file.status)}`,
      )
    }
    return { path, status: file.status }
  })
  return { mode: expectedMode, outputRoot: result.outputRoot, ok: result.ok, files }
}

function isProjectArtifactWriteStatus(value: unknown): value is ProjectArtifactWriteStatus {
  return value === "written" || value === "unchanged" || value === "missing" || value === "stale"
}

export function parseMigrationPlan(value: unknown, contentHash: string): ProjectMigrationPlan {
  const plan = requireRecord(value, "artifacts.migrationPlan")
  if (plan.schemaVersion !== MIGRATION_PLAN_SCHEMA_VERSION) {
    throw contractError(
      `artifacts.migrationPlan.schemaVersion must be ${MIGRATION_PLAN_SCHEMA_VERSION}, got ${String(plan.schemaVersion)}`,
    )
  }
  if (plan.contentHash !== contentHash) {
    throw contractError(
      `artifacts.migrationPlan.contentHash must match resolved graph ${contentHash}, got ${String(plan.contentHash)}`,
    )
  }
  if (!Array.isArray(plan.migrations)) {
    throw contractError("artifacts.migrationPlan.migrations must be an array")
  }
  const migrations = plan.migrations.map((entry, index) =>
    parseMigration(entry, index, plan.migrations as readonly unknown[]),
  )
  const ids = migrations.map((migration) => migration.id)
  const keys = migrations.map((migration) => migration.idempotencyKey)
  if (new Set(ids).size !== ids.length) {
    throw contractError("artifacts.migrationPlan contains duplicate migration ids")
  }
  if (new Set(keys).size !== keys.length) {
    throw contractError("artifacts.migrationPlan contains duplicate idempotency keys")
  }
  return {
    schemaVersion: MIGRATION_PLAN_SCHEMA_VERSION,
    contentHash,
    migrations,
  }
}

function parseMigration(value: unknown, index: number, all: readonly unknown[]): ProjectMigration {
  const label = `artifacts.migrationPlan.migrations[${index}]`
  const migration = requireRecord(value, label)
  const id = requireString(migration.id, `${label}.id`)
  const owner = requireString(migration.owner, `${label}.owner`)
  const idempotencyKey = requireString(migration.idempotencyKey, `${label}.idempotencyKey`)
  if (migration.order !== index) {
    throw contractError(`${label}.order must be ${index}, got ${String(migration.order)}`)
  }
  if (migration.migrationKind === "schema") {
    if (
      all
        .slice(0, index)
        .some(
          (entry) =>
            Boolean(entry) &&
            typeof entry === "object" &&
            (entry as { migrationKind?: unknown }).migrationKind === "setup",
        )
    ) {
      throw contractError(`${label} schema migrations must precede setup migrations`)
    }
    const source = requireRecord(migration.source, `${label}.source`)
    if (source.kind === "deployment") {
      return {
        id,
        migrationKind: "schema",
        order: index,
        idempotencyKey,
        owner,
        source: {
          kind: "deployment",
          path: requireString(source.path, `${label}.source.path`),
        },
      }
    }
    if (source.kind !== "package") {
      throw contractError(`${label}.source.kind must be package or deployment`)
    }
    const packageName = requireString(migration.packageName, `${label}.packageName`)
    return {
      id,
      migrationKind: "schema",
      order: index,
      idempotencyKey,
      owner,
      packageName,
      source: {
        kind: "package",
        packageName: requireString(source.packageName, `${label}.source.packageName`),
        path: requireString(source.path, `${label}.source.path`),
      },
    }
  }
  if (migration.migrationKind !== "setup") {
    throw contractError(`${label}.migrationKind must be schema or setup`)
  }
  const packageName = requireString(migration.packageName, `${label}.packageName`)
  const runtime = requireRecord(migration.runtime, `${label}.runtime`)
  if (!Array.isArray(migration.dependsOn) || !migration.dependsOn.every(isNonEmptyString)) {
    throw contractError(`${label}.dependsOn must be an array of non-empty ids`)
  }
  const priorIds = new Set(
    all
      .slice(0, index)
      .flatMap((entry) =>
        Boolean(entry) &&
        typeof entry === "object" &&
        isNonEmptyString((entry as { id?: unknown }).id)
          ? [(entry as { id: string }).id]
          : [],
      ),
  )
  if (migration.dependsOn.some((dependency) => !priorIds.has(dependency))) {
    throw contractError(`${label}.dependsOn must reference earlier migrations in the plan`)
  }
  return {
    id,
    migrationKind: "setup",
    order: index,
    idempotencyKey,
    owner,
    packageName,
    source: requireString(migration.source, `${label}.source`),
    runtime: {
      entry: requireString(runtime.entry, `${label}.runtime.entry`),
      export: requireString(runtime.export, `${label}.runtime.export`),
    },
    dependsOn: [...migration.dependsOn],
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireSafeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw contractError(`${label} must be a non-empty relative path`)
  }
  const normalized = value.replaceAll("\\", "/")
  const withoutPrefix = normalized.replace(/^\.\//, "")
  if (
    withoutPrefix.length === 0 ||
    withoutPrefix === "." ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw contractError(`${label} must stay beneath .voyant/, got ${value}`)
  }
  return withoutPrefix
}

function requireContentHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !CONTENT_HASH_PATTERN.test(value)) {
    throw contractError(`${label} must match sha256:<64 lowercase hex characters>`)
  }
  return value
}

function requireString(value: unknown, label: string): string {
  if (!isNonEmptyString(value)) throw contractError(`${label} must be a non-empty string`)
  return value
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function computeGraphContentHash(graph: Record<string, unknown>): string {
  const { contentHash: _contentHash, ...withoutHash } = graph
  return `sha256:${createHash("sha256").update(canonicalJson(withoutHash)).digest("hex")}`
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return sorted
}

function contractError(message: string): ProjectResolutionError {
  return new ProjectResolutionError(
    "framework_contract",
    `Invalid framework resolver result: ${message}`,
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function projectRelativePath(projectRoot: string, path: string): string {
  return relative(projectRoot, path).replaceAll("\\", "/")
}
