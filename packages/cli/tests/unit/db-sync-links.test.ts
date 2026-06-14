import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { dbSyncLinksCommand } from "../../src/commands/db-sync-links.js"

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

/**
 * A synthetic `links.mjs` file that fabricates a minimal LinkDefinition
 * without importing `defineLink` (so tests don't need to resolve
 * @voyant-travel/core from a tmpdir).
 */
const SYNTHETIC_LINK = `
const personLinkable = { module: "crm", entity: "person", table: "people" }
const productLinkable = { module: "products", entity: "product", table: "products" }

export const links = [
  {
    left: { linkable: personLinkable, isList: false },
    right: { linkable: productLinkable, isList: true },
    tableName: "crm_person_products_product",
    leftColumn: "crm_person_id",
    rightColumn: "products_product_id",
    cardinality: "one-to-many",
    deleteCascade: false,
  },
]
`

const MANY_TO_MANY_LINKS = `
const tagLinkable = { module: "tags", entity: "tag", table: "tags" }
const productLinkable = { module: "products", entity: "product", table: "products" }

export const links = [
  {
    left: { linkable: tagLinkable, isList: true },
    right: { linkable: productLinkable, isList: true },
    tableName: "tags_tag_products_product",
    leftColumn: "tags_tag_id",
    rightColumn: "products_product_id",
    cardinality: "many-to-many",
    deleteCascade: false,
  },
]
`

describe("dbSyncLinksCommand", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-sync-links-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("fails when no links file is discoverable", async () => {
    const { ctx, stderr } = makeCtx([], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Could not find a links file")
  })

  it("auto-discovers src/links/index.mjs in cwd", async () => {
    const linksDir = join(tmp, "src/links")
    mkdirSync(linksDir, { recursive: true })
    writeFileSync(join(linksDir, "index.mjs"), SYNTHETIC_LINK)

    const { ctx, stdout, stderr } = makeCtx([], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(stderr.join("")).toBe("")
    expect(code).toBe(0)
    const out = stdout.join("")
    expect(out).toContain('CREATE TABLE IF NOT EXISTS "crm_person_products_product"')
    expect(out).toContain("crm.person <-> products.product (one-to-many)")
  })

  it("honors --links with an explicit path", async () => {
    const linksFile = join(tmp, "custom-links.mjs")
    writeFileSync(linksFile, SYNTHETIC_LINK)
    const { ctx, stdout } = makeCtx(["--links", linksFile], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("crm_person_products_product")
  })

  it("honors --template to resolve the template root", async () => {
    const templateRoot = join(tmp, "my-template")
    const linksDir = join(templateRoot, "src/links")
    mkdirSync(linksDir, { recursive: true })
    writeFileSync(join(linksDir, "index.mjs"), SYNTHETIC_LINK)

    const { ctx, stdout } = makeCtx(["--template", templateRoot], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("crm_person_products_product")
  })

  it("fails when --links points at a missing file", async () => {
    const { ctx, stderr } = makeCtx(["--links", join(tmp, "missing.mjs")], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Could not find a links file")
  })

  it("emits the expected DDL for a one-to-many link", async () => {
    const linksFile = join(tmp, "links.mjs")
    writeFileSync(linksFile, SYNTHETIC_LINK)
    const { ctx, stdout } = makeCtx(["--links", linksFile], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(0)

    const out = stdout.join("")
    // Header
    expect(out).toContain("-- Voyant link tables")
    expect(out).toContain(`-- Source: ${linksFile}`)
    expect(out).toContain("-- 1 link")
    // CREATE TABLE
    expect(out).toContain('CREATE TABLE IF NOT EXISTS "crm_person_products_product"')
    expect(out).toContain('"id" text PRIMARY KEY NOT NULL')
    expect(out).toContain('"crm_person_id" text NOT NULL')
    expect(out).toContain('"products_product_id" text NOT NULL')
    // Pair index
    expect(out).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "crm_person_products_product_pair_idx"',
    )
    // right.isList=true → left gets non-unique index
    expect(out).toContain('"crm_person_products_product_l_idx"')
    // left.isList=false → right gets unique index
    expect(out).toContain('"crm_person_products_product_r_uniq"')
  })

  it("emits non-unique indexes for a many-to-many link", async () => {
    const linksFile = join(tmp, "links.mjs")
    writeFileSync(linksFile, MANY_TO_MANY_LINKS)
    const { ctx, stdout } = makeCtx(["--links", linksFile], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(0)

    const out = stdout.join("")
    expect(out).toContain("(many-to-many)")
    // Both sides get non-unique indexes
    expect(out).toContain('"tags_tag_products_product_l_idx"')
    expect(out).toContain('"tags_tag_products_product_r_idx"')
    expect(out).not.toContain("_l_uniq")
    expect(out).not.toContain("_r_uniq")
    // Pair index is still unique
    expect(out).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "tags_tag_products_product_pair_idx"')
  })

  it("accepts a default-exported array of link definitions", async () => {
    const linksFile = join(tmp, "links.mjs")
    writeFileSync(linksFile, SYNTHETIC_LINK.replace("export const links = ", "export default "))
    const { ctx, stdout } = makeCtx(["--links", linksFile], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("crm_person_products_product")
  })

  it("writes to a file with --out", async () => {
    const linksFile = join(tmp, "links.mjs")
    writeFileSync(linksFile, SYNTHETIC_LINK)
    const outPath = join(tmp, "links.sql")
    const { ctx, stdout } = makeCtx(["--links", linksFile, "--out", outPath], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain(`Wrote 1 link table(s) to ${outPath}`)
    const written = readFileSync(outPath, "utf8")
    expect(written).toContain('CREATE TABLE IF NOT EXISTS "crm_person_products_product"')
  })

  it("resolves --out as cwd-relative when given a relative path", async () => {
    const linksFile = join(tmp, "links.mjs")
    writeFileSync(linksFile, SYNTHETIC_LINK)
    const { ctx, stdout } = makeCtx(["--links", linksFile, "--out", "links.sql"], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain(`Wrote 1 link table(s) to ${join(tmp, "links.sql")}`)
    const written = readFileSync(join(tmp, "links.sql"), "utf8")
    expect(written).toContain("crm_person_products_product")
  })

  it("fails when the links file has no valid export", async () => {
    const linksFile = join(tmp, "links.mjs")
    writeFileSync(linksFile, `export const foo = 1\n`)
    const { ctx, stderr } = makeCtx(["--links", linksFile], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("expected a named export `links`")
  })

  it("fails when an entry is not a LinkDefinition", async () => {
    const linksFile = join(tmp, "links.mjs")
    writeFileSync(linksFile, `export const links = [{ foo: 1 }]\n`)
    const { ctx, stderr } = makeCtx(["--links", linksFile], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("links[0] is not a LinkDefinition")
  })

  it("fails when the links array is empty", async () => {
    const linksFile = join(tmp, "links.mjs")
    writeFileSync(linksFile, `export const links = []\n`)
    const { ctx, stderr } = makeCtx(["--links", linksFile], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("No link definitions exported")
  })

  it("propagates import errors from the links file", async () => {
    const linksFile = join(tmp, "links.mjs")
    writeFileSync(linksFile, `throw new Error("broken")\n`)
    const { ctx, stderr } = makeCtx(["--links", linksFile], tmp)
    const code = await dbSyncLinksCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Failed to load links from")
    expect(stderr.join("")).toContain("broken")
  })
})
