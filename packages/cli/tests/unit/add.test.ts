import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { addCommand } from "../../src/commands/add.js"
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

describe("addCommand", () => {
  let tmp: string
  let project: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-add-"))
    project = join(tmp, "operator")
    mkdirSync(project, { recursive: true })
    writeFileSync(
      join(project, "package.json"),
      `${JSON.stringify({ name: "operator", dependencies: {}, packageManager: "pnpm@10.34.5" }, null, 2)}\n`,
    )
    writeFileSync(
      join(project, "voyant.config.ts"),
      renderProjectConfig({ schemaVersion: "voyant.project.v1", modules: [], plugins: [] }),
    )
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("selects a packaged local module and is idempotent", async () => {
    seedLocalModule()

    const installs: string[] = []
    const deps = {
      runAdd: async (_cwd: string, manager: string, specifier: string) => {
        installs.push(`${manager}:${specifier}`)
        return 0
      },
    }

    const first = makeCtx(["./src/modules/loyalty"], project)
    expect(await addCommand(first.ctx, deps)).toBe(0)
    expect(first.stdout.join("")).toContain("Selected ./src/modules/loyalty in modules")

    const second = makeCtx(["./src/modules/loyalty"], project)
    expect(await addCommand(second.ctx, deps)).toBe(0)
    expect(second.stdout.join("")).toContain("Already selected")
    expect(installs).toEqual(["pnpm:./src/modules/loyalty"])

    const config = parseProjectConfig(readFileSync(join(project, "voyant.config.ts"), "utf8"))
    expect(config.modules.map(selectionResolve).filter((item) => item.includes("loyalty"))).toEqual(
      ["./src/modules/loyalty"],
    )
  })

  it("installs a registry plugin and reads its package metadata", async () => {
    const deps = {
      runAdd: async (cwd: string, _manager: string, specifier: string) => {
        expect(specifier).toBe("@acme/voyant-payments")
        const installed = join(cwd, "node_modules", "@acme", "voyant-payments")
        mkdirSync(installed, { recursive: true })
        writeFileSync(
          join(installed, "package.json"),
          JSON.stringify({
            name: "@acme/voyant-payments",
            voyant: { schemaVersion: "voyant.package.v1", kind: "plugin" },
          }),
        )
        return 0
      },
    }

    expect(await addCommand(makeCtx(["@acme/voyant-payments"], project).ctx, deps)).toBe(0)
    const config = parseProjectConfig(readFileSync(join(project, "voyant.config.ts"), "utf8"))
    expect(config.plugins.map(selectionResolve)).toContain("@acme/voyant-payments")
  })

  it("emits a machine-readable dry-run plan without installing or editing", async () => {
    seedLocalModule()
    const configPath = join(project, "voyant.config.ts")
    const before = readFileSync(configPath, "utf8")
    let installed = false
    const run = makeCtx(["--dry-run", "./src/modules/loyalty"], project)

    expect(
      await addCommand(run.ctx, {
        runAdd: async () => {
          installed = true
          return 0
        },
      }),
    ).toBe(0)

    const plan = JSON.parse(run.stdout.join(""))
    expect(plan).toMatchObject({
      operation: "add",
      status: "ready",
      dependencyChanges: [
        {
          packageName: "@operator/loyalty",
          before: null,
          after: "file:src/modules/loyalty",
        },
      ],
      graph: {
        selections: {
          modules: { additions: ["./src/modules/loyalty"], removals: [] },
          plugins: { additions: [], removals: [] },
        },
      },
    })
    expect(installed).toBe(false)
    expect(readFileSync(configPath, "utf8")).toBe(before)
  })

  it("restores package metadata when install fails", async () => {
    seedLocalModule()
    const configPath = join(project, "voyant.config.ts")
    const packagePath = join(project, "package.json")
    const beforeConfig = readFileSync(configPath, "utf8")
    const beforePackage = readFileSync(packagePath, "utf8")

    const code = await addCommand(makeCtx(["./src/modules/loyalty"], project).ctx, {
      runAdd: async () => {
        const manifest = JSON.parse(readFileSync(packagePath, "utf8"))
        manifest.dependencies["@operator/loyalty"] = "file:src/modules/loyalty"
        writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`)
        return 9
      },
    })

    expect(code).toBe(9)
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
    expect(readFileSync(packagePath, "utf8")).toBe(beforePackage)
  })

  it("fails closed for hand-authored config instead of applying text edits", async () => {
    writeFileSync(
      join(project, "voyant.config.ts"),
      "export default { modules: [], plugins: [] }\n",
    )
    const { ctx, stderr } = makeCtx(["@acme/voyant-payments", "--plugin"], project)
    expect(await addCommand(ctx, { runAdd: async () => 0 })).toBe(1)
    expect(stderr.join("")).toContain("CLI-managed defineProject format")
  })

  function seedLocalModule() {
    const moduleRoot = join(project, "src", "modules", "loyalty")
    mkdirSync(moduleRoot, { recursive: true })
    writeFileSync(
      join(moduleRoot, "package.json"),
      JSON.stringify({
        name: "@operator/loyalty",
        voyant: { schemaVersion: "voyant.package.v1", kind: "module" },
      }),
    )
  }
})
