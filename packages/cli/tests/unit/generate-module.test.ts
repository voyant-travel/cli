import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { generateModuleCommand } from "../../src/commands/generate-module.js"

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

describe("generateModuleCommand", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-module-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("scaffolds one conventional module entry", async () => {
    const { ctx, stdout, stderr } = makeCtx(["invoices"], tmp)
    expect(await generateModuleCommand(ctx)).toBe(0)
    expect(stderr.join("")).toBe("")
    expect(stdout.join("")).toContain("Created module invoices")
    expect(stdout.join("")).not.toContain("voyant add")

    const moduleRoot = join(tmp, "src", "modules", "invoices")
    expect(readdirSync(moduleRoot)).toEqual(["index.ts"])
    expect(readFileSync(join(moduleRoot, "index.ts"), "utf8")).toBe(
      `import { defineDeploymentModule } from "@voyant-travel/framework"

export default defineDeploymentModule({
  module: { name: "invoices" },
})
`,
    )
    expect(existsSync(join(moduleRoot, "package.json"))).toBe(false)
    expect(existsSync(join(moduleRoot, "tsconfig.json"))).toBe(false)
    expect(existsSync(join(moduleRoot, "voyant.ts"))).toBe(false)
  })

  it("normalizes the module name", async () => {
    expect(await generateModuleCommand(makeCtx(["CreditNotes"], tmp).ctx)).toBe(0)
    expect(existsSync(join(tmp, "src", "modules", "credit-notes", "index.ts"))).toBe(true)
  })

  it("supports a custom module directory", async () => {
    expect(
      await generateModuleCommand(makeCtx(["loyalty", "--dir", "custom-modules"], tmp).ctx),
    ).toBe(0)
    expect(existsSync(join(tmp, "custom-modules", "loyalty", "index.ts"))).toBe(true)
  })

  it("refuses to overwrite the entry without --force", async () => {
    const args = ["bookings"]
    expect(await generateModuleCommand(makeCtx(args, tmp).ctx)).toBe(0)

    const second = makeCtx(args, tmp)
    expect(await generateModuleCommand(second.ctx)).toBe(1)
    expect(second.stderr.join("")).toContain("File already exists")
    expect(second.stderr.join("")).toContain("Pass --force")
  })

  it("overwrites the entry when --force is given", async () => {
    const args = ["bookings"]
    expect(await generateModuleCommand(makeCtx(args, tmp).ctx)).toBe(0)
    const entry = join(tmp, "src", "modules", "bookings", "index.ts")
    writeFileSync(entry, "stale\n")

    expect(await generateModuleCommand(makeCtx([...args, "--force"], tmp).ctx)).toBe(0)
    expect(readFileSync(entry, "utf8")).toContain("defineDeploymentModule")
  })

  it("errors without a module name", async () => {
    const { ctx, stderr } = makeCtx([], tmp)
    expect(await generateModuleCommand(ctx)).toBe(1)
    expect(stderr.join("")).toContain("Usage:")
  })

  it("errors on a name that normalizes to empty", async () => {
    const { ctx, stderr } = makeCtx(["!!!"], tmp)
    expect(await generateModuleCommand(ctx)).toBe(1)
    expect(stderr.join("")).toContain("Invalid module name")
  })
})
