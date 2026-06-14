// `voyant workflows manifest --file <entry> [--out <path>]`
//
// Driver for the pure `buildManifest()` extractor. Loads the entry
// file, collects registered workflows, and serializes the manifest
// to stdout or a file. Injected deps mirror other commands for test
// parity.

import { writeFile } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"
import type { WorkflowDefinition } from "@voyant-travel/workflows"
import { getStringFlag, type ParsedArgs } from "../../lib/args.js"
import type { WorkflowDef } from "./list.js"
import { buildManifest, type Manifest } from "./manifest.js"

export interface ManifestDeps {
  loadEntry: (path: string) => Promise<unknown>
  getRegisteredWorkflows: () => Iterable<WorkflowDef>
  writeOut: (path: string, content: string) => Promise<void>
  now?: () => string
}

export type ManifestOutcome =
  | { ok: true; manifest: Manifest; wrotePath?: string }
  | { ok: false; message: string; exitCode: number }

export async function runWorkflowsManifest(
  args: ParsedArgs,
  deps: ManifestDeps,
): Promise<ManifestOutcome> {
  const file = getStringFlag(args, "file", "entry")
  if (!file) {
    return {
      ok: false,
      message: "voyant workflows manifest: missing required --file <path>",
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

  const workflows = [...deps.getRegisteredWorkflows()] as unknown as WorkflowDefinition[]
  const manifest = buildManifest({
    entryFile: resolvePath(process.cwd(), file),
    workflows,
    now: deps.now,
  })

  const out = getStringFlag(args, "out")
  if (out) {
    const outAbs = resolvePath(process.cwd(), out)
    await deps.writeOut(outAbs, `${JSON.stringify(manifest, null, 2)}\n`)
    return { ok: true, manifest, wrotePath: outAbs }
  }
  return { ok: true, manifest }
}

export async function defaultManifestDeps(): Promise<ManifestDeps> {
  const [entryMod, wfMod] = await Promise.all([
    import("../../lib/load-entry.js"),
    import("@voyant-travel/workflows") as Promise<{
      __listRegisteredWorkflows: () => WorkflowDef[]
    }>,
  ])
  return {
    loadEntry: (p) => entryMod.loadEntryFile(p),
    getRegisteredWorkflows: () => wfMod.__listRegisteredWorkflows(),
    writeOut: (path, content) => writeFile(path, content, "utf8"),
  }
}
