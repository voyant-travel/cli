import { access } from "node:fs/promises"
import { join } from "node:path"

import { getBooleanFlag, getStringFlag, type ParsedArgs, parseArgs } from "../lib/args.js"
import { loadVoyantConfigFile, resolveConfigPath } from "../lib/config-loader.js"
import {
  DeploymentArtifactError,
  type DeploymentGraphArtifact,
  readDeploymentGraphArtifact,
} from "../lib/deployment-artifact-reader.js"
import {
  createDeploymentPlan,
  createDockerDeploymentTargetAdapter,
  createNodeManifestDeploymentTargetAdapter,
  type DeploymentPlan,
  type DeploymentTargetAdapter,
  type DeploymentTargetContext,
  deploymentResult,
  loadCustomDeploymentTargetAdapter,
  validateDeploymentPlan,
} from "../lib/deployment-target.js"
import {
  clientFromFlags,
  confirmDestructive,
  errorMessage,
  fail,
  out,
  printJson,
  runCloud,
  wantsJson,
} from "../lib/output.js"
import {
  checkProjectArtifacts,
  PROJECT_ARTIFACT_MANIFEST,
  ProjectArtifactError,
} from "../lib/project-artifacts.js"
import type { CommandContext, CommandResult } from "../types.js"

const USAGE = `Usage: voyant deploy [<app>] [--target <voyant-cloud|docker|custom>]
       voyant deploy <command> <app> [args]

Deploy a pre-resolved Voyant application graph. Voyant Cloud is the default target.

  voyant deploy [<app>]           Deploy the resolved graph to Voyant Cloud
  list <app>                      List Cloud deployments
  get <app> <id>                 Show one Cloud deployment
  logs <app> <id>                Show Cloud build logs
  cancel <app> <id> --yes        Cancel a running Cloud deployment
  rollback <app> <id> --yes      Roll back to a previous Cloud deployment

Deployment options:
  --target <target>              voyant-cloud (default), docker, or custom
  --deployment-artifacts <path>  Artifact manifest (default: .voyant/deployment-artifacts.generated.json)
  --dry-run                      Validate the artifact and print the target plan only
  --app <slug>                   Voyant Cloud app slug (alternative to <app>)
  --env <name>                   Cloud environment (default: production)
  --out <dir>                    Target manifest output directory
  --image <ref>                  Use an existing whole-application Docker image
  --dockerfile <path>            Dockerfile for the whole application (default: Dockerfile)
  --port <port>                  Published Docker host port (default: 8080)
  --health-url <url>             Docker HTTP smoke-test URL (default: http://127.0.0.1:8080/api/health)
  --health-timeout-ms <ms>       Docker HTTP smoke timeout (default: 30000)
  --emit-manifest                Emit a Docker or portable Node manifest without deploying
  --adapter <entry>              Override the project custom adapter entry
  --config <path>                Project config used to locate a custom adapter entry
  --org <slug|id> --token <t> --api-url <url>
  --json                         Machine-readable plan/result output

Examples:
  voyant deploy web
  voyant deploy web --dry-run --json
  voyant deploy --target docker --emit-manifest
  voyant deploy --target custom --emit-manifest
  voyant deploy list web --json
`

const SUBCOMMANDS = new Set(["list", "get", "logs", "cancel", "rollback", "help"])
const CLOUD_TARGETS = new Set(["cloud", "voyant-cloud"])

class CommandAlreadyFailedError extends Error {}

export function deployCommand(ctx: CommandContext): CommandResult | Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [head, ...rest] = args.positionals

  if (head === "help") {
    ctx.stdout(USAGE)
    return 0
  }

  if (head && SUBCOMMANDS.has(head)) {
    return cloudDeploymentManagementCommand(ctx, args, head, rest)
  }

  return deployResolvedGraph(ctx, args, head)
}

async function deployResolvedGraph(
  ctx: CommandContext,
  args: ParsedArgs,
  positionalAppSlug: string | undefined,
): Promise<CommandResult> {
  if (await isExtensionProject(ctx.cwd)) {
    return fail(
      ctx,
      args,
      "This directory contains voyant-extension.json. Extensions are published with `voyant publish`, not `voyant deploy`.",
      "extension_project",
    )
  }

  const requestedTarget = getStringFlag(args, "target") ?? "voyant-cloud"
  const target = CLOUD_TARGETS.has(requestedTarget) ? "voyant-cloud" : requestedTarget
  if (target !== "voyant-cloud" && target !== "docker" && target !== "custom") {
    return fail(
      ctx,
      args,
      `Unsupported deployment target: ${requestedTarget}. Expected voyant-cloud, docker, or custom.`,
      "unsupported_target",
    )
  }

  try {
    const artifact = await resolveDeploymentArtifact(ctx.cwd, args)
    const targetContext: DeploymentTargetContext = {
      cwd: ctx.cwd,
      artifact,
      dryRun: getBooleanFlag(args, "dry-run"),
      options: args.flags,
    }
    const adapter = await resolveDeploymentTargetAdapter(
      ctx,
      args,
      targetContext,
      target,
      positionalAppSlug,
    )
    const plan = await adapter.plan(targetContext)
    validateDeploymentPlan(plan, targetContext, target)

    if (targetContext.dryRun) {
      return writeDeploymentPlan(ctx, args, plan)
    }

    const output = await adapter.deploy(targetContext, plan)
    const result = deploymentResult(plan, output)
    if (wantsJson(args)) {
      if (target === "voyant-cloud" && isRecord(output)) {
        return printJson(ctx, {
          ...output,
          sourceContentHash: artifact.contentHash,
          plan,
        })
      }
      return printJson(ctx, result)
    }

    return writeDeploymentResult(ctx, result)
  } catch (error) {
    if (error instanceof CommandAlreadyFailedError) return 1
    const code =
      error instanceof DeploymentArtifactError || error instanceof ProjectArtifactError
        ? error.code
        : "deployment_failed"
    return fail(ctx, args, errorMessage(error), code)
  }
}

async function isExtensionProject(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, "voyant-extension.json"))
    return true
  } catch {
    return false
  }
}

async function resolveDeploymentArtifact(
  cwd: string,
  args: ParsedArgs,
): Promise<DeploymentGraphArtifact> {
  const explicitManifest = getStringFlag(args, "deployment-artifacts")
  if (explicitManifest) {
    return readDeploymentGraphArtifact({ cwd, manifestPath: explicitManifest })
  }

  const configOverride = getStringFlag(args, "config")
  const configPath = resolveConfigPath({ cwd, path: configOverride })
  if (configOverride || configPath) {
    const checked = await checkProjectArtifacts(cwd, { configPath: configOverride })
    return readDeploymentGraphArtifact({
      cwd: checked.projectRoot,
      manifestPath: join(checked.artifactRoot, PROJECT_ARTIFACT_MANIFEST),
    })
  }

  return readDeploymentGraphArtifact({ cwd })
}

async function resolveDeploymentTargetAdapter(
  ctx: CommandContext,
  args: ParsedArgs,
  targetContext: DeploymentTargetContext,
  target: string,
  positionalAppSlug: string | undefined,
): Promise<DeploymentTargetAdapter> {
  if (target === "docker") return createDockerDeploymentTargetAdapter()
  if (target === "custom") {
    const entry = await resolveCustomAdapterEntry(ctx.cwd, args, targetContext.artifact)
    return entry
      ? loadCustomDeploymentTargetAdapter(ctx.cwd, entry)
      : createNodeManifestDeploymentTargetAdapter()
  }

  const appSlug =
    getStringFlag(args, "app") ??
    positionalAppSlug ??
    graphProjectString(targetContext.artifact, "appSlug")
  if (!appSlug) {
    throw new Error(
      "Voyant Cloud deployment requires an app slug; pass <app>, --app <slug>, or emit project.appSlug in the resolved graph",
    )
  }
  const environment = getStringFlag(args, "env") ?? "production"
  return createCloudDeploymentTargetAdapter(ctx, args, appSlug, environment)
}

function createCloudDeploymentTargetAdapter(
  ctx: CommandContext,
  args: ParsedArgs,
  appSlug: string,
  environment: string,
): DeploymentTargetAdapter {
  return {
    name: "voyant-cloud",
    plan(context) {
      return createDeploymentPlan(
        context,
        "voyant-cloud",
        [
          {
            id: "validate-source-graph",
            phase: "validate",
            description: "Use the validated pre-resolved deployment graph artifact.",
          },
          {
            id: "trigger-cloud-deployment",
            phase: "deploy",
            description: `Trigger Voyant Cloud deployment for ${appSlug} (${environment}).`,
          },
        ],
        { metadata: { appSlug, environment } },
      )
    },
    async deploy(context) {
      const client = clientFromFlags(ctx, args)
      if (!client) throw new CommandAlreadyFailedError()
      return client.apps.deployments.create(appSlug, {
        environment,
        version: context.artifact.contentHash,
      })
    },
  }
}

async function resolveCustomAdapterEntry(
  cwd: string,
  args: ParsedArgs,
  artifact: DeploymentGraphArtifact,
): Promise<string | undefined> {
  const override = getStringFlag(args, "adapter")
  if (override) return override

  const artifactEntry = projectAdapterEntry(artifact.graph.project)
  if (artifactEntry) return artifactEntry

  const configPath = resolveConfigPath({ cwd, path: getStringFlag(args, "config") })
  if (configPath) {
    const loaded = await loadVoyantConfigFile<unknown>(configPath)
    const configEntry = projectAdapterEntry(loaded.config)
    if (configEntry) return configEntry
  }

  return undefined
}

function projectAdapterEntry(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.deploymentAdapter === "string") return value.deploymentAdapter
  if (!isRecord(value.meta)) return undefined
  const entry = value.meta.deploymentAdapter ?? value.meta.deploymentTargetAdapter
  return typeof entry === "string" ? entry : undefined
}

function graphProjectString(artifact: DeploymentGraphArtifact, key: string): string | undefined {
  const value = artifact.graph.project[key]
  if (typeof value === "string") return value
  const meta = artifact.graph.project.meta
  if (!isRecord(meta)) return undefined
  return typeof meta[key] === "string" ? meta[key] : undefined
}

function writeDeploymentPlan(ctx: CommandContext, args: ParsedArgs, plan: DeploymentPlan): 0 {
  if (wantsJson(args)) return printJson(ctx, plan)
  ctx.stdout(`Deployment plan (${plan.target})\n`)
  ctx.stdout(`Source graph: ${plan.source.contentHash}\n`)
  for (const operation of plan.operations) {
    ctx.stdout(`  ${operation.phase.padEnd(11)} ${operation.description}\n`)
  }
  return 0
}

function writeDeploymentResult(
  ctx: CommandContext,
  result: ReturnType<typeof deploymentResult>,
): 0 {
  if (result.target === "voyant-cloud" && isRecord(result.output)) {
    const deploymentId = typeof result.output.id === "string" ? result.output.id : "unknown"
    const appSlug = result.plan.metadata?.appSlug
    const environment = result.plan.metadata?.environment
    ctx.stdout(
      `Triggered deployment ${deploymentId} for ${String(appSlug)} (${String(environment)}).\n`,
    )
  } else if (result.target === "docker" && isRecord(result.output)) {
    ctx.stdout(`Docker manifest: ${String(result.output.manifest)}\n`)
    ctx.stdout(
      result.output.applied === true
        ? "Docker deployment applied.\n"
        : "Docker manifest emitted.\n",
    )
  } else if (isRecord(result.output) && typeof result.output.manifest === "string") {
    ctx.stdout(`Node deployment manifest: ${result.output.manifest}\n`)
  } else {
    ctx.stdout(`Deployment target ${result.target} completed.\n`)
  }
  ctx.stdout(`Source graph: ${result.sourceContentHash}\n`)
  return 0
}

function cloudDeploymentManagementCommand(
  ctx: CommandContext,
  args: ParsedArgs,
  sub: string,
  rest: string[],
): CommandResult | Promise<CommandResult> {
  const [appSlug, deploymentId] = rest
  if (!appSlug) return fail(ctx, args, `Usage: voyant deploy ${sub} <app> ...`, "usage")

  const client = clientFromFlags(ctx, args)
  if (!client) return 1

  return runCloud(ctx, args, async () => {
    switch (sub) {
      case "list": {
        const deployments = await client.apps.deployments.list(appSlug)
        if (wantsJson(args)) return printJson(ctx, deployments)
        if (deployments.length === 0) return out(ctx, "No deployments.\n")
        for (const deployment of deployments) {
          ctx.stdout(
            `${deployment.id.padEnd(24)} ${deployment.status.padEnd(10)} ${deployment.createdAt}\n`,
          )
        }
        return 0
      }
      case "get": {
        if (!deploymentId) return fail(ctx, args, "Usage: voyant deploy get <app> <id>", "usage")
        return printJson(ctx, await client.apps.deployments.get(appSlug, deploymentId))
      }
      case "logs": {
        if (!deploymentId) return fail(ctx, args, "Usage: voyant deploy logs <app> <id>", "usage")
        const page = await client.apps.deployments.logs(appSlug, deploymentId)
        if (wantsJson(args)) return printJson(ctx, page)
        for (const line of page.entries) ctx.stdout(`${line.timestamp}  ${line.message}\n`)
        return 0
      }
      case "cancel": {
        if (!deploymentId) return fail(ctx, args, "Usage: voyant deploy cancel <app> <id>", "usage")
        if (!confirmDestructive(ctx, args, `cancel deployment ${deploymentId}`)) return 1
        const deployment = await client.apps.deployments.cancel(appSlug, deploymentId)
        if (wantsJson(args)) return printJson(ctx, deployment)
        return out(ctx, `Cancelled ${deploymentId}.\n`)
      }
      case "rollback": {
        if (!deploymentId)
          return fail(ctx, args, "Usage: voyant deploy rollback <app> <id>", "usage")
        if (!confirmDestructive(ctx, args, `roll back to deployment ${deploymentId}`)) return 1
        const deployment = await client.apps.deployments.rollback(appSlug, deploymentId)
        if (wantsJson(args)) return printJson(ctx, deployment)
        return out(ctx, `Rolled back to ${deploymentId} (new deployment ${deployment.id}).\n`)
      }
      default:
        return fail(ctx, args, `Unknown deploy subcommand: ${sub}`, "usage")
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
