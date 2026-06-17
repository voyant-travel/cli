// `voyant workflows manifest --file <entry>`
//
// Build-time artifact: everything the cloud orchestrator needs to
// know about the user's workflows, *except* the `run` body. The body
// ships inside the deployed bundle; the manifest is consulted by the
// control plane when routing triggers, resolving schedules, and
// computing workflow versions.
//
// Pure: returns a POJO. The CLI command wraps this and serializes
// to JSON. Function-valued fields (concurrency.key as a function,
// schedule.input as a factory) are replaced by a `{ __dynamic: "function" }`
// sentinel so the output is deterministic and JSON-safe.

import { createHash } from "node:crypto"
import type {
  ConcurrencyPolicy,
  Duration,
  EnvironmentName,
  RetryPolicy,
  ScheduleDeclaration,
  WorkflowConfig,
  WorkflowDefinition,
} from "@voyant-travel/workflows"

export const MANIFEST_SCHEMA_VERSION = 1 as const

export interface Manifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  generatedAt: string
  entryFile: string
  workflows: ManifestWorkflow[]
}

export interface ManifestWorkflow {
  id: string
  /** 12-hex-char prefix of sha256(normalized run source). */
  version: string
  description?: string
  schedule?: ManifestSchedule[]
  concurrency?: ManifestConcurrency
  retry?: RetryPolicy
  timeout?: Duration
  defaultRuntime?: "edge" | "node"
  tags?: string[]
}

export const DYNAMIC_FUNCTION = { __dynamic: "function" } as const
export type DynamicFunction = typeof DYNAMIC_FUNCTION

export interface ManifestSchedule {
  cron?: string
  every?: Duration
  /** ISO-8601 string. Date instances are serialized in UTC. */
  at?: string
  timezone?: string
  input?: unknown | DynamicFunction
  enabled?: boolean
  overlap?: "skip" | "queue" | "allow"
  environments?: EnvironmentName[]
  name?: string
}

export interface ManifestConcurrency {
  key?: string | DynamicFunction
  limit?: number
  strategy?: "queue" | "cancel-in-progress" | "cancel-newest" | "round-robin"
}

export interface BuildManifestArgs {
  entryFile: string
  workflows: readonly WorkflowDefinition[]
  /** Defaults to `() => new Date().toISOString()`. Injectable for tests. */
  now?: () => string
}

export function buildManifest(args: BuildManifestArgs): Manifest {
  const now = args.now ?? (() => new Date().toISOString())
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: now(),
    entryFile: args.entryFile,
    workflows: args.workflows
      .map((w) => toManifestWorkflow(w.config))
      // Sort by id so the output is deterministic regardless of import order.
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function toManifestWorkflow(config: WorkflowConfig<unknown, unknown>): ManifestWorkflow {
  const out: ManifestWorkflow = {
    id: config.id,
    version: hashRun(config.run),
  }
  if (config.description !== undefined) out.description = config.description
  if (config.schedule !== undefined) out.schedule = toManifestSchedules(config.schedule)
  if (config.concurrency !== undefined) out.concurrency = toManifestConcurrency(config.concurrency)
  if (config.retry !== undefined) out.retry = config.retry
  if (config.timeout !== undefined) out.timeout = config.timeout
  if (config.defaultRuntime !== undefined) out.defaultRuntime = config.defaultRuntime
  if (config.tags !== undefined && config.tags.length > 0) out.tags = [...config.tags]
  return out
}

function toManifestSchedules(
  decl: ScheduleDeclaration | ScheduleDeclaration[],
): ManifestSchedule[] {
  const list = Array.isArray(decl) ? decl : [decl]
  return list.map(toManifestSchedule)
}

function toManifestSchedule(d: ScheduleDeclaration): ManifestSchedule {
  const out: ManifestSchedule = {}
  if ("cron" in d) out.cron = d.cron
  if ("every" in d) out.every = d.every
  if ("at" in d) {
    out.at = typeof d.at === "string" ? d.at : d.at.toISOString()
  }
  if (d.timezone !== undefined) out.timezone = d.timezone
  if (d.input !== undefined) {
    out.input = typeof d.input === "function" ? DYNAMIC_FUNCTION : d.input
  }
  if (d.enabled !== undefined) out.enabled = d.enabled
  if (d.overlap !== undefined) out.overlap = d.overlap
  if (d.environments !== undefined) out.environments = [...d.environments]
  if (d.name !== undefined) out.name = d.name
  return out
}

function toManifestConcurrency(c: ConcurrencyPolicy<unknown>): ManifestConcurrency {
  const out: ManifestConcurrency = {}
  if (c.key !== undefined) {
    out.key = typeof c.key === "function" ? DYNAMIC_FUNCTION : c.key
  }
  if (c.limit !== undefined) out.limit = c.limit
  if (c.strategy !== undefined) out.strategy = c.strategy
  return out
}

export function hashRun(fn: unknown): string {
  // `Function.prototype.toString` gives the source text the JS engine
  // kept — stable across runs for a given bundle. We normalize
  // trailing whitespace so insignificant formatting changes (e.g.
  // prettier line endings) don't force a version bump.
  const src = typeof fn === "function" ? fn.toString() : String(fn)
  const normalized = src
    .replace(/\s+$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim()
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12)
}
