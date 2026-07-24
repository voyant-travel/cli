import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { addCommand } from "../../src/commands/add.js"
import { removeCommand } from "../../src/commands/remove.js"
import {
  parseProjectConfig,
  renderProjectConfig,
  selectionResolve,
} from "../../src/lib/project-config.js"

function makeCtx(argv: string[], cwd: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    ctx: {
      argv,
      cwd,
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
    stdout,
    stderr,
  }
}

describe("removeCommand", () => {
  let tmp: string
  let project: string
  let packagePath: string
  let configPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-remove-"))
    project = join(tmp, "operator")
    const moduleRoot = join(project, "src", "modules", "loyalty")
    mkdirSync(moduleRoot, { recursive: true })
    writeFileSync(
      join(moduleRoot, "package.json"),
      JSON.stringify({
        name: "@operator/loyalty",
        voyant: { schemaVersion: "voyant.package.v1", kind: "module" },
      }),
    )
    packagePath = join(project, "package.json")
    configPath = join(project, "voyant.config.ts")
    writeFileSync(
      packagePath,
      `${JSON.stringify({ name: "operator", dependencies: {}, packageManager: "pnpm@10.34.5" }, null, 2)}\n`,
    )
    writeFileSync(
      configPath,
      renderProjectConfig({
        schemaVersion: "voyant.project.v1",
        modules: [],
        plugins: [
          "@voyant-travel/distribution#extension",
          "@voyant-travel/distribution/channel-push-extension",
        ],
      }),
    )
  })

  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it("roundtrips add/remove and is idempotent", async () => {
    const runAdd = async () => {
      updateDependency("@operator/loyalty", "file:src/modules/loyalty")
      return 0
    }
    expect(await addCommand(makeCtx(["./src/modules/loyalty"], project).ctx, { runAdd })).toBe(0)

    const runRemove = vi.fn(async () => {
      updateDependency("@operator/loyalty", null)
      return 0
    })
    expect(
      await removeCommand(makeCtx(["./src/modules/loyalty"], project).ctx, { runRemove }),
    ).toBe(0)
    expect(
      await removeCommand(makeCtx(["./src/modules/loyalty"], project).ctx, { runRemove }),
    ).toBe(0)

    const config = parseProjectConfig(readFileSync(configPath, "utf8"))
    expect(config.modules.map(selectionResolve)).not.toContain("./src/modules/loyalty")
    expect(JSON.parse(readFileSync(packagePath, "utf8")).dependencies).not.toHaveProperty(
      "@operator/loyalty",
    )
    expect(runRemove).toHaveBeenCalledTimes(1)
  })

  it("emits a deterministic JSON plan without editing", async () => {
    await addCommand(makeCtx(["./src/modules/loyalty"], project).ctx, {
      runAdd: async () => {
        updateDependency("@operator/loyalty", "file:src/modules/loyalty")
        return 0
      },
    })
    const beforeConfig = readFileSync(configPath, "utf8")
    const beforePackage = readFileSync(packagePath, "utf8")
    const first = makeCtx(["./src/modules/loyalty", "--plan"], project)
    const second = makeCtx(["./src/modules/loyalty", "--plan"], project)

    expect(await removeCommand(first.ctx)).toBe(0)
    expect(await removeCommand(second.ctx)).toBe(0)
    expect(first.stdout.join("")).toBe(second.stdout.join(""))
    expect(JSON.parse(first.stdout.join(""))).toMatchObject({
      operation: "remove",
      status: "ready",
      dependencyChanges: [
        {
          packageName: "@operator/loyalty",
          before: "file:src/modules/loyalty",
          after: null,
        },
      ],
      graph: {
        selections: {
          modules: { additions: [], removals: ["./src/modules/loyalty"] },
          plugins: { additions: [], removals: [] },
        },
      },
    })
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
    expect(readFileSync(packagePath, "utf8")).toBe(beforePackage)
  })

  it("removes fragment selections while retaining a dependency shared by another unit", async () => {
    updateDependency("@voyant-travel/distribution", "^1.2.3")
    const runRemove = vi.fn(async () => 0)

    expect(
      await removeCommand(makeCtx(["@voyant-travel/distribution#extension"], project).ctx, {
        runRemove,
      }),
    ).toBe(0)

    const config = parseProjectConfig(readFileSync(configPath, "utf8"))
    expect(config.plugins.map(selectionResolve)).not.toContain(
      "@voyant-travel/distribution#extension",
    )
    expect(config.plugins.map(selectionResolve)).toContain(
      "@voyant-travel/distribution/channel-push-extension",
    )
    expect(JSON.parse(readFileSync(packagePath, "utf8")).dependencies).toHaveProperty(
      "@voyant-travel/distribution",
      "^1.2.3",
    )
    expect(runRemove).not.toHaveBeenCalled()
  })

  it("restores config and package metadata when dependency removal fails", async () => {
    await addCommand(makeCtx(["./src/modules/loyalty"], project).ctx, {
      runAdd: async () => {
        updateDependency("@operator/loyalty", "file:src/modules/loyalty")
        return 0
      },
    })
    const beforeConfig = readFileSync(configPath, "utf8")
    const beforePackage = readFileSync(packagePath, "utf8")
    const runRemove = vi.fn(async () => {
      expect(readFileSync(configPath, "utf8")).not.toBe(beforeConfig)
      updateDependency("@operator/loyalty", null)
      return 7
    })

    expect(
      await removeCommand(makeCtx(["./src/modules/loyalty"], project).ctx, { runRemove }),
    ).toBe(7)
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
    expect(readFileSync(packagePath, "utf8")).toBe(beforePackage)
  })

  it("fails closed before package removal for hand-authored config", async () => {
    writeFileSync(configPath, "export default { modules: [], plugins: [] }\n")
    const runRemove = vi.fn(async () => 0)
    const run = makeCtx(["./src/modules/loyalty"], project)

    expect(await removeCommand(run.ctx, { runRemove })).toBe(1)
    expect(run.stderr.join("")).toContain("CLI-managed defineProject format")
    expect(runRemove).not.toHaveBeenCalled()
  })

  function updateDependency(packageName: string, version: string | null) {
    const manifest = JSON.parse(readFileSync(packagePath, "utf8"))
    if (version === null) delete manifest.dependencies[packageName]
    else manifest.dependencies[packageName] = version
    writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
})
