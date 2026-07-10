import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import { resolveConfigPath } from "../lib/config-loader.js"
import {
  type DeploymentGraphDiagnostic,
  type DeploymentGraphDoctorReport,
  formatDeploymentGraphDiagnostic,
  parseDeploymentGraphDoctorReport,
} from "../lib/deployment-graph-doctor-report.js"
import { printJson, wantsJson } from "../lib/output.js"
import { checkProjectArtifacts } from "../lib/project-artifacts.js"
import type { CommandContext, CommandResult } from "../types.js"
import { adminDoctorCommand } from "./admin-doctor.js"
import { dbDoctorCommand } from "./db-doctor.js"

/**
 * `voyant doctor [--config <path>] [--env-types <env.d.ts>] [--wrangler <file>]
 *   [--strict] [--skip-env] [--skip-db] [--skip-admin]`
 *
 * The single preflight a deployment runs before deploying / after upgrading.
 * Composes three checks and exits non-zero if any gate fails:
 *
 *  1. **env/bindings preflight** (this command) — the genuinely-new check.
 *     Required Cloudflare bindings are the non-optional fields of the
 *     `CloudflareBindings` interface in `env.d.ts`; each must be wired in
 *     `wrangler.jsonc` (KV → `kv_namespaces`, R2 → `r2_buckets`, secret/string
 *     → present in `.dev.vars`/env or `vars`). Placeholder values left in
 *     `wrangler.jsonc` (e.g. `replace-with-...`) fail the gate. Missing secrets
 *     are warnings unless `--strict` (they are often injected at deploy time).
 *  2. **deployment graph preflight** — generated graph artifacts must be
 *     present, hash-consistent, diagnostic-free, and point at the managed Node
 *     runtime entry when a deployment emits them.
 *  3. **`db doctor`** — schema/migration parity (unless `--skip-db`).
 *  4. **`admin doctor`** — manifest ↔ admin composition parity (unless
 *     `--skip-admin`).
 *
 * Designed to be run from a deployment's root.
 */
export async function doctorCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const strict = getBooleanFlag(args, "strict")
  if (wantsJson(args)) return doctorJsonCommand(ctx, { strict })

  let failed = false

  if (!getBooleanFlag(args, "skip-env")) {
    const code = runEnvPreflight(ctx, {
      strict,
      envTypesPath: getStringFlag(args, "env-types"),
      wranglerPath: getStringFlag(args, "wrangler"),
    })
    if (code !== 0) failed = true
  }

  if (!getBooleanFlag(args, "skip-deployment-graph")) {
    const result = await runConfiguredDeploymentGraphPreflight(ctx, args)
    if (result.exitCode !== 0) failed = true
  }

  if (!getBooleanFlag(args, "skip-db")) {
    ctx.stdout("\n› db doctor\n")
    const code = await dbDoctorCommand(ctx)
    if (code && code !== 0) failed = true
  }

  if (!getBooleanFlag(args, "skip-admin")) {
    ctx.stdout("\n› admin doctor\n")
    const code = await adminDoctorCommand(ctx)
    if (code && code !== 0) failed = true
  }

  ctx.stdout(failed ? "\nvoyant doctor: FAILED\n" : "\nvoyant doctor: OK\n")
  return failed ? 1 : 0
}

export type DoctorCheckId = "env" | "deployment-graph" | "db" | "admin"
export type DoctorCheckStatus = "passed" | "failed" | "skipped"

export interface DoctorJsonCheck {
  id: DoctorCheckId
  status: DoctorCheckStatus
  exitCode: number
  stdout: string
  stderr: string
  diagnostics?: readonly DeploymentGraphDiagnostic[]
  report?: DeploymentGraphDoctorReport
  contentHash?: string
}

export interface DoctorJsonReport {
  schemaVersion: "voyant.doctor.v1"
  ok: boolean
  checks: DoctorJsonCheck[]
}

async function doctorJsonCommand(
  ctx: CommandContext,
  options: { strict: boolean },
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const checks: DoctorJsonCheck[] = []

  if (getBooleanFlag(args, "skip-env")) {
    checks.push(skippedCheck("env"))
  } else {
    checks.push(
      await captureDoctorCheck(ctx, "env", async (subCtx) =>
        runEnvPreflight(subCtx, {
          strict: options.strict,
          envTypesPath: getStringFlag(args, "env-types"),
          wranglerPath: getStringFlag(args, "wrangler"),
        }),
      ),
    )
  }

  if (getBooleanFlag(args, "skip-deployment-graph")) {
    checks.push(skippedCheck("deployment-graph"))
  } else {
    checks.push(await captureDeploymentGraphDoctorCheck(ctx, args))
  }

  if (getBooleanFlag(args, "skip-db")) {
    checks.push(skippedCheck("db"))
  } else {
    checks.push(
      await captureDoctorCheck(ctx, "db", async (subCtx) => {
        subCtx.stdout("\n› db doctor\n")
        return dbDoctorCommand({ ...subCtx, argv: stripJsonOutputFlags(ctx.argv) })
      }),
    )
  }

  if (getBooleanFlag(args, "skip-admin")) {
    checks.push(skippedCheck("admin"))
  } else {
    checks.push(
      await captureDoctorCheck(ctx, "admin", async (subCtx) => {
        subCtx.stdout("\n› admin doctor\n")
        return adminDoctorCommand({ ...subCtx, argv: stripJsonOutputFlags(ctx.argv) })
      }),
    )
  }

  const failed = checks.some((check) => check.status === "failed")
  const report: DoctorJsonReport = {
    schemaVersion: "voyant.doctor.v1",
    ok: !failed,
    checks,
  }
  printJson(ctx, report)
  return failed ? 1 : 0
}

async function captureDeploymentGraphDoctorCheck(
  ctx: CommandContext,
  args: ReturnType<typeof parseArgs>,
): Promise<DoctorJsonCheck> {
  const stdout: string[] = []
  const stderr: string[] = []
  const result = await runConfiguredDeploymentGraphPreflight(
    {
      ...ctx,
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    },
    args,
  )
  const out = stdout.join("")
  return {
    id: "deployment-graph",
    status: result.exitCode === 0 ? inferPassedStatus("deployment-graph", out) : "failed",
    exitCode: result.exitCode,
    stdout: out,
    stderr: stderr.join(""),
    ...(result.contentHash ? { contentHash: result.contentHash } : {}),
    ...(result.report ? { report: result.report, diagnostics: result.report.diagnostics } : {}),
  }
}

function skippedCheck(id: DoctorCheckId): DoctorJsonCheck {
  return { id, status: "skipped", exitCode: 0, stdout: "", stderr: "" }
}

async function captureDoctorCheck(
  ctx: CommandContext,
  id: DoctorCheckId,
  run: (ctx: CommandContext) => CommandResult | Promise<CommandResult>,
): Promise<DoctorJsonCheck> {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode =
    (await run({
      ...ctx,
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    })) ?? 0
  const out = stdout.join("")
  return {
    id,
    status: exitCode === 0 ? inferPassedStatus(id, out) : "failed",
    exitCode,
    stdout: out,
    stderr: stderr.join(""),
  }
}

function inferPassedStatus(id: DoctorCheckId, stdout: string): DoctorCheckStatus {
  if (id === "env" && stdout.includes("env preflight: skipped")) return "skipped"
  if (id === "deployment-graph" && stdout.includes("deployment graph preflight: skipped")) {
    return "skipped"
  }
  return "passed"
}

function stripJsonOutputFlags(argv: ReadonlyArray<string>): string[] {
  const out: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue
    if (arg === "--json") continue
    if (arg === "--output" || arg === "-o") {
      const next = argv[index + 1]
      if (next === "json") {
        index += 1
        continue
      }
    }
    if (arg === "--output=json" || arg === "-o=json") continue
    out.push(arg)
  }
  return out
}

interface EnvPreflightOptions {
  strict: boolean
  envTypesPath?: string
  wranglerPath?: string
}

interface DeploymentGraphPreflightOptions {
  manifestPath?: string
  reportPath?: string
  doctorScriptPath?: string
}

interface DeploymentGraphPreflightResult {
  exitCode: 0 | 1
  report?: DeploymentGraphDoctorReport
  contentHash?: string
}

interface DeploymentArtifactManifest {
  schemaVersion?: unknown
  graphHash?: unknown
  graph?: unknown
  runtimeEntries?: unknown
}

interface RuntimeEntryArtifact {
  id?: unknown
  target?: unknown
  file?: unknown
  graphHash?: unknown
  kind?: unknown
  profileSnapshot?: unknown
}

interface ResolvedDeploymentGraph {
  schemaVersion?: unknown
  contentHash?: unknown
  diagnostics?: unknown
  deployment?: unknown
  requirements?: unknown
  modules?: unknown
  plugins?: unknown
  packageRecords?: unknown
}

interface DeploymentGraphResourceRequirement {
  resourceKey: string
  roles: readonly string[]
  provider: string
  required: boolean
  env: readonly DeploymentGraphEnvRequirement[]
  notes?: string
}

interface DeploymentGraphEnvRequirement {
  name: string
  kind: string
  required: boolean
  description: string
}

const ARTIFACT_MANIFEST_SCHEMA_VERSION = "voyant.deployment-artifacts.v1"
const RESOLVED_GRAPH_SCHEMA_VERSION = "voyant.resolved-graph.v1"
const DEPLOYMENT_ARTIFACTS_FILENAME = "deployment-artifacts.generated.json"
const DEPLOYMENT_GRAPH_DOCTOR_SCRIPT = join("scripts", "emit-deployment-graph.ts")
const EXPECTED_GRAPH_ARTIFACT = "deployment-graph.generated.json"
const EXPECTED_NODE_RUNTIME_ENTRY_ID = "@voyant-travel/framework#runtime.node"
const EXPECTED_NODE_RUNTIME_ENTRY_FILE = "src/runtime-entry.generated.ts"
const EXPECTED_NODE_RUNTIME_ENTRY_KIND = "managed-profile-node"
const EXPECTED_PROFILE_SNAPSHOT = "managed-profile.json"
const SHA256_CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

async function runConfiguredDeploymentGraphPreflight(
  ctx: CommandContext,
  args: ReturnType<typeof parseArgs>,
): Promise<DeploymentGraphPreflightResult> {
  const legacyOptions: DeploymentGraphPreflightOptions = {
    manifestPath: getStringFlag(args, "deployment-artifacts"),
    reportPath: getStringFlag(args, "deployment-graph-report"),
    doctorScriptPath: getStringFlag(args, "deployment-graph-doctor-script"),
  }
  const hasExplicitLegacyInput = Object.values(legacyOptions).some(Boolean)
  const configFlag = getStringFlag(args, "config")
  const configPath = resolveConfigPath({
    cwd: ctx.cwd,
    path: configFlag,
  })
  if (configFlag && !configPath && !hasExplicitLegacyInput) {
    ctx.stderr("deployment graph preflight: FAILED\n")
    ctx.stderr(`  - Voyant project config was not found: ${configFlag}\n`)
    return { exitCode: 1 }
  }
  if (!configPath || hasExplicitLegacyInput) {
    return runDeploymentGraphPreflightWithResult(ctx, legacyOptions)
  }

  try {
    const checked = await checkProjectArtifacts(ctx.cwd, { configPath })
    const moduleCount = Array.isArray(checked.graph.modules) ? checked.graph.modules.length : 0
    const pluginCount = Array.isArray(checked.graph.plugins) ? checked.graph.plugins.length : 0
    ctx.stdout(
      `deployment graph preflight: OK (${checked.manifest.contentHash}; ${moduleCount} modules; ${pluginCount} plugins; ${checked.migrationPlan.migrations.length} migrations)\n`,
    )
    return { exitCode: 0, contentHash: checked.manifest.contentHash }
  } catch (error) {
    ctx.stderr("deployment graph preflight: FAILED\n")
    ctx.stderr(`  - ${reason(error)}\n`)
    return { exitCode: 1 }
  }
}

/** Validate generated deployment graph artifacts when present at the deployment root. */
export function runDeploymentGraphPreflight(
  ctx: CommandContext,
  opts: DeploymentGraphPreflightOptions = {},
): CommandResult {
  return runDeploymentGraphPreflightWithResult(ctx, opts).exitCode
}

function runDeploymentGraphPreflightWithResult(
  ctx: CommandContext,
  opts: DeploymentGraphPreflightOptions = {},
): DeploymentGraphPreflightResult {
  const reportResult = loadDeploymentGraphDoctorReport(ctx.cwd, opts)
  if (reportResult.kind === "report") {
    writeDeploymentGraphDoctorReport(ctx, reportResult.report)
    return { exitCode: reportResult.report.ok ? 0 : 1, report: reportResult.report }
  }
  if (reportResult.kind === "failed") {
    ctx.stderr("deployment graph preflight: FAILED\n")
    ctx.stderr(`  - ${reportResult.message}\n`)
    return { exitCode: 1 }
  }

  const manifestPath = resolveDeploymentArtifactManifestPath(ctx.cwd, opts.manifestPath)
  if (!manifestPath) {
    ctx.stdout("deployment graph preflight: skipped (no deployment artifacts found)\n")
    return { exitCode: 0 }
  }

  try {
    const summary = loadDeploymentGraphArtifacts(manifestPath)
    const envIssues = deploymentGraphResourceEnvIssues(
      summary.resourceRequirements,
      dirname(manifestPath),
    )
    if (envIssues.length > 0) {
      ctx.stderr("deployment graph preflight: FAILED\n")
      for (const issue of envIssues) ctx.stderr(`  - ${issue}\n`)
      return { exitCode: 1 }
    }
    ctx.stdout(
      `deployment graph preflight: OK (${summary.graphHash}; ${summary.moduleCount} modules; ${summary.pluginCount} plugins; ${summary.packageCount} packages; ${summary.requiredEnvCount} required resource env)\n`,
    )
    return { exitCode: 0 }
  } catch (error) {
    ctx.stderr("deployment graph preflight: FAILED\n")
    ctx.stderr(`  - ${reason(error)}\n`)
    return { exitCode: 1 }
  }
}

function loadDeploymentGraphDoctorReport(
  cwd: string,
  opts: DeploymentGraphPreflightOptions,
):
  | { kind: "none" }
  | { kind: "failed"; message: string }
  | { kind: "report"; report: DeploymentGraphDoctorReport } {
  if (opts.reportPath) {
    try {
      return {
        kind: "report",
        report: parseDeploymentGraphDoctorReport(
          readFileSync(resolveDeploymentGraphPath(cwd, opts.reportPath), "utf8"),
        ),
      }
    } catch (error) {
      return { kind: "failed", message: reason(error) }
    }
  }

  const scriptPath = resolveDeploymentGraphDoctorScriptPath(cwd, opts.doctorScriptPath)
  if (!scriptPath) return { kind: "none" }

  const result = spawnSync("pnpm", ["exec", "tsx", scriptPath, "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  })
  const stdout = result.stdout ?? ""
  if (stdout.trim().length > 0) {
    try {
      return { kind: "report", report: parseDeploymentGraphDoctorReport(stdout) }
    } catch (error) {
      return {
        kind: "failed",
        message: `deployment graph doctor script emitted invalid JSON report: ${reason(error)}`,
      }
    }
  }
  if (result.error) {
    return { kind: "failed", message: reason(result.error) }
  }
  if (result.status && result.status !== 0) {
    const stderr = (result.stderr ?? "").trim()
    return {
      kind: "failed",
      message: stderr
        ? `deployment graph doctor script failed: ${stderr}`
        : `deployment graph doctor script failed with exit code ${result.status}`,
    }
  }
  return { kind: "none" }
}

function resolveDeploymentGraphPath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value)
}

function resolveDeploymentGraphDoctorScriptPath(
  cwd: string,
  scriptPath: string | undefined,
): string | null {
  if (scriptPath) return resolveDeploymentGraphPath(cwd, scriptPath)
  const candidate = join(cwd, DEPLOYMENT_GRAPH_DOCTOR_SCRIPT)
  return existsSync(candidate) ? candidate : null
}

function writeDeploymentGraphDoctorReport(
  ctx: CommandContext,
  report: DeploymentGraphDoctorReport,
): void {
  if (report.ok) {
    ctx.stdout(
      `deployment graph preflight: OK (${report.graph.contentHash}; ${report.graph.modules.count} modules; ${report.graph.plugins.count} plugins; ${report.graph.packageRecords.count} packages; ${report.diagnostics.length} diagnostics)\n`,
    )
    return
  }

  ctx.stderr("deployment graph preflight: FAILED\n")
  for (const diagnostic of report.diagnostics) {
    ctx.stderr(`  - ${formatDeploymentGraphDiagnostic(diagnostic)}\n`)
  }
}

function resolveDeploymentArtifactManifestPath(
  cwd: string,
  manifestPath: string | undefined,
): string | null {
  if (manifestPath) {
    return isAbsolute(manifestPath) ? manifestPath : resolve(cwd, manifestPath)
  }

  const candidates = [
    join(cwd, DEPLOYMENT_ARTIFACTS_FILENAME),
    join(cwd, "starters", "operator", DEPLOYMENT_ARTIFACTS_FILENAME),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function loadDeploymentGraphArtifacts(manifestPath: string): {
  graphHash: string
  moduleCount: number
  pluginCount: number
  packageCount: number
  requiredEnvCount: number
  resourceRequirements: readonly DeploymentGraphResourceRequirement[]
} {
  const manifest = readJsonFile<DeploymentArtifactManifest>(manifestPath, "deployment artifacts")
  if (manifest.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `deployment artifacts schema must be ${ARTIFACT_MANIFEST_SCHEMA_VERSION}, got ${String(
        manifest.schemaVersion,
      )}`,
    )
  }
  const manifestGraphHash = requireSha256ContentHash(
    manifest.graphHash,
    "deployment artifacts graphHash",
  )
  const graphPath = requireString(manifest.graph, "deployment artifacts graph")
  if (graphPath !== EXPECTED_GRAPH_ARTIFACT) {
    throw new Error(
      `deployment artifacts graph must be ${EXPECTED_GRAPH_ARTIFACT}, got ${graphPath}`,
    )
  }

  const graphFile = resolveRelativeArtifactPath(graphPath, manifestPath)
  const graph = readJsonFile<ResolvedDeploymentGraph>(graphFile, "deployment graph")
  if (graph.schemaVersion !== RESOLVED_GRAPH_SCHEMA_VERSION) {
    throw new Error(
      `deployment graph schema must be ${RESOLVED_GRAPH_SCHEMA_VERSION}, got ${String(
        graph.schemaVersion,
      )}`,
    )
  }

  const graphHash = requireSha256ContentHash(graph.contentHash, "deployment graph contentHash")
  const computedGraphHash = computeGraphContentHash(graph)
  if (computedGraphHash !== graphHash) {
    throw new Error(
      `deployment graph contentHash ${graphHash} does not match canonical graph hash ${computedGraphHash}`,
    )
  }
  if (manifestGraphHash !== graphHash) {
    throw new Error(
      `deployment artifact graphHash ${manifestGraphHash} does not match graph contentHash ${graphHash}`,
    )
  }

  const target = graphDeploymentTarget(graph)
  if (target !== "node") {
    throw new Error(`operator deployment graph target must be node, got ${String(target)}`)
  }

  const diagnostics = arrayOfRecords(graph.diagnostics, "deployment graph diagnostics")
  if (diagnostics.length > 0) {
    const details = diagnostics
      .map((diagnostic) =>
        [
          stringField(diagnostic, "code") ?? "unknown",
          stringField(diagnostic, "message") ?? "deployment graph diagnostic",
        ].join(": "),
      )
      .join("; ")
    throw new Error(`deployment graph has diagnostics: ${details}`)
  }

  const runtimeEntries = arrayOfRecords(
    manifest.runtimeEntries,
    "deployment artifacts runtimeEntries",
  ) as RuntimeEntryArtifact[]
  if (runtimeEntries.length === 0) {
    throw new Error("deployment artifacts must include at least one runtime entry")
  }

  let hasExpectedNodeRuntimeEntry = false
  for (const entry of runtimeEntries) {
    const id = requireString(entry.id, "runtime entry id")
    const entryTarget = requireString(entry.target, `runtime entry ${id} target`)
    const entryFile = requireString(entry.file, `runtime entry ${id} file`)
    const entryKind = requireString(entry.kind, `runtime entry ${id} kind`)
    const entryGraphHash = requireSha256ContentHash(
      entry.graphHash,
      `runtime entry ${id} graphHash`,
    )
    if (entryGraphHash !== graphHash) {
      throw new Error(
        `runtime entry ${id} graphHash ${entryGraphHash} does not match graph contentHash ${graphHash}`,
      )
    }

    const profileSnapshot = requireString(
      entry.profileSnapshot,
      `runtime entry ${id} profileSnapshot`,
    )
    if (id === EXPECTED_NODE_RUNTIME_ENTRY_ID) {
      if (entryTarget !== "node") {
        throw new Error(`runtime entry ${id} target must be node, got ${entryTarget}`)
      }
      if (entryFile !== EXPECTED_NODE_RUNTIME_ENTRY_FILE) {
        throw new Error(
          `runtime entry ${id} file must be ${EXPECTED_NODE_RUNTIME_ENTRY_FILE}, got ${entryFile}`,
        )
      }
      if (entryKind !== EXPECTED_NODE_RUNTIME_ENTRY_KIND) {
        throw new Error(
          `runtime entry ${id} kind must be ${EXPECTED_NODE_RUNTIME_ENTRY_KIND}, got ${entryKind}`,
        )
      }
      if (profileSnapshot !== EXPECTED_PROFILE_SNAPSHOT) {
        throw new Error(
          `runtime entry ${id} profileSnapshot must be ${EXPECTED_PROFILE_SNAPSHOT}, got ${profileSnapshot}`,
        )
      }
      hasExpectedNodeRuntimeEntry = true
    }

    const profileFile = resolveRelativeArtifactPath(profileSnapshot, manifestPath)
    if (!existsSync(profileFile)) {
      throw new Error(`runtime entry ${id} profile snapshot is missing: ${profileSnapshot}`)
    }
  }
  if (!hasExpectedNodeRuntimeEntry) {
    throw new Error(
      `deployment artifacts must include the managed node runtime entry ${EXPECTED_NODE_RUNTIME_ENTRY_ID}`,
    )
  }

  const resourceRequirements = collectResourceRequirements(graph.requirements)
  return {
    graphHash,
    moduleCount: arrayOfRecords(graph.modules, "deployment graph modules").length,
    pluginCount: arrayOfRecords(graph.plugins, "deployment graph plugins").length,
    packageCount: arrayOfRecords(graph.packageRecords, "deployment graph packageRecords").length,
    requiredEnvCount: resourceRequirements.reduce(
      (count, resource) => count + resource.env.filter((entry) => entry.required).length,
      0,
    ),
    resourceRequirements,
  }
}

function collectResourceRequirements(value: unknown): DeploymentGraphResourceRequirement[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("deployment graph requirements must be an object")
  }
  const resources = arrayOfRecords(
    (value as Record<string, unknown>).resources,
    "deployment graph requirements.resources",
  )
  return resources.map((resource, index) => {
    const env = arrayOfRecords(
      resource.env,
      `deployment graph requirements.resources[${index}].env`,
    ).map((entry, envIndex) => ({
      name: requireString(
        entry.name,
        `deployment graph requirements.resources[${index}].env[${envIndex}].name`,
      ),
      kind: requireString(
        entry.kind,
        `deployment graph requirements.resources[${index}].env[${envIndex}].kind`,
      ),
      required: requireBoolean(
        entry.required,
        `deployment graph requirements.resources[${index}].env[${envIndex}].required`,
      ),
      description: requireString(
        entry.description,
        `deployment graph requirements.resources[${index}].env[${envIndex}].description`,
      ),
    }))
    const notes = stringField(resource, "notes")
    return {
      resourceKey: requireString(
        resource.resourceKey,
        `deployment graph requirements.resources[${index}].resourceKey`,
      ),
      roles: collectStringArray(
        resource.roles,
        `deployment graph requirements.resources[${index}].roles`,
      ),
      provider: requireString(
        resource.provider,
        `deployment graph requirements.resources[${index}].provider`,
      ),
      required: requireBoolean(
        resource.required,
        `deployment graph requirements.resources[${index}].required`,
      ),
      env,
      ...(notes ? { notes } : {}),
    }
  })
}

function deploymentGraphResourceEnvIssues(
  resources: readonly DeploymentGraphResourceRequirement[],
  cwd: string,
): string[] {
  const env = collectDeploymentEnv(cwd)
  const issues: string[] = []
  for (const resource of resources) {
    for (const requirement of resource.env) {
      if (!requirement.required) continue
      const value = env.get(requirement.name)
      if (!value || value.trim().length === 0) {
        issues.push(
          `${requirement.kind} ${requirement.name} is required for ${resource.resourceKey}`,
        )
      }
    }
  }
  return [...new Set(issues)]
}

function collectDeploymentEnv(cwd: string): Map<string, string> {
  const env = new Map<string, string>()
  readEnvFileInto(env, join(cwd, ".env"))
  readEnvFileInto(env, join(cwd, ".dev.vars"))
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env.set(key, value)
  }
  return env
}

function readEnvFileInto(env: Map<string, string>, path: string): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const parsed = parseEnvLine(line)
    if (parsed) env.set(parsed.key, parsed.value)
  }
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
  if (!match?.[1]) return null
  const rawValue = match[2] ?? ""
  return { key: match[1], value: unquoteEnvValue(rawValue.trim()) }
}

function unquoteEnvValue(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function readJsonFile<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch (error) {
    throw new Error(`could not read ${label} at ${path}: ${reason(error)}`)
  }
}

function resolveRelativeArtifactPath(value: string, manifestPath: string): string {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
    throw new Error(`deployment artifact paths must be relative POSIX paths, got ${value}`)
  }
  return resolve(dirname(manifestPath), value)
}

function graphDeploymentTarget(graph: ResolvedDeploymentGraph): string | undefined {
  const deployment = graph.deployment
  return deployment && typeof deployment === "object"
    ? stringField(deployment as Record<string, unknown>, "target")
    : undefined
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`${label} must be a non-empty string`)
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value
  throw new Error(`${label} must be a boolean`)
}

function requireSha256ContentHash(value: unknown, label: string): string {
  const hash = requireString(value, label)
  if (SHA256_CONTENT_HASH_PATTERN.test(hash)) return hash
  throw new Error(`${label} must match sha256:<64 lowercase hex chars>, got ${hash}`)
}

function arrayOfRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((entry, index) => {
    if (entry && typeof entry === "object") return entry as Record<string, unknown>
    throw new Error(`${label}[${index}] must be an object`)
  })
}

function collectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`))
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === "string" ? value : undefined
}

function computeGraphContentHash(graph: ResolvedDeploymentGraph): string {
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

/** Run the env/bindings preflight against a deployment root. Returns exit code. */
export function runEnvPreflight(ctx: CommandContext, opts: EnvPreflightOptions): CommandResult {
  const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(ctx.cwd, p))
  const envTypes = resolvePath(opts.envTypesPath ?? "env.d.ts")
  const wrangler = resolvePath(opts.wranglerPath ?? "wrangler.jsonc")

  if (!existsSync(envTypes) || !existsSync(wrangler)) {
    // Not a Cloudflare-worker deployment root (or paths overridden wrong) —
    // skip silently rather than fail; db/admin doctor still run.
    ctx.stdout("env preflight: skipped (no env.d.ts / wrangler.jsonc at root)\n")
    return 0
  }

  const required = parseRequiredBindings(readFileSync(envTypes, "utf-8"))
  const wInfo = collectWranglerInfo(readFileSync(wrangler, "utf-8"))
  const present = presentSecretKeys(ctx.cwd)

  const errors: string[] = []
  const warnings: string[] = []

  for (const b of required) {
    if (b.category === "kv" && !wInfo.kvBindings.includes(b.name)) {
      errors.push(`required KV binding ${b.name} is not declared in wrangler.jsonc kv_namespaces`)
    } else if (b.category === "r2" && !wInfo.r2Bindings.includes(b.name)) {
      errors.push(`required R2 binding ${b.name} is not declared in wrangler.jsonc r2_buckets`)
    } else if (b.category === "secret" && !present.has(b.name) && !wInfo.vars.includes(b.name)) {
      const msg = `required value ${b.name} is not set (.dev.vars / env / wrangler vars)`
      ;(opts.strict ? errors : warnings).push(msg)
    }
  }
  for (const p of wInfo.placeholders) {
    errors.push(
      `placeholder value left in wrangler.jsonc: ${JSON.stringify(p)} — replace before deploy`,
    )
  }

  for (const w of warnings) ctx.stdout(`env preflight: WARN ${w}\n`)
  if (errors.length) {
    ctx.stderr("env preflight: FAILED\n")
    for (const e of errors) ctx.stderr(`  - ${e}\n`)
    return 1
  }
  ctx.stdout(
    `env preflight: OK (${required.length} required bindings; ${warnings.length} warning${warnings.length === 1 ? "" : "s"})\n`,
  )
  return 0
}

/**
 * Extract the required (non-optional) members of the `CloudflareBindings`
 * interface from an `env.d.ts` source, classified by binding category.
 * Optional members (`name?: T`) and commented lines are ignored.
 */
export function parseRequiredBindings(
  source: string,
): Array<{ name: string; category: "kv" | "r2" | "secret" | "other" }> {
  const start = source.indexOf("interface CloudflareBindings")
  if (start === -1) return []
  const open = source.indexOf("{", start)
  if (open === -1) return []
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}" && --depth === 0) {
      end = i
      break
    }
  }
  const body = source.slice(open + 1, end === -1 ? source.length : end)
  // Drop block comments, then scan line by line dropping line comments.
  const noBlock = body.replace(/\/\*[\s\S]*?\*\//g, "")
  const out: Array<{ name: string; category: "kv" | "r2" | "secret" | "other" }> = []
  for (const raw of noBlock.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim()
    // Required member: `NAME: Type` — exclude optional `NAME?:`.
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_<>[\]| ]+)/)
    const name = m?.[1]
    const type = m?.[2]
    if (!name || !type) continue
    if (raw.includes(`${name}?`)) continue
    const t = type.trim()
    const category = t.includes("KVNamespace")
      ? "kv"
      : t.includes("R2Bucket")
        ? "r2"
        : t === "string"
          ? "secret"
          : "other"
    out.push({ name, category })
  }
  return out
}

/** Parse a wrangler.jsonc: declared KV/R2 binding names, vars keys, and any
 * placeholder string values. */
export function collectWranglerInfo(source: string): {
  kvBindings: string[]
  r2Bindings: string[]
  vars: string[]
  placeholders: string[]
} {
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(stripJsonComments(source))
  } catch {
    return { kvBindings: [], r2Bindings: [], vars: [], placeholders: [] }
  }
  const bindingNames = (arr: unknown): string[] =>
    Array.isArray(arr)
      ? arr.map((e) => (e as { binding?: string })?.binding).filter((b): b is string => Boolean(b))
      : []
  const placeholders: string[] = []
  const PLACEHOLDER = /replace-with|<your-|your-[a-z-]+-id|changeme|^TODO$|xxxxxxxx/i
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (PLACEHOLDER.test(v)) placeholders.push(v)
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x)
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x)
    }
  }
  walk(config)
  return {
    kvBindings: bindingNames(config.kv_namespaces),
    r2Bindings: bindingNames(config.r2_buckets),
    vars: config.vars && typeof config.vars === "object" ? Object.keys(config.vars) : [],
    placeholders: [...new Set(placeholders)],
  }
}

/** Keys present in `.dev.vars` (KEY=value lines) plus process.env. */
function presentSecretKeys(cwd: string): Set<string> {
  const keys = new Set(Object.keys(process.env))
  const devVars = join(cwd, ".dev.vars")
  if (existsSync(devVars)) {
    for (const line of readFileSync(devVars, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
      if (m?.[1]) keys.add(m[1])
    }
  }
  return keys
}

/** Strip `//` and block comments from JSONC, preserving string contents. */
export function stripJsonComments(input: string): string {
  let out = ""
  let inStr = false
  let quote = ""
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    const n = input[i + 1]
    if (inStr) {
      out += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === quote) inStr = false
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      out += c
      continue
    }
    if (c === "/" && n === "/") {
      while (i < input.length && input[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (c === "/" && n === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  return out
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
