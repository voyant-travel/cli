import { describe, expect, it } from "vitest"

import { generateLinkCommand } from "../../src/commands/generate-link.js"

function makeCtx(argv: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    ctx: {
      argv,
      cwd: "/tmp",
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
    stdout,
    stderr,
  }
}

describe("generateLinkCommand", () => {
  it("emits a one-to-one defineLink snippet by default", async () => {
    const { ctx, stdout, stderr } = makeCtx(["crm.person", "products.product"])
    const code = await generateLinkCommand(ctx)
    expect(code).toBe(0)
    expect(stderr.join("")).toBe("")
    const out = stdout.join("")
    expect(out).toContain('import { defineLink } from "@voyant-travel/core/links"')
    expect(out).toContain('import { personLinkable } from "@voyant-travel/crm"')
    expect(out).toContain('import { productLinkable } from "@voyant-travel/products"')
    expect(out).toContain("export const personProductLink = defineLink(")
    expect(out).toContain("Cardinality: one-to-one")
    expect(out).toMatch(/defineLink\(\s*personLinkable,\s*productLinkable,\s*\)/)
  })

  it("emits one-to-many with --right-list", async () => {
    const { ctx, stdout } = makeCtx(["crm.person", "products.product", "--right-list"])
    await generateLinkCommand(ctx)
    const out = stdout.join("")
    expect(out).toContain("Cardinality: one-to-many")
    expect(out).toContain("{ linkable: productLinkable, isList: true }")
  })

  it("emits many-to-many with both --left-list and --right-list", async () => {
    const { ctx, stdout } = makeCtx([
      "crm.person",
      "products.product",
      "--left-list",
      "--right-list",
    ])
    await generateLinkCommand(ctx)
    const out = stdout.join("")
    expect(out).toContain("Cardinality: many-to-many")
    expect(out).toContain("{ linkable: personLinkable, isList: true }")
    expect(out).toContain("{ linkable: productLinkable, isList: true }")
  })

  it("includes deleteCascade option when --cascade is given", async () => {
    const { ctx, stdout } = makeCtx(["crm.person", "products.product", "--cascade"])
    await generateLinkCommand(ctx)
    const out = stdout.join("")
    expect(out).toContain("{ deleteCascade: true }")
  })

  it("errors without both sides", async () => {
    const { ctx, stderr } = makeCtx(["crm.person"])
    const code = await generateLinkCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Usage:")
  })

  it("errors on malformed refs", async () => {
    const { ctx, stderr } = makeCtx(["crm", "products.product"])
    const code = await generateLinkCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("<module>.<entity>")
  })

  it("errors when a ref has empty module or entity", async () => {
    const { ctx, stderr } = makeCtx([".person", "products.product"])
    const code = await generateLinkCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("<module>.<entity>")
  })
})
