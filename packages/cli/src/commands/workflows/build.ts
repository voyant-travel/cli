// `voyant workflows build` — bundle a workflow entry + emit manifest.
//
// Produces two artifacts in the output directory:
//   - bundle.mjs   — esbuild output, a single ESM file that
//                    re-registers all workflows on import.
//   - manifest.json — everything the cloud orchestrator needs
//                    (except the `run` bodies, which live in the
//                    bundle).
//
// The bundle is self-contained: @voyant-travel/workflows and any workspace
// deps are inlined so the artifact is hermetic. The bundle is then
// imported in-process to populate the workflow registry and a
// manifest is extracted via `buildManifest`.

import { resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import type { BuildOptions } from "esbuild"
import type { WorkflowDef } from "./list.js"
import { buildManifest, type Manifest } from "./manifest.js"

export interface Bundler {
  /** Bundle an entry file to a single ESM module at `outfile`. */
  bundle(args: {
    entryFile: string
    outFile: string
    minify: boolean
    sourcemap: boolean
    platform: "neutral" | "node" | "browser"
  }): Promise<{ ok: true } | { ok: false; message: string }>
}

export interface BuildModuleDeps {
  bundler: Bundler
  /** Dynamic import; injectable for tests. */
  importModule: (url: string) => Promise<unknown>
  /** Reset the workflow registry so repeated builds don't collide with prior state. */
  resetRegistry: () => void
  /** Enumerate registered workflows after loading the bundle. */
  getRegisteredWorkflows: () => Iterable<WorkflowDef>
  writeOut: (path: string, content: string | Uint8Array) => Promise<void>
  mkdir: (path: string) => Promise<void>
  now?: () => string
}

export interface BuildInput {
  entryFile: string
  outDir: string
  minify?: boolean
  sourcemap?: boolean
  platform?: "neutral" | "node" | "browser"
}

export type BuildOutcome =
  | {
      ok: true
      bundlePath: string
      manifestPath: string
      manifest: Manifest
    }
  | { ok: false; message: string }

export async function runBuild(input: BuildInput, deps: BuildModuleDeps): Promise<BuildOutcome> {
  const outDirAbs = resolvePath(process.cwd(), input.outDir)
  const entryAbs = resolvePath(process.cwd(), input.entryFile)
  const bundlePath = resolvePath(outDirAbs, "bundle.mjs")
  const manifestPath = resolvePath(outDirAbs, "manifest.json")

  await deps.mkdir(outDirAbs)

  const bundleResult = await deps.bundler.bundle({
    entryFile: entryAbs,
    outFile: bundlePath,
    minify: input.minify ?? false,
    sourcemap: input.sourcemap ?? true,
    platform: input.platform ?? "neutral",
  })
  if (!bundleResult.ok) {
    return { ok: false, message: `bundle failed: ${bundleResult.message}` }
  }

  // Import the bundle with a cache-busting query so repeated builds in
  // the same process don't reuse a stale registry from a prior import.
  deps.resetRegistry()
  const url = `${pathToFileURL(bundlePath).href}?t=${Date.now()}`
  try {
    await deps.importModule(url)
  } catch (err) {
    return {
      ok: false,
      message: `loading bundle failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const workflows = [...deps.getRegisteredWorkflows()]
  const manifest = buildManifest({
    entryFile: entryAbs,
    workflows: workflows as unknown as Parameters<typeof buildManifest>[0]["workflows"],
    now: deps.now,
  })

  await deps.writeOut(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  return { ok: true, bundlePath, manifestPath, manifest }
}

/** Real esbuild-backed bundler. */
export function createEsbuildBundler(): Bundler {
  return {
    async bundle({ entryFile, outFile, minify, sourcemap, platform }) {
      const { build } = await import("esbuild")
      const opts: BuildOptions = {
        entryPoints: [entryFile],
        outfile: outFile,
        bundle: true,
        format: "esm",
        target: "es2022",
        platform,
        banner: platform === "node" ? { js: NODE_REQUIRE_BANNER } : undefined,
        minify,
        sourcemap,
        logLevel: "silent",
      }
      try {
        const result = await build(opts)
        if (result.errors.length > 0) {
          return {
            ok: false,
            message: result.errors.map((e) => e.text).join("\n"),
          }
        }
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }
}

const NODE_REQUIRE_BANNER = [
  `import { createRequire as __voyantCreateRequire } from "node:module";`,
  `const require = __voyantCreateRequire(import.meta.url);`,
].join("\n")
