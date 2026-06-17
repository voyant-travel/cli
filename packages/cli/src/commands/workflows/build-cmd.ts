// CLI driver for `voyant workflows build`.
//
// Wraps the pure `runBuild` with argument parsing and default deps
// (esbuild, Node ESM import, filesystem writes). Prints paths to
// stderr and manifest JSON to stdout on success.

import { mkdir, writeFile } from "node:fs/promises"
import { getBooleanFlag, getStringFlag, type ParsedArgs } from "../../lib/args.js"
import { type BuildModuleDeps, type BuildOutcome, createEsbuildBundler, runBuild } from "./build.js"
import type { WorkflowDef } from "./list.js"

export type BuildOutcomeResult = BuildOutcome

export interface BuildCmdDeps extends BuildModuleDeps {}

export async function runWorkflowsBuild(
  args: ParsedArgs,
  deps: BuildCmdDeps,
): Promise<
  | { ok: true; bundlePath: string; manifestPath: string; manifest: unknown }
  | { ok: false; message: string; exitCode: number }
> {
  const file = getStringFlag(args, "file", "entry")
  if (!file) {
    return {
      ok: false,
      message: "voyant workflows build: missing required --file <path>",
      exitCode: 2,
    }
  }
  const outDir = getStringFlag(args, "out") ?? ".voyant/build"
  const platformFlag = getStringFlag(args, "platform")
  const platform =
    platformFlag === "node" || platformFlag === "browser" || platformFlag === "neutral"
      ? (platformFlag as "node" | "browser" | "neutral")
      : undefined
  const minify = getBooleanFlag(args, "minify") === true
  // Sourcemap on by default; `--no-sourcemap` turns it off.
  const sourcemapFlag = getBooleanFlag(args, "sourcemap")
  const sourcemap = sourcemapFlag !== false

  const outcome = await runBuild({ entryFile: file, outDir, minify, sourcemap, platform }, deps)
  if (!outcome.ok) {
    return { ok: false, message: outcome.message, exitCode: 1 }
  }
  return {
    ok: true,
    bundlePath: outcome.bundlePath,
    manifestPath: outcome.manifestPath,
    manifest: outcome.manifest,
  }
}

export async function defaultBuildDeps(): Promise<BuildCmdDeps> {
  const wfMod = (await import("@voyant-travel/workflows")) as unknown as {
    __listRegisteredWorkflows: () => WorkflowDef[]
    __resetRegistry: () => void
  }
  return {
    bundler: createEsbuildBundler(),
    importModule: async (url) => {
      await import(url)
    },
    resetRegistry: () => wfMod.__resetRegistry(),
    getRegisteredWorkflows: () => wfMod.__listRegisteredWorkflows(),
    writeOut: (path, content) => writeFile(path, content),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true })
    },
  }
}
