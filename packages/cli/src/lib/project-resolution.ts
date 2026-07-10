import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveConfigPath } from "./config-loader.js"

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
  migrations: readonly unknown[]
  [key: string]: unknown
}

export interface FrameworkGeneratedProjectFile {
  path: string
  contents: string
}

export interface ResolvedProject {
  configPath: string
  projectRoot: string
  frameworkProjectModulePath: string
  graph: ResolvedProjectGraph
  artifacts: {
    runtimeEntry: string
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
  const frameworkModule = (await import(pathToFileURL(frameworkProjectModulePath).href)) as
    | FrameworkProjectResolverModule
    | undefined
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
    const source = await readFile(configPath, "utf8")
    const cacheKey = createHash("sha256").update(source).digest("hex")
    const imported = (await import(
      `${pathToFileURL(configPath).href}?voyant_config=${cacheKey}`
    )) as { default?: unknown }
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
  const files = parseGeneratedFiles(artifacts.files)
  if (!files.some((file) => file.path === runtimeEntry)) {
    throw contractError(`artifacts.runtimeEntry ${runtimeEntry} is not present in artifacts.files`)
  }
  const runtimeFile = files.find((file) => file.path === runtimeEntry)
  if (!runtimeFile?.contents.includes(graph.contentHash)) {
    throw contractError(`runtime entry ${runtimeEntry} must embed graph hash ${graph.contentHash}`)
  }

  const migrationPlan = parseMigrationPlan(artifacts.migrationPlan, graph.contentHash)
  return { graph, artifacts: { runtimeEntry, files, migrationPlan } }
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

function parseMigrationPlan(value: unknown, contentHash: string): ProjectMigrationPlan {
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
  return plan as ProjectMigrationPlan
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
