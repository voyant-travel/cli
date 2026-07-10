import type { AuthoringProjectConfig } from "./project-config.js"
import { selectionResolve } from "./project-config.js"

export interface GraphSelectionSet {
  modules: readonly string[]
  plugins: readonly string[]
}

export interface SelectionChanges {
  additions: readonly string[]
  removals: readonly string[]
}

export interface GraphSelectionChanges {
  modules: SelectionChanges
  plugins: SelectionChanges
}

export function authoringGraphSelections(config: AuthoringProjectConfig): GraphSelectionSet {
  return {
    modules: sortedUnique(config.modules.map(selectionResolve)),
    plugins: sortedUnique(config.plugins.map(selectionResolve)),
  }
}

export function resolvedGraphSelections(graph: Record<string, unknown>): GraphSelectionSet {
  return {
    modules: resolvedUnitIds(graph.modules),
    plugins: resolvedUnitIds(graph.plugins),
  }
}

export function diffGraphSelections(
  before: GraphSelectionSet,
  after: GraphSelectionSet,
): GraphSelectionChanges {
  return {
    modules: diffSelections(before.modules, after.modules),
    plugins: diffSelections(before.plugins, after.plugins),
  }
}

export function emptyGraphSelectionChanges(): GraphSelectionChanges {
  return {
    modules: { additions: [], removals: [] },
    plugins: { additions: [], removals: [] },
  }
}

export function hasGraphSelectionChanges(changes: GraphSelectionChanges): boolean {
  return (
    changes.modules.additions.length > 0 ||
    changes.modules.removals.length > 0 ||
    changes.plugins.additions.length > 0 ||
    changes.plugins.removals.length > 0
  )
}

function diffSelections(before: readonly string[], after: readonly string[]): SelectionChanges {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    additions: sortedUnique(after.filter((selection) => !beforeSet.has(selection))),
    removals: sortedUnique(before.filter((selection) => !afterSet.has(selection))),
  }
}

function resolvedUnitIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return sortedUnique(
    value.flatMap((unit) => {
      if (typeof unit === "string") return unit.length > 0 ? [unit] : []
      if (!isRecord(unit)) return []
      for (const key of ["id", "resolve", "packageName"] as const) {
        const candidate = unit[key]
        if (typeof candidate === "string" && candidate.length > 0) return [candidate]
      }
      return []
    }),
  )
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
