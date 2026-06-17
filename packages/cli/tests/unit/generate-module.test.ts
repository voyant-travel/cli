import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { generateModuleCommand } from "../../src/commands/generate-module.js"
import { VOYANT_FRAMEWORK_VERSION } from "../../src/lib/voyant-version.js"

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

  it("scaffolds a module with the canonical file set", async () => {
    const { ctx, stdout, stderr } = makeCtx(["invoices", "--dir", join(tmp, "packages")], tmp)
    const code = await generateModuleCommand(ctx)
    expect(code).toBe(0)
    expect(stderr.join("")).toBe("")
    expect(stdout.join("")).toContain("Created module @voyant-travel/invoices")

    const pkgPath = join(tmp, "packages", "invoices", "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    expect(pkg.name).toBe("@voyant-travel/invoices")
    expect(pkg.exports["."]).toBe("./src/index.ts")
    expect(pkg.dependencies["@voyant-travel/core"]).toBe(`^${VOYANT_FRAMEWORK_VERSION}`)

    const schema = readFileSync(join(tmp, "packages", "invoices", "src/schema.ts"), "utf8")
    expect(schema).toContain('pgTable("invoices"')
    expect(schema).toContain("export const invoices")
    expect(schema).toContain("export type Invoices")

    const validation = readFileSync(join(tmp, "packages", "invoices", "src/validation.ts"), "utf8")
    expect(validation).toContain("insertInvoicesSchema")
    expect(validation).toContain("updateInvoicesSchema")

    const routes = readFileSync(join(tmp, "packages", "invoices", "src/routes.ts"), "utf8")
    expect(routes).toContain("export const invoicesRoutes")

    const index = readFileSync(join(tmp, "packages", "invoices", "src/index.ts"), "utf8")
    expect(index).toContain("export const invoicesModule: Module")
    expect(index).toContain("export const invoicesHonoModule: HonoModule")
  })

  it("normalizes names into kebab-case", async () => {
    const { ctx } = makeCtx(["CreditNotes", "--dir", join(tmp, "packages")], tmp)
    const code = await generateModuleCommand(ctx)
    expect(code).toBe(0)
    const pkg = JSON.parse(
      readFileSync(join(tmp, "packages", "credit-notes", "package.json"), "utf8"),
    )
    expect(pkg.name).toBe("@voyant-travel/credit-notes")
    const schema = readFileSync(join(tmp, "packages", "credit-notes", "src/schema.ts"), "utf8")
    expect(schema).toContain('pgTable("credit-notes"')
    expect(schema).toContain("export const creditNotes")
    expect(schema).toContain("export type CreditNotes")
  })

  it("refuses to overwrite existing files without --force", async () => {
    const args = ["bookings", "--dir", join(tmp, "packages")]
    const first = makeCtx(args, tmp)
    expect(await generateModuleCommand(first.ctx)).toBe(0)

    const second = makeCtx(args, tmp)
    const code = await generateModuleCommand(second.ctx)
    expect(code).toBe(1)
    expect(second.stderr.join("")).toContain("File already exists")
    expect(second.stderr.join("")).toContain("Pass --force")
  })

  it("overwrites when --force is given", async () => {
    const args = ["bookings", "--dir", join(tmp, "packages")]
    const first = makeCtx(args, tmp)
    expect(await generateModuleCommand(first.ctx)).toBe(0)

    const second = makeCtx([...args, "--force"], tmp)
    expect(await generateModuleCommand(second.ctx)).toBe(0)
  })

  it("errors without a module name", async () => {
    const { ctx, stderr } = makeCtx([], tmp)
    const code = await generateModuleCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Usage:")
  })

  it("errors on a name that normalizes to empty", async () => {
    const { ctx, stderr } = makeCtx(["!!!"], tmp)
    const code = await generateModuleCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Invalid module name")
  })
})
