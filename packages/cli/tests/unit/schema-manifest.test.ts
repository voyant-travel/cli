import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  readSchemaManifest,
  renderSchemaManifest,
  resolveSchemaManifest,
} from "../../src/lib/schema-manifest.js"

/** Seed a workspace package with a `voyant` field + a real schema source file. */
function seedPackage(
  cwd: string,
  name: string,
  voyant: { schema?: string; requiresSchemas?: string[] },
): void {
  const basename = name.startsWith("@voyant-travel/") ? name.slice("@voyant-travel/".length) : name
  const dir = join(cwd, "packages", basename)
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", voyant }))
  // Materialize the schema file so style:"file" resolution finds it.
  const sub = (voyant.schema ?? "./schema").replace(/^\.\//, "")
  mkdirSync(join(dir, "src", ...sub.split("/").slice(0, -1)), { recursive: true })
  writeFileSync(join(dir, "src", `${sub}.ts`), "export const t = 1\n")
}

describe("schema-manifest", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-manifest-"))
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0" }))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("appends template-local `schemas` after the package-derived closure", () => {
    seedPackage(tmp, "@voyant-travel/db", { schema: "./schema", requiresSchemas: [] })
    seedPackage(tmp, "@voyant-travel/crm", { schema: "./schema", requiresSchemas: ["@voyant-travel/db"] })

    const result = resolveSchemaManifest(
      { modules: ["@voyant-travel/crm"], schemas: ["./src/db/schema.ts"] },
      { cwd: tmp, style: "specifier" },
    )

    expect(result).toEqual(["@voyant-travel/db/schema", "@voyant-travel/crm/schema", "./src/db/schema.ts"])
  })

  it("renders a portable, relative, diff-friendly generated manifest", () => {
    seedPackage(tmp, "@voyant-travel/db", { schema: "./schema", requiresSchemas: [] })
    // Local glue file must exist for style:"file" resolution.
    mkdirSync(join(tmp, "src", "db"), { recursive: true })
    writeFileSync(join(tmp, "src", "db", "schema.ts"), "export const local = 1\n")

    const generated = renderSchemaManifest(
      { modules: ["@voyant-travel/db"], schemas: ["./src/db/schema.ts"] },
      { cwd: tmp },
    )

    expect(generated.path).toBe(join(tmp, "drizzle.schemas.generated.ts"))
    // Package schema resolves under packages/db; entries are relative + POSIX.
    expect(generated.entries).toEqual(["./packages/db/src/schema.ts", "./src/db/schema.ts"])
    expect(generated.content).toContain("export const schema = [")
    expect(generated.content).toContain('"./packages/db/src/schema.ts"')
    expect(generated.content).toContain("AUTO-GENERATED")

    // Round-trips: writing then reading yields identical content.
    writeFileSync(generated.path, generated.content)
    expect(readSchemaManifest(generated.path)).toBe(generated.content)
  })

  it("returns null when the generated manifest is absent", () => {
    expect(readSchemaManifest(join(tmp, "nope.generated.ts"))).toBeNull()
  })
})
