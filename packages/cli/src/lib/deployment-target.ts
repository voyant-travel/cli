import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

import type { DeploymentGraphArtifact } from "./deployment-artifact-reader.js"

export const DEPLOYMENT_PLAN_SCHEMA_VERSION = "voyant.deployment-plan.v1" as const
export const DEPLOYMENT_RESULT_SCHEMA_VERSION = "voyant.deployment-result.v1" as const
export const DOCKER_DEPLOYMENT_SCHEMA_VERSION = "voyant.docker-deployment.v1" as const

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

export function createDockerDeploymentTargetAdapter(): DeploymentTargetAdapter {
  return {
    name: "docker",
    plan(context) {
      const outDir = stringOption(context.options, "out") ?? ".voyant/deploy/docker"
      const manifestPath = resolve(context.cwd, outDir, "compose.generated.json")
      const relativeManifestPath = relativePosix(context.cwd, manifestPath)
      const emitOnly = booleanOption(context.options, "emit-manifest")
      const command = [
        "docker",
        "compose",
        "--file",
        relativeManifestPath,
        "up",
        "--build",
        "--detach",
      ] as const
      return createDeploymentPlan(
        context,
        "docker",
        [
          {
            id: "validate-source-graph",
            phase: "validate",
            description: "Use the validated pre-resolved deployment graph artifact.",
          },
          {
            id: "emit-compose-manifest",
            phase: "build",
            description: `Emit the deterministic whole-application Compose manifest at ${relativeManifestPath}.`,
          },
          ...(!emitOnly
            ? [
                {
                  id: "docker-compose-up",
                  phase: "deploy" as const,
                  description: "Build and deploy the whole application with Docker Compose.",
                  command,
                },
              ]
            : []),
        ],
        {
          outputs: { manifest: relativeManifestPath },
          metadata: { emitOnly },
        },
      )
    },
    deploy(context, plan) {
      const manifest = renderDockerDeploymentManifest(context, plan)
      const manifestPath = resolve(context.cwd, requireOutput(plan, "manifest"))
      mkdirSync(dirname(manifestPath), { recursive: true })
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      if (plan.metadata?.emitOnly === true) {
        return { manifest: relativePosix(context.cwd, manifestPath), applied: false }
      }

      const operation = plan.operations.find((entry) => entry.id === "docker-compose-up")
      const command = operation?.command
      if (!command?.[0]) throw new Error("docker deployment plan is missing its apply command")
      const result = spawnSync(command[0], command.slice(1), {
        cwd: context.cwd,
        encoding: "utf8",
        stdio: "pipe",
      })
      if (result.error) throw result.error
      if (result.status !== 0) {
        const details = (result.stderr || result.stdout || "").trim()
        throw new Error(
          `docker compose deployment failed with exit code ${String(result.status)}${details ? `: ${details}` : ""}`,
        )
      }
      return {
        manifest: relativePosix(context.cwd, manifestPath),
        applied: true,
        stdout: result.stdout.trim(),
      }
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
  const runtimeEntries = context.artifact.manifest.runtimeEntries.map((entry) => ({
    id: entry.id,
    target: entry.target,
    kind: entry.kind,
    file: entry.file,
    graphHash: entry.graphHash,
  }))

  return {
    name: `voyant-${context.artifact.contentHash.slice("sha256:".length, "sha256:".length + 12)}`,
    services: {
      app: {
        ...(image
          ? { image }
          : {
              build: {
                context: buildContext,
                dockerfile,
              },
            }),
        environment: Object.fromEntries(
          requiredEnv.map((name) => [
            name,
            `\${${name}:?${name} is required by the Voyant deployment graph}`,
          ]),
        ),
        labels: {
          "travel.voyant.graph-content-hash": context.artifact.contentHash,
        },
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
