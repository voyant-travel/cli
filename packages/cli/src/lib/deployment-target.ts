import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

import type { DeploymentGraphArtifact } from "./deployment-artifact-reader.js"

export const DEPLOYMENT_PLAN_SCHEMA_VERSION = "voyant.deployment-plan.v1" as const
export const DEPLOYMENT_RESULT_SCHEMA_VERSION = "voyant.deployment-result.v1" as const
export const DOCKER_DEPLOYMENT_SCHEMA_VERSION = "voyant.docker-deployment.v1" as const
export const NODE_DEPLOYMENT_SCHEMA_VERSION = "voyant.node-deployment.v1" as const

export interface DeploymentPlanSource {
  artifactManifest: string
  graph: string
  contentHash: string
}

export interface DeploymentPlanOperation {
  id: string
  phase: "validate" | "build" | "provision" | "migrate" | "deploy" | "smoke-test"
  description: string
  command?: readonly string[]
}

export interface DeploymentPlan {
  schemaVersion: typeof DEPLOYMENT_PLAN_SCHEMA_VERSION
  target: string
  source: DeploymentPlanSource
  operations: readonly DeploymentPlanOperation[]
  outputs?: Record<string, string>
  metadata?: Record<string, unknown>
}

export interface DeploymentResult {
  schemaVersion: typeof DEPLOYMENT_RESULT_SCHEMA_VERSION
  target: string
  sourceContentHash: string
  plan: DeploymentPlan
  output?: unknown
}

export interface DeploymentTargetContext {
  cwd: string
  artifact: DeploymentGraphArtifact
  dryRun: boolean
  options: Readonly<Record<string, string | boolean>>
}

export interface DeploymentTargetAdapter {
  readonly name: string
  plan(context: DeploymentTargetContext): DeploymentPlan | Promise<DeploymentPlan>
  deploy(context: DeploymentTargetContext, plan: DeploymentPlan): unknown | Promise<unknown>
}

export interface DeploymentTargetRuntime {
  execute(command: readonly string[], cwd: string): { stdout: string }
  waitForHttpHealth(url: string, timeoutMs: number): Promise<void>
}

export function createDeploymentPlan(
  context: Pick<DeploymentTargetContext, "cwd" | "artifact">,
  target: string,
  operations: readonly DeploymentPlanOperation[],
  extra: Pick<DeploymentPlan, "outputs" | "metadata"> = {},
): DeploymentPlan {
  return {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    target,
    source: {
      artifactManifest: relativePosix(context.cwd, context.artifact.manifestPath),
      graph: relativePosix(context.cwd, context.artifact.graphPath),
      contentHash: context.artifact.contentHash,
    },
    operations,
    ...(extra.outputs ? { outputs: extra.outputs } : {}),
    ...(extra.metadata ? { metadata: extra.metadata } : {}),
  }
}

export function validateDeploymentPlan(
  plan: DeploymentPlan,
  context: DeploymentTargetContext,
  target: string,
): void {
  assertNodeDeployment(context.artifact)
  if (plan.schemaVersion !== DEPLOYMENT_PLAN_SCHEMA_VERSION) {
    throw new Error(
      `deployment target plan schema must be ${DEPLOYMENT_PLAN_SCHEMA_VERSION}, got ${String(
        plan.schemaVersion,
      )}`,
    )
  }
  if (plan.target !== target) {
    throw new Error(`deployment target plan target must be ${target}, got ${plan.target}`)
  }
  if (plan.source.contentHash !== context.artifact.contentHash) {
    throw new Error(
      `deployment target plan contentHash ${plan.source.contentHash} does not match source graph contentHash ${context.artifact.contentHash}`,
    )
  }
  if (!Array.isArray(plan.operations)) {
    throw new Error("deployment target plan operations must be an array")
  }
}

export function deploymentResult(plan: DeploymentPlan, output?: unknown): DeploymentResult {
  return {
    schemaVersion: DEPLOYMENT_RESULT_SCHEMA_VERSION,
    target: plan.target,
    sourceContentHash: plan.source.contentHash,
    plan,
    ...(output === undefined ? {} : { output }),
  }
}

export function createDockerDeploymentTargetAdapter(
  runtime: DeploymentTargetRuntime = defaultDeploymentTargetRuntime,
): DeploymentTargetAdapter {
  return {
    name: "docker",
    plan(context) {
      const outDir = stringOption(context.options, "out") ?? ".voyant/deploy/docker"
      const manifestPath = resolve(context.cwd, outDir, "compose.generated.json")
      const relativeManifestPath = relativePosix(context.cwd, manifestPath)
      const emitOnly = booleanOption(context.options, "emit-manifest")
      const image = stringOption(context.options, "image")
      const hostPort = positiveIntegerOption(context.options, "port") ?? 8080
      const healthUrl =
        stringOption(context.options, "health-url") ?? `http://127.0.0.1:${hostPort}/api/health`
      const healthTimeoutMs = positiveIntegerOption(context.options, "health-timeout-ms") ?? 30_000
      const compose = ["docker", "compose", "--file", relativeManifestPath] as const
      const deployCommand = [...compose, "up", "--detach", "--no-deps", "app"] as const
      const migrateCommand = [...compose, "run", "--rm", "migrate"] as const
      const buildCommand = [...compose, "build", "migrate", "app"] as const
      const operations: DeploymentPlanOperation[] = [
        {
          id: "validate-source-graph",
          phase: "validate",
          description: "Use the validated pre-resolved Node deployment graph artifact.",
        },
        {
          id: "emit-compose-manifest",
          phase: "build",
          description: `Emit the deterministic whole-application Compose manifest at ${relativeManifestPath}.`,
        },
      ]
      if (!emitOnly && !image) {
        operations.push({
          id: "docker-compose-build",
          phase: "build",
          description: "Build the whole-application Node image.",
          command: buildCommand,
        })
      }
      if (!emitOnly) {
        operations.push(
          {
            id: "docker-compose-migrate",
            phase: "migrate",
            description: "Run graph-selected migrations before starting the application.",
            command: migrateCommand,
          },
          {
            id: "docker-compose-up",
            phase: "deploy",
            description: "Start the whole Node application after migrations complete.",
            command: deployCommand,
          },
          {
            id: "http-health-check",
            phase: "smoke-test",
            description: `Wait for a successful HTTP health response from ${healthUrl}.`,
          },
        )
      }
      return createDeploymentPlan(context, "docker", operations, {
        outputs: { manifest: relativeManifestPath },
        metadata: { emitOnly, healthUrl, healthTimeoutMs, hostPort },
      })
    },
    async deploy(context, plan) {
      const manifestPath = resolve(context.cwd, requireOutput(plan, "manifest"))
      const completed: Array<{ id: string; phase: DeploymentPlanOperation["phase"] }> = []
      const stdout: string[] = []
      for (const operation of plan.operations) {
        if (operation.id === "validate-source-graph") {
          assertNodeDeployment(context.artifact)
        } else if (operation.id === "emit-compose-manifest") {
          const manifest = renderDockerDeploymentManifest(context, plan)
          mkdirSync(dirname(manifestPath), { recursive: true })
          writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
        } else if (operation.command) {
          const result = runtime.execute(operation.command, context.cwd)
          if (result.stdout) stdout.push(result.stdout)
        } else if (operation.id === "http-health-check") {
          await runtime.waitForHttpHealth(
            requireStringMetadata(plan, "healthUrl"),
            requireNumberMetadata(plan, "healthTimeoutMs"),
          )
        } else {
          throw new Error(`docker deployment operation ${operation.id} is not executable`)
        }
        completed.push({ id: operation.id, phase: operation.phase })
      }

      const applied = plan.metadata?.emitOnly !== true
      return {
        manifest: relativePosix(context.cwd, manifestPath),
        applied,
        operations: completed,
        ...(stdout.length > 0 ? { stdout: stdout.join("\n") } : {}),
      }
    },
  }
}

export function createNodeManifestDeploymentTargetAdapter(): DeploymentTargetAdapter {
  return {
    name: "custom",
    plan(context) {
      if (!booleanOption(context.options, "emit-manifest")) {
        throw new Error(
          "custom deployment target requires --emit-manifest when no project adapter is configured",
        )
      }
      const outDir = stringOption(context.options, "out") ?? ".voyant/deploy/custom"
      const manifestPath = resolve(context.cwd, outDir, "node-deployment.generated.json")
      const relativeManifestPath = relativePosix(context.cwd, manifestPath)
      return createDeploymentPlan(
        context,
        "custom",
        [
          {
            id: "validate-source-graph",
            phase: "validate",
            description: "Use the validated pre-resolved Node deployment graph artifact.",
          },
          {
            id: "emit-node-manifest",
            phase: "build",
            description: `Emit the portable Node deployment manifest at ${relativeManifestPath}.`,
          },
        ],
        {
          outputs: { manifest: relativeManifestPath },
          metadata: { emitOnly: true },
        },
      )
    },
    deploy(context, plan) {
      const manifestPath = resolve(context.cwd, requireOutput(plan, "manifest"))
      const manifest = renderNodeDeploymentManifest(context, manifestPath)
      mkdirSync(dirname(manifestPath), { recursive: true })
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      return { manifest: relativePosix(context.cwd, manifestPath), applied: false }
    },
  }
}

export async function loadCustomDeploymentTargetAdapter(
  cwd: string,
  entry: string,
): Promise<DeploymentTargetAdapter> {
  const entryPath = isAbsolute(entry) ? entry : resolve(cwd, entry)
  const imported = (await import(pathToFileURL(entryPath).href)) as {
    default?: unknown
    deploymentTargetAdapter?: unknown
  }
  const candidate = imported.default ?? imported.deploymentTargetAdapter
  if (!isDeploymentTargetAdapter(candidate)) {
    throw new Error(
      `custom deployment adapter at ${entryPath} must export a DeploymentTargetAdapter as default or deploymentTargetAdapter`,
    )
  }
  if (candidate.name !== "custom") {
    throw new Error(`custom deployment adapter name must be custom, got ${candidate.name}`)
  }
  return candidate
}

function renderDockerDeploymentManifest(
  context: DeploymentTargetContext,
  plan: DeploymentPlan,
): Record<string, unknown> {
  const manifestPath = resolve(context.cwd, requireOutput(plan, "manifest"))
  const buildContext = relativePosix(dirname(manifestPath), context.cwd)
  const dockerfile = stringOption(context.options, "dockerfile") ?? "Dockerfile"
  const image = stringOption(context.options, "image")
  const requiredEnv = collectRequiredEnvironment(context.artifact.graph.requirements)
  const hostPort = requireNumberMetadata(plan, "hostPort")
  const runtimeEntries = context.artifact.manifest.runtimeEntries.map((entry) => ({
    id: entry.id,
    target: entry.target,
    kind: entry.kind,
    file: entry.file,
    graphHash: entry.graphHash,
  }))
  const environment = {
    ...Object.fromEntries(
      requiredEnv.map((name) => [
        name,
        `\${${name}:?${name} is required by the Voyant deployment graph}`,
      ]),
    ),
    PORT: "8080",
  }
  const imageSource = image
    ? { image }
    : {
        build: {
          context: buildContext,
          dockerfile,
        },
      }
  const labels = {
    "travel.voyant.graph-content-hash": context.artifact.contentHash,
  }
  const artifactManifest = relativePosix(context.cwd, context.artifact.manifestPath)

  return {
    name: `voyant-${context.artifact.contentHash.slice("sha256:".length, "sha256:".length + 12)}`,
    services: {
      app: {
        ...imageSource,
        environment,
        labels,
        depends_on: {
          migrate: { condition: "service_completed_successfully" },
        },
        ports: [`${hostPort}:8080`],
      },
      migrate: {
        ...imageSource,
        command: ["pnpm", "exec", "voyant", "migrate", "--deployment-artifacts", artifactManifest],
        environment,
        labels,
        restart: "no",
      },
    },
    "x-voyant": {
      schemaVersion: DOCKER_DEPLOYMENT_SCHEMA_VERSION,
      source: {
        contentHash: context.artifact.contentHash,
        artifactManifest: relativePosix(dirname(manifestPath), context.artifact.manifestPath),
        graph: relativePosix(dirname(manifestPath), context.artifact.graphPath),
      },
      application: {
        modules: graphEntityIds(context.artifact.graph.modules),
        plugins: graphEntityIds(context.artifact.graph.plugins),
        runtimeEntries,
        requiredEnv,
        provisioning: context.artifact.graph.provisioning ?? {},
      },
    },
  }
}

function renderNodeDeploymentManifest(
  context: DeploymentTargetContext,
  manifestPath: string,
): Record<string, unknown> {
  const manifestDir = dirname(manifestPath)
  return {
    schemaVersion: NODE_DEPLOYMENT_SCHEMA_VERSION,
    target: "node",
    source: {
      contentHash: context.artifact.contentHash,
      artifactManifest: relativePosix(manifestDir, context.artifact.manifestPath),
      graph: relativePosix(manifestDir, context.artifact.graphPath),
    },
    application: {
      project: context.artifact.graph.project,
      deployment: context.artifact.graph.deployment,
      modules: graphEntityIds(context.artifact.graph.modules),
      plugins: graphEntityIds(context.artifact.graph.plugins),
      runtimeEntries: context.artifact.manifest.runtimeEntries.map((entry) => ({
        ...entry,
        file: relativePosix(manifestDir, resolve(context.artifact.rootDir, entry.file)),
        ...(entry.profileSnapshot
          ? {
              profileSnapshot: relativePosix(
                manifestDir,
                resolve(context.artifact.rootDir, entry.profileSnapshot),
              ),
            }
          : {}),
      })),
      requirements: context.artifact.graph.requirements,
      requiredEnv: collectRequiredEnvironment(context.artifact.graph.requirements),
      provisioning: context.artifact.graph.provisioning ?? {},
    },
  }
}

function collectRequiredEnvironment(requirements: Record<string, unknown>): string[] {
  const resources = Array.isArray(requirements.resources) ? requirements.resources : []
  const names = resources.flatMap((resource) => {
    if (!isRecord(resource) || !Array.isArray(resource.env)) return []
    return resource.env.flatMap((entry) => {
      if (!isRecord(entry) || entry.required !== true || typeof entry.name !== "string") return []
      return [entry.name]
    })
  })
  return [...new Set(names)].sort()
}

function graphEntityIds(entries: readonly Record<string, unknown>[]): string[] {
  return entries
    .flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []))
    .sort((left, right) => left.localeCompare(right))
}

function isDeploymentTargetAdapter(value: unknown): value is DeploymentTargetAdapter {
  if (!isRecord(value)) return false
  return (
    typeof value.name === "string" &&
    typeof value.plan === "function" &&
    typeof value.deploy === "function"
  )
}

const defaultDeploymentTargetRuntime: DeploymentTargetRuntime = {
  execute(command, cwd) {
    const executable = command[0]
    if (!executable) throw new Error("deployment operation command cannot be empty")
    const result = spawnSync(executable, command.slice(1), {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      const details = (result.stderr || result.stdout || "").trim()
      throw new Error(
        `deployment command ${command.join(" ")} failed with exit code ${String(result.status)}${details ? `: ${details}` : ""}`,
      )
    }
    return { stdout: result.stdout.trim() }
  },
  async waitForHttpHealth(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastFailure = "no response"
    while (Date.now() <= deadline) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(Math.min(2_000, timeoutMs)),
        })
        await response.body?.cancel()
        if (response.ok) return
        lastFailure = `HTTP ${response.status}`
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error)
      }
      if (Date.now() >= deadline) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
    throw new Error(`HTTP health check ${url} failed after ${timeoutMs}ms: ${lastFailure}`)
  },
}

function assertNodeDeployment(artifact: DeploymentGraphArtifact): void {
  const graphTarget = artifact.graph.deployment.target
  if (graphTarget !== undefined && graphTarget !== "node") {
    throw new Error(`deployment graph target must be node, got ${String(graphTarget)}`)
  }
  for (const entry of artifact.manifest.runtimeEntries) {
    if (entry.target !== "node") {
      throw new Error(
        `deployment runtime entry ${entry.id} target must be node, got ${entry.target}`,
      )
    }
  }
}

function booleanOption(options: Readonly<Record<string, string | boolean>>, name: string): boolean {
  return options[name] === true
}

function stringOption(
  options: Readonly<Record<string, string | boolean>>,
  name: string,
): string | undefined {
  const value = options[name]
  return typeof value === "string" ? value : undefined
}

function positiveIntegerOption(
  options: Readonly<Record<string, string | boolean>>,
  name: string,
): number | undefined {
  const value = stringOption(options, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return parsed
}

function requireStringMetadata(plan: DeploymentPlan, name: string): string {
  const value = plan.metadata?.[name]
  if (typeof value !== "string") throw new Error(`deployment plan metadata ${name} is missing`)
  return value
}

function requireNumberMetadata(plan: DeploymentPlan, name: string): number {
  const value = plan.metadata?.[name]
  if (typeof value !== "number") throw new Error(`deployment plan metadata ${name} is missing`)
  return value
}

function requireOutput(plan: DeploymentPlan, name: string): string {
  const value = plan.outputs?.[name]
  if (!value) throw new Error(`deployment target plan output ${name} is missing`)
  return value
}

function relativePosix(from: string, to: string): string {
  const path = relative(from, to) || "."
  return sep === "/" ? path : path.split(sep).join("/")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
