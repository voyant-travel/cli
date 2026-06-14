// `voyant workflows list` — enumerates registered workflows from a
// loaded entry file, optionally as JSON.

import { getBooleanFlag, getStringFlag, type ParsedArgs } from "../../lib/args.js"

/**
 * Enumerate workflows registered under @voyant-travel/workflows after loading
 * the entry file. Returns the list for programmatic callers; the CLI
 * entrypoint prints it.
 */
export interface WorkflowsListResult {
  workflows: {
    id: string
    description?: string
    schedules: number
    hasCompensation: boolean
  }[]
}

export interface ListDeps {
  loadEntry: (path: string) => Promise<unknown>
  getRegisteredWorkflows: () => Iterable<WorkflowDef>
}

export interface WorkflowDef {
  id: string
  config: {
    description?: string
    schedule?: unknown | unknown[]
    timeout?: unknown
    run: (...args: unknown[]) => unknown
  }
}

export async function runWorkflowsList(
  args: ParsedArgs,
  deps: ListDeps,
): Promise<
  { ok: true; result: WorkflowsListResult } | { ok: false; message: string; exitCode: number }
> {
  const file = getStringFlag(args, "file", "entry")
  if (!file) {
    return {
      ok: false,
      message: "voyant workflows list: missing required --file <path>",
      exitCode: 2,
    }
  }

  try {
    await deps.loadEntry(file)
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    }
  }

  const workflows = [...deps.getRegisteredWorkflows()].map((w) => ({
    id: w.id,
    description: w.config.description,
    schedules: Array.isArray(w.config.schedule)
      ? w.config.schedule.length
      : w.config.schedule
        ? 1
        : 0,
    hasCompensation: false, // Compensation is per-step; surfaced separately.
  }))

  // Acknowledge the flag so callers get the JSON/human split consistently.
  void getBooleanFlag(args, "json")

  return { ok: true, result: { workflows } }
}

/**
 * Default deps binding: reads from the real filesystem and the real
 * @voyant-travel/workflows registry.
 */
export async function defaultListDeps(): Promise<ListDeps> {
  const [entryMod, wfMod] = await Promise.all([
    import("../../lib/load-entry.js"),
    import("@voyant-travel/workflows") as Promise<{ __listRegisteredWorkflows: () => WorkflowDef[] }>,
  ])
  return {
    loadEntry: (path) => entryMod.loadEntryFile(path),
    getRegisteredWorkflows: () => wfMod.__listRegisteredWorkflows(),
  }
}
