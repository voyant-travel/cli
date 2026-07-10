import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { addCommand } from "../../src/commands/add.js"
import { generateModuleCommand } from "../../src/commands/generate-module.js"
import { newCommand } from "../../src/commands/new.js"
import { parseProjectConfig, selectionResolve } from "../../src/lib/project-config.js"

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

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-add-"))
    project = join(tmp, "operator")
    expect(await newCommand(makeCtx(["operator", "--preset", "operator-standard"], tmp).ctx)).toBe(
      0,
    )
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("selects a generated local module and is idempotent", async () => {
    expect(await generateModuleCommand(makeCtx(["loyalty", "--schema"], project).ctx)).toBe(0)

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

  it("fails closed for hand-authored config instead of applying text edits", async () => {
    writeFileSync(
      join(project, "voyant.config.ts"),
      "export default { modules: [], plugins: [] }\n",
    )
    const { ctx, stderr } = makeCtx(["@acme/voyant-payments", "--plugin"], project)
    expect(await addCommand(ctx, { runAdd: async () => 0 })).toBe(1)
    expect(stderr.join("")).toContain("CLI-managed defineProject format")
  })
})
