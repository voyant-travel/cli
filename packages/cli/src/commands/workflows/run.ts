// `voyant workflows run <id> [--file <path>] [--input <json>] [--input-file <path>]`
//
// Runs a single workflow once in-process via the test harness and
// prints the resulting TestResult. Useful for quick local validation
// without spinning up a serve. Fully replay-capable — passing a
// stored run's output back in via --input-file re-exercises the same
// code path.

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { getBooleanFlag, getStringFlag, type ParsedArgs } from "../../lib/args.js"
import { loadEntryFile } from "../../lib/load-entry.js"
import { createFsRunStore, type RunStore, type StoredRun } from "../../lib/run-store.js"
import type { WorkflowDef } from "./list.js"

export interface RunDeps {
  loadEntry: (path: string) => Promise<unknown>
  getWorkflow: (id: string) => WorkflowDef | undefined
  runWorkflowForTest: (
    wf: WorkflowDef,
    input: unknown,
    opts: {
      now?: () => number
      waitForEvent?: Record<string, unknown>
      waitForSignal?: Record<string, unknown>
      waitForToken?: Record<string, unknown>
      invoke?: Record<string, unknown>
    },
  ) => Promise<Record<string, unknown>>
  readFile: (path: string) => Promise<string>
  store?: RunStore
}

export type RunOutcome =
  | { ok: true; result: Record<string, unknown>; saved?: StoredRun }
  | { ok: false; message: string; exitCode: number }

export async function runWorkflowsRun(args: ParsedArgs, deps: RunDeps): Promise<RunOutcome> {
  const [workflowId] = args.positional
  if (!workflowId) {
    return {
      ok: false,
      message: "voyant workflows run: missing required <workflow-id>",
      exitCode: 2,
    }
  }

  const file = getStringFlag(args, "file", "entry")
  if (!file) {
    return {
      ok: false,
      message: "voyant workflows run: missing required --file <path>",
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

  const wf = deps.getWorkflow(workflowId)
  if (!wf) {
    return {
      ok: false,
      message:
        `voyant workflows run: workflow "${workflowId}" is not registered ` +
        `in ${file}. Run \`voyant workflows list --file ${file}\` to see what's available.`,
      exitCode: 1,
    }
  }

  // Resolve input from --input (inline JSON) or --input-file (path). Omit
  // both → undefined input; workflows that expect input will surface a
  // validation error downstream.
  let input: unknown
  const inline = getStringFlag(args, "input")
  const inputFile = getStringFlag(args, "input-file")
  if (inline !== undefined) {
    try {
      input = JSON.parse(inline)
    } catch (err) {
      return {
        ok: false,
        message: `voyant workflows run: --input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 2,
      }
    }
  } else if (inputFile !== undefined) {
    try {
      const text = await deps.readFile(inputFile)
      input = JSON.parse(text)
    } catch (err) {
      return {
        ok: false,
        message:
          `voyant workflows run: failed to read/parse --input-file ${inputFile}: ` +
          (err instanceof Error ? err.message : String(err)),
        exitCode: 1,
      }
    }
  }

  let result: Record<string, unknown>
  try {
    result = await deps.runWorkflowForTest(wf, input, {})
  } catch (err) {
    return {
      ok: false,
      message:
        `voyant workflows run: workflow raised during execution: ` +
        (err instanceof Error ? err.message : String(err)),
      exitCode: 1,
    }
  }

  // Save to the local run store unless --no-save is set.
  const noSave = getBooleanFlag(args, "no-save")
  let saved: StoredRun | undefined
  if (!noSave && deps.store) {
    try {
      saved = await deps.store.save({
        workflowId,
        input,
        result,
        entryFile: resolve(process.cwd(), file),
      })
    } catch (err) {
      // Non-fatal: still return the result, but mention the save failed.
      process.stderr.write(
        `voyant: warning: failed to save run to local store: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      )
    }
  }

  return { ok: true, result, saved }
}

/** Default deps binding (filesystem + real @voyant-travel/workflows). */
export async function defaultRunDeps(): Promise<RunDeps> {
  const wfMod = (await import("@voyant-travel/workflows")) as unknown as {
    getWorkflow: (id: string) => WorkflowDef | undefined
  }
  const testingMod = (await import("@voyant-travel/workflows/testing")) as unknown as {
    runWorkflowForTest: RunDeps["runWorkflowForTest"]
  }
  return {
    loadEntry: (path: string) => loadEntryFile(path),
    getWorkflow: wfMod.getWorkflow,
    runWorkflowForTest: testingMod.runWorkflowForTest,
    readFile: async (path: string) => readFile(resolve(process.cwd(), path), "utf8"),
    store: createFsRunStore(),
  }
}
