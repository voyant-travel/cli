import {
  emptyGraphSelectionChanges,
  type GraphSelectionChanges,
  hasGraphSelectionChanges,
} from "./graph-diff.js"
import { stableJson } from "./project-resolution.js"

export const PACKAGE_LIFECYCLE_PLAN_SCHEMA_VERSION = "voyant.package-lifecycle-plan.v1" as const

export type PackageLifecycleOperation = "add" | "remove" | "upgrade"
export type PackageLifecyclePlanStatus = "ready" | "noop" | "blocked"

export interface DependencyChange {
  packageName: string
  section: "dependencies" | "devDependencies" | null
  before: string | null
  after: string | null
}

export interface PackageLifecycleGraphPlan {
  beforeContentHash: string | null
  afterContentHash: string | null
  selections: GraphSelectionChanges
}

export interface PackageLifecyclePlanBlock {
  code: string
  message: string
}

export interface PackageLifecyclePlan {
  schemaVersion: typeof PACKAGE_LIFECYCLE_PLAN_SCHEMA_VERSION
  operation: PackageLifecycleOperation
  status: PackageLifecyclePlanStatus
  packageManager: string
  dependencyChanges: readonly DependencyChange[]
  graph: PackageLifecycleGraphPlan
  blockedBy: PackageLifecyclePlanBlock | null
}

export interface CreatePackageLifecyclePlanInput {
  operation: PackageLifecycleOperation
  packageManager: string
  dependencyChanges?: readonly DependencyChange[]
  selections?: GraphSelectionChanges
  beforeContentHash?: string | null
  afterContentHash?: string | null
  blockedBy?: PackageLifecyclePlanBlock | null
}

export function createPackageLifecyclePlan(
  input: CreatePackageLifecyclePlanInput,
): PackageLifecyclePlan {
  const dependencyChanges = [...(input.dependencyChanges ?? [])].sort((left, right) =>
    compareStrings(left.packageName, right.packageName),
  )
  const selections = input.selections ?? emptyGraphSelectionChanges()
  const blockedBy = input.blockedBy ?? null
  const hasDependencyChanges = dependencyChanges.some((change) => change.before !== change.after)
  const status = blockedBy
    ? "blocked"
    : hasDependencyChanges || hasGraphSelectionChanges(selections)
      ? "ready"
      : "noop"

  return {
    schemaVersion: PACKAGE_LIFECYCLE_PLAN_SCHEMA_VERSION,
    operation: input.operation,
    status,
    packageManager: input.packageManager,
    dependencyChanges,
    graph: {
      beforeContentHash: input.beforeContentHash ?? null,
      afterContentHash: input.afterContentHash ?? null,
      selections,
    },
    blockedBy,
  }
}

export function renderPackageLifecyclePlan(plan: PackageLifecyclePlan): string {
  return stableJson(plan as unknown as Record<string, unknown>)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
