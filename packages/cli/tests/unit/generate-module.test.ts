import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "my-operator" }))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("scaffolds a graph-native module with selected optional facets", async () => {
    const { ctx, stdout, stderr } = makeCtx(["invoices", "--schema", "--admin", "--workflow"], tmp)
    expect(await generateModuleCommand(ctx)).toBe(0)
    expect(stderr.join("")).toBe("")
    expect(stdout.join("")).toContain("Created module @my-operator/invoices")
    expect(stdout.join("")).toContain("voyant add ./src/modules/invoices")

    const moduleRoot = join(tmp, "src", "modules", "invoices")
    const pkg = JSON.parse(readFileSync(join(moduleRoot, "package.json"), "utf8"))
    expect(pkg.name).toBe("@my-operator/invoices")
    expect(pkg.exports).toMatchObject({
      ".": "./src/index.ts",
      "./voyant": "./src/voyant.ts",
      "./schema": "./src/schema.ts",
      "./admin": "./src/admin.ts",
      "./workflows": "./src/workflows.ts",
    })
    expect(pkg.voyant).toMatchObject({
      schemaVersion: "voyant.package.v1",
      kind: "module",
      manifest: "./voyant",
      schema: "./schema",
    })
    expect(pkg.dependencies["@voyant-travel/framework"]).toBe(`^${VOYANT_FRAMEWORK_VERSION}`)

    const voyant = readFileSync(join(moduleRoot, "src", "voyant.ts"), "utf8")
    expect(voyant).toContain('from "@voyant-travel/framework/project"')
    expect(voyant).toContain('source: "@my-operator/invoices/schema"')
    expect(voyant).toContain('entry: "@my-operator/invoices/admin"')
    expect(voyant).not.toContain('from "./schema')
    expect(voyant).not.toContain('from "./admin')

    expect(readFileSync(join(moduleRoot, "src", "schema.ts"), "utf8")).toContain(
      'pgTable("invoices"',
    )
    expect(readFileSync(join(moduleRoot, "src", "admin.ts"), "utf8")).toContain(
      "invoicesAdminRoutes",
    )
    expect(readFileSync(join(moduleRoot, "src", "workflows.ts"), "utf8")).toContain(
      "runInvoicesWorkflow",
    )
  })

  it("normalizes names and omits unselected facets", async () => {
    const { ctx } = makeCtx(["CreditNotes"], tmp)
    expect(await generateModuleCommand(ctx)).toBe(0)
    const moduleRoot = join(tmp, "src", "modules", "credit-notes")
    const pkg = JSON.parse(readFileSync(join(moduleRoot, "package.json"), "utf8"))
    expect(pkg.name).toBe("@my-operator/credit-notes")
    expect(pkg.exports["./voyant"]).toBe("./src/voyant.ts")
    expect(pkg.exports["./schema"]).toBeUndefined()
    expect(existsSync(join(moduleRoot, "src", "schema.ts"))).toBe(false)
    expect(existsSync(join(moduleRoot, "src", "admin.ts"))).toBe(false)
    expect(existsSync(join(moduleRoot, "src", "workflows.ts"))).toBe(false)
  })

  it("accepts an explicit package namespace", async () => {
    const { ctx } = makeCtx(["loyalty", "--package-name", "@acme/voyant-loyalty"], tmp)
    expect(await generateModuleCommand(ctx)).toBe(0)
    const pkg = JSON.parse(
      readFileSync(join(tmp, "src", "modules", "loyalty", "package.json"), "utf8"),
    )
    expect(pkg.name).toBe("@acme/voyant-loyalty")
  })

  it("refuses to overwrite existing files without --force", async () => {
    const args = ["bookings"]
    expect(await generateModuleCommand(makeCtx(args, tmp).ctx)).toBe(0)

    const second = makeCtx(args, tmp)
    expect(await generateModuleCommand(second.ctx)).toBe(1)
    expect(second.stderr.join("")).toContain("File already exists")
    expect(second.stderr.join("")).toContain("Pass --force")
  })

  it("overwrites when --force is given", async () => {
    const args = ["bookings"]
    expect(await generateModuleCommand(makeCtx(args, tmp).ctx)).toBe(0)
    expect(await generateModuleCommand(makeCtx([...args, "--force"], tmp).ctx)).toBe(0)
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
