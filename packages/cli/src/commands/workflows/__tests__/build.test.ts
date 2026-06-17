import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { __listRegisteredWorkflows, __resetRegistry } from "@voyant-travel/workflows"
import { afterEach, describe, expect, it } from "vitest"
import {
  type BuildModuleDeps,
  createEsbuildBundler,
  type Bundler,
  runBuild,
} from "../build.js"

const tempDirs: string[] = []

afterEach(async () => {
  __resetRegistry()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("runBuild", () => {
  it("loads node-platform bundles with CommonJS dependencies that dynamically require Node built-ins", async () => {
    const projectDir = await makeTempDir()
    const srcDir = join(projectDir, "src")
    const outDir = join(projectDir, "out")
    await mkdir(srcDir, { recursive: true })

    const cjsDependency = join(srcDir, "dynamic-require.cjs")
    await writeFile(
      cjsDependency,
      [
        `const builtin = "stream"`,
        `exports.readableName = function readableName() {`,
        `  return require(builtin).Readable.name`,
        `}`,
        ``,
      ].join("\n"),
    )

    const entryFile = join(srcDir, "workflows.ts")
    await writeFile(
      entryFile,
      [
        `import { workflow } from "@voyant-travel/workflows"`,
        `import { readableName } from "./dynamic-require.cjs"`,
        ``,
        `const nodeBuiltinName = readableName()`,
        ``,
        `export const dynamicRequireWorkflow = workflow({`,
        `  id: "dynamic-require-node",`,
        `  defaultRuntime: "node",`,
        `  run: async () => nodeBuiltinName,`,
        `})`,
        ``,
      ].join("\n"),
    )

    const outcome = await runBuild(
      {
        entryFile,
        outDir,
        platform: "node",
        sourcemap: false,
      },
      realBuildDeps(),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.message)

    const manifest = JSON.parse(await readFile(outcome.manifestPath, "utf8")) as {
      workflows: Array<{ id: string; defaultRuntime?: string }>
    }
    expect(manifest.workflows).toEqual([
      expect.objectContaining({
        id: "dynamic-require-node",
        defaultRuntime: "node",
      }),
    ])

    __resetRegistry()
    await import(`${pathToFileURL(outcome.bundlePath).href}?runtime=${randomUUID()}`)
    expect(__listRegisteredWorkflows().map((workflow) => workflow.id)).toEqual([
      "dynamic-require-node",
    ])
  })
})

describe("createEsbuildBundler", () => {
  it("keeps the Node CommonJS require shim out of neutral and browser bundles", async () => {
    const projectDir = await makeTempDir()
    const entryFile = join(projectDir, "entry.js")
    await writeFile(entryFile, `export const value = 1\n`)

    for (const platform of ["neutral", "browser"] as const) {
      const outFile = join(projectDir, `${platform}.mjs`)
      const result = await createEsbuildBundler().bundle({
        entryFile,
        outFile,
        minify: false,
        sourcemap: false,
        platform,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.message)

      const bundled = await readFile(outFile, "utf8")
      expect(bundled).not.toContain("createRequire")
      expect(bundled).not.toContain("__voyantCreateRequire")
    }
  })
})

function realBuildDeps(bundler: Bundler = createEsbuildBundler()): BuildModuleDeps {
  return {
    bundler,
    importModule: async (url) => {
      await import(url)
    },
    resetRegistry: () => __resetRegistry(),
    getRegisteredWorkflows: () => __listRegisteredWorkflows(),
    writeOut: (path, content) => writeFile(path, content),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true })
    },
  }
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-workflow-build-"))
  tempDirs.push(dir)
  return dir
}
