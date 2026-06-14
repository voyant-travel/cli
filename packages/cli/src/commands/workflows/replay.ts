// `voyant workflows replay <run-id> [--file <path>] [--no-save]`
//
// Re-runs a stored workflow with its original input, producing a fresh
// run saved as `replayOf: <original-id>`. By default uses the entry
// file path saved with the original run; `--file` overrides.

import { stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { getBooleanFlag, getStringFlag, type ParsedArgs } from "../../lib/args.js"
import { loadEntryFile } from "../../lib/load-entry.js"
import { createFsRunStore, type RunStore, type StoredRun } from "../../lib/run-store.js"
import type { WorkflowDef } from "./list.js"

export interface ReplayDeps {
  store: RunStore
  loadEntry: (path: string) => Promise<unknown>
  getWorkflow: (id: string) => WorkflowDef | undefined
  runWorkflowForTest: (
    wf: WorkflowDef,
    input: unknown,
    opts: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  fileExists: (path: string) => Promise<boolean>
}

export type ReplayOutcome =
  | {
      ok: true
      result: Record<string, unknown>
      saved?: StoredRun
      replayedFrom: StoredRun
      entryFile: string
    }
  | { ok: false; message: string; exitCode: number }

export async function runWorkflowsReplay(
  args: ParsedArgs,
  deps: ReplayDeps,
): Promise<ReplayOutcome> {
  const [runId] = args.positional
  if (!runId) {
    return {
      ok: false,
      message: "voyant workflows replay: missing required <run-id>",
      exitCode: 2,
    }
  }

  const original = await deps.store.get(runId)
  if (!original) {
    return {
      ok: false,
      message: `voyant workflows replay: run "${runId}" not found in the local store.`,
      exitCode: 1,
    }
  }

  // Entry file: explicit --file wins, then the run's stored entry, then error.
  const explicit = getStringFlag(args, "file", "entry")
  const entryFile: string | undefined = explicit
    ? resolve(process.cwd(), explicit)
    : original.entryFile

  if (!entryFile) {
    return {
      ok: false,
      message:
        `voyant workflows replay: run "${runId}" does not have a stored entry file; ` +
        `pass --file <path> to specify which compiled bundle to load.`,
      exitCode: 2,
    }
  }

  if (!(await deps.fileExists(entryFile))) {
    return {
      ok: false,
      message:
        `voyant workflows replay: entry file not found at ${entryFile}. ` +
        `Pass --file <path> to override.`,
      exitCode: 1,
    }
  }

  try {
    await deps.loadEntry(entryFile)
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    }
  }

  const wf = deps.getWorkflow(original.workflowId)
  if (!wf) {
    return {
      ok: false,
      message:
        `voyant workflows replay: workflow "${original.workflowId}" is not ` +
        `registered in ${entryFile}. The workflow may have been renamed or removed.`,
      exitCode: 1,
    }
  }

  let result: Record<string, unknown>
  try {
    result = await deps.runWorkflowForTest(wf, original.input, {})
  } catch (err) {
    return {
      ok: false,
      message:
        `voyant workflows replay: workflow raised during execution: ` +
        (err instanceof Error ? err.message : String(err)),
      exitCode: 1,
    }
  }

  const noSave = getBooleanFlag(args, "no-save")
  let saved: StoredRun | undefined
  if (!noSave) {
    try {
      saved = await deps.store.save({
        workflowId: original.workflowId,
        input: original.input,
        result,
        entryFile,
        replayOf: original.id,
      })
    } catch (err) {
      process.stderr.write(
        `voyant: warning: failed to save replay to local store: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      )
    }
  }

  return { ok: true, result, saved, replayedFrom: original, entryFile }
}

export async function defaultReplayDeps(): Promise<ReplayDeps> {
  const wfMod = (await import("@voyant-travel/workflows")) as unknown as {
    getWorkflow: (id: string) => WorkflowDef | undefined
  }
  const testingMod = (await import("@voyant-travel/workflows/testing")) as unknown as {
    runWorkflowForTest: ReplayDeps["runWorkflowForTest"]
  }
  return {
    store: createFsRunStore(),
    loadEntry: (path) => loadEntryFile(path),
    getWorkflow: wfMod.getWorkflow,
    runWorkflowForTest: testingMod.runWorkflowForTest,
    fileExists: async (path) => {
      try {
        const s = await stat(path)
        return s.isFile()
      } catch {
        return false
      }
    },
  }
}

// Re-export for consumers wiring their own deps.
export { dirname }
