import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { resolveConfigPath } from "./config-loader.js"

export const DEPLOYMENT_ARTIFACT_SCHEMA_VERSION = "voyant.deployment-artifacts.v1" as const
export const RESOLVED_GRAPH_SCHEMA_VERSION = "voyant.resolved-graph.v1" as const
export const DEFAULT_DEPLOYMENT_ARTIFACT_PATH = join(
  ".voyant",
  "deployment-artifacts.generated.json",
)

const LEGACY_DEPLOYMENT_ARTIFACT_PATH = "deployment-artifacts.generated.json"
const SHA256_CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

export type DeploymentArtifactErrorCode =
  | "artifact_invalid"
  | "artifact_missing"
  | "artifact_stale"
  | "artifact_unsupported"

export class DeploymentArtifactError extends Error {
  constructor(
    readonly code: DeploymentArtifactErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "DeploymentArtifactError"
  }
}

export interface DeploymentRuntimeEntry {
  id: string
  target: string
  file: string
  graphHash: string
  kind: string
  profileSnapshot?: string
  [key: string]: unknown
}

export interface DeploymentArtifactManifest {
  schemaVersion: typeof DEPLOYMENT_ARTIFACT_SCHEMA_VERSION
  graphHash: string
  graph: string
  runtimeEntries: readonly DeploymentRuntimeEntry[]
  [key: string]: unknown
}

export interface ResolvedDeploymentGraph {
  schemaVersion: typeof RESOLVED_GRAPH_SCHEMA_VERSION
  contentHash: string
  project: Record<string, unknown>
  deployment: Record<string, unknown>
  requirements: Record<string, unknown>
  modules: readonly Record<string, unknown>[]
  plugins: readonly Record<string, unknown>[]
  packageRecords: readonly Record<string, unknown>[]
  diagnostics: readonly Record<string, unknown>[]
  [key: string]: unknown
}

export interface DeploymentGraphArtifact {
  manifestPath: string
  rootDir: string
  graphPath: string
  contentHash: string
  manifest: DeploymentArtifactManifest
  graph: ResolvedDeploymentGraph
}

export interface ReadDeploymentGraphArtifactOptions {
  cwd: string
  manifestPath?: string
}

export function readDeploymentGraphArtifact(
  options: ReadDeploymentGraphArtifactOptions,
): DeploymentGraphArtifact {
  const manifestPath = resolveManifestPath(options)
  const manifest = readJsonRecord(manifestPath, "deployment artifact manifest")

  if (manifest.schemaVersion !== DEPLOYMENT_ARTIFACT_SCHEMA_VERSION) {
    throw new DeploymentArtifactError(
      "artifact_unsupported",
      `deployment artifact schema must be ${DEPLOYMENT_ARTIFACT_SCHEMA_VERSION}, got ${String(
        manifest.schemaVersion,
      )}`,
    )
  }

  const rootDir = dirname(manifestPath)
  const graphReference = requireRelativeArtifactPath(manifest.graph, "deployment artifact graph")
  const graphPath = resolveArtifactReference(rootDir, graphReference)
  if (!existsSync(graphPath)) {
    throw new DeploymentArtifactError(
      "artifact_stale",
      `resolved deployment graph is missing: ${graphReference}`,
    )
  }
  const graph = readJsonRecord(graphPath, "resolved deployment graph")

  if (graph.schemaVersion !== RESOLVED_GRAPH_SCHEMA_VERSION) {
    throw new DeploymentArtifactError(
      "artifact_unsupported",
      `resolved deployment graph schema must be ${RESOLVED_GRAPH_SCHEMA_VERSION}, got ${String(
        graph.schemaVersion,
      )}`,
    )
  }

  const contentHash = requireContentHash(graph.contentHash, "resolved deployment graph contentHash")
  const computedHash = computeGraphContentHash(graph)
  if (computedHash !== contentHash) {
    throw new DeploymentArtifactError(
      "artifact_stale",
      `resolved deployment graph contentHash ${contentHash} does not match canonical graph hash ${computedHash}`,
    )
  }

  const manifestHash = requireContentHash(manifest.graphHash, "deployment artifact graphHash")
  if (manifestHash !== contentHash) {
    throw new DeploymentArtifactError(
      "artifact_stale",
      `deployment artifact graphHash ${manifestHash} does not match source graph contentHash ${contentHash}`,
    )
  }

  const runtimeEntries = requireRecordArray(
    manifest.runtimeEntries,
    "deployment artifact runtimeEntries",
  )
  if (runtimeEntries.length === 0) {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      "deployment artifact runtimeEntries must include at least one whole-application runtime entry",
    )
  }

  const normalizedEntries = runtimeEntries.map((entry, index) =>
    validateRuntimeEntry(entry, index, rootDir, contentHash),
  )
  const normalizedGraph = validateGraphShape(graph)

  return {
    manifestPath,
    rootDir,
    graphPath,
    contentHash,
    manifest: {
      ...manifest,
      schemaVersion: DEPLOYMENT_ARTIFACT_SCHEMA_VERSION,
      graphHash: manifestHash,
      graph: graphReference,
      runtimeEntries: normalizedEntries,
    },
    graph: normalizedGraph,
  }
}

function resolveManifestPath(options: ReadDeploymentGraphArtifactOptions): string {
  if (options.manifestPath) {
    const explicit = isAbsolute(options.manifestPath)
      ? options.manifestPath
      : resolve(options.cwd, options.manifestPath)
    if (existsSync(explicit)) return explicit
    throw new DeploymentArtifactError(
      "artifact_missing",
      `deployment artifact manifest not found at ${explicit}`,
    )
  }

  const unifiedProject = Boolean(resolveConfigPath({ cwd: options.cwd }))
  const candidates = [resolve(options.cwd, DEFAULT_DEPLOYMENT_ARTIFACT_PATH)]
  if (!unifiedProject) candidates.push(resolve(options.cwd, LEGACY_DEPLOYMENT_ARTIFACT_PATH))
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  throw new DeploymentArtifactError(
    "artifact_missing",
    `deployment artifact manifest not found; expected ${DEFAULT_DEPLOYMENT_ARTIFACT_PATH}`,
  )
}

function readJsonRecord(path: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      `could not read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isRecord(parsed)) {
    throw new DeploymentArtifactError("artifact_invalid", `${label} must be a JSON object`)
  }
  return parsed
}

function validateRuntimeEntry(
  entry: Record<string, unknown>,
  index: number,
  rootDir: string,
  contentHash: string,
): DeploymentRuntimeEntry {
  const label = `deployment artifact runtimeEntries[${index}]`
  const id = requireString(entry.id, `${label}.id`)
  const target = requireString(entry.target, `${label}.target`)
  const kind = requireString(entry.kind, `${label}.kind`)
  const file = requireRelativeArtifactPath(entry.file, `${label}.file`)
  const graphHash = requireContentHash(entry.graphHash, `${label}.graphHash`)
  if (graphHash !== contentHash) {
    throw new DeploymentArtifactError(
      "artifact_stale",
      `runtime entry ${id} graphHash ${graphHash} does not match source graph contentHash ${contentHash}`,
    )
  }
  requireExistingArtifactReference(rootDir, file, `${label}.file`)

  let profileSnapshot: string | undefined
  if (entry.profileSnapshot !== undefined) {
    profileSnapshot = requireRelativeArtifactPath(entry.profileSnapshot, `${label}.profileSnapshot`)
    requireExistingArtifactReference(rootDir, profileSnapshot, `${label}.profileSnapshot`)
  }

  return {
    ...entry,
    id,
    target,
    kind,
    file,
    graphHash,
    ...(profileSnapshot ? { profileSnapshot } : {}),
  }
}

function validateGraphShape(graph: Record<string, unknown>): ResolvedDeploymentGraph {
  const project = requireRecord(graph.project, "resolved deployment graph project")
  const deployment = requireRecord(graph.deployment, "resolved deployment graph deployment")
  const requirements = requireRecord(graph.requirements, "resolved deployment graph requirements")
  const modules = requireRecordArray(graph.modules, "resolved deployment graph modules")
  const plugins = requireRecordArray(graph.plugins, "resolved deployment graph plugins")
  const packageRecords = requireRecordArray(
    graph.packageRecords,
    "resolved deployment graph packageRecords",
  )
  const diagnostics = requireRecordArray(graph.diagnostics, "resolved deployment graph diagnostics")
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error")
  if (errors.length > 0) {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      `resolved deployment graph contains ${errors.length} error diagnostic(s)`,
    )
  }

  return {
    ...graph,
    schemaVersion: RESOLVED_GRAPH_SCHEMA_VERSION,
    contentHash: requireContentHash(graph.contentHash, "resolved deployment graph contentHash"),
    project,
    deployment,
    requirements,
    modules,
    plugins,
    packageRecords,
    diagnostics,
  }
}

function requireExistingArtifactReference(rootDir: string, value: string, label: string): void {
  const path = resolveArtifactReference(rootDir, value)
  if (!existsSync(path)) {
    throw new DeploymentArtifactError("artifact_stale", `${label} is missing: ${value}`)
  }
}

function resolveArtifactReference(rootDir: string, value: string): string {
  const path = resolve(rootDir, value)
  const fromRoot = relative(rootDir, path)
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      `deployment artifact path escapes its artifact root: ${value}`,
    )
  }
  return path
}

function requireRelativeArtifactPath(value: unknown, label: string): string {
  const path = requireString(value, label)
  if (isAbsolute(path) || path.includes("\\")) {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      `${label} must be a relative POSIX path, got ${path}`,
    )
  }
  return path
}

function requireContentHash(value: unknown, label: string): string {
  const hash = requireString(value, label)
  if (!SHA256_CONTENT_HASH_PATTERN.test(hash)) {
    throw new DeploymentArtifactError(
      "artifact_invalid",
      `${label} must match sha256:<64 lowercase hex characters>, got ${hash}`,
    )
  }
  return hash
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value
  throw new DeploymentArtifactError("artifact_invalid", `${label} must be a non-empty string`)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new DeploymentArtifactError("artifact_invalid", `${label} must be an object`)
}

function requireRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new DeploymentArtifactError("artifact_invalid", `${label} must be an array`)
  }
  return value.map((entry, index) => requireRecord(entry, `${label}[${index}]`))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function computeGraphContentHash(graph: Record<string, unknown>): string {
  const { contentHash: _contentHash, ...graphWithoutHash } = graph
  return `sha256:${createHash("sha256").update(canonicalJson(graphWithoutHash)).digest("hex")}`
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
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
