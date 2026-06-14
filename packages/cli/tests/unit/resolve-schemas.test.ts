import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { resolveSchemas } from "../../src/lib/resolve-schemas.js"

/**
 * Build a fake module by writing a `packages/<basename>/package.json` with the
 * given `voyant` field. The resolver's workspace fallback finds packages here
 * when `require.resolve` fails (i.e. they are not installed under
 * `node_modules/`), letting us exercise the closure logic without spinning up
 * a real install.
 */
function seedModule(
  cwd: string,
  name: string,
  voyant: { schema?: string; requiresSchemas?: string[] } | null,
): void {
  const basename = name.startsWith("@voyant-travel/") ? name.slice("@voyant-travel/".length) : name
  const dir = join(cwd, "packages", basename)
  mkdirSync(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name, version: "0.0.0" }
  if (voyant) pkg.voyant = voyant
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2))
}

describe("resolveSchemas", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-resolve-"))
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "consumer", version: "0.0.0" }, null, 2),
    )
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns the listed modules in dependency order with deps inserted first", () => {
    seedModule(tmp, "@voyant-travel/db", { schema: "./schema", requiresSchemas: [] })
    seedModule(tmp, "@voyant-travel/facilities", {
      schema: "./schema",
      requiresSchemas: ["@voyant-travel/db"],
    })
    seedModule(tmp, "@voyant-travel/bookings", {
      schema: "./schema",
      requiresSchemas: ["@voyant-travel/db"],
    })
    seedModule(tmp, "@voyant-travel/hospitality", {
      schema: "./schema",
      requiresSchemas: ["@voyant-travel/db", "@voyant-travel/facilities", "@voyant-travel/bookings"],
    })

    const result = resolveSchemas({ modules: ["@voyant-travel/hospitality"] }, { cwd: tmp })

    // Closure order: db before facilities/bookings, both before hospitality.
    expect(result).toEqual([
      "@voyant-travel/db/schema",
      "@voyant-travel/facilities/schema",
      "@voyant-travel/bookings/schema",
      "@voyant-travel/hospitality/schema",
    ])
  })

  it("dedupes shared deps reached through multiple paths", () => {
    seedModule(tmp, "@voyant-travel/db", { schema: "./schema", requiresSchemas: [] })
    seedModule(tmp, "@voyant-travel/facilities", {
      schema: "./schema",
      requiresSchemas: ["@voyant-travel/db"],
    })
    seedModule(tmp, "@voyant-travel/identity", {
      schema: "./schema",
      requiresSchemas: ["@voyant-travel/db"],
    })
    seedModule(tmp, "@voyant-travel/ground", {
      schema: "./schema",
      requiresSchemas: ["@voyant-travel/db", "@voyant-travel/facilities", "@voyant-travel/identity"],
    })

    const result = resolveSchemas(
      { modules: ["@voyant-travel/ground", "@voyant-travel/facilities"] },
      { cwd: tmp },
    )

    expect(result.filter((s) => s === "@voyant-travel/db/schema")).toHaveLength(1)
    expect(result.filter((s) => s === "@voyant-travel/facilities/schema")).toHaveLength(1)
    // Order: dependencies precede dependents.
    expect(result.indexOf("@voyant-travel/db/schema")).toBeLessThan(
      result.indexOf("@voyant-travel/facilities/schema"),
    )
  })

  it("uses ./schema as the default subpath when manifest lacks `schema`", () => {
    seedModule(tmp, "@voyant-travel/db", null)
    const result = resolveSchemas({ modules: ["@voyant-travel/db"] }, { cwd: tmp })
    expect(result).toEqual(["@voyant-travel/db/schema"])
  })

  it("throws on circular schema dependencies", () => {
    seedModule(tmp, "@voyant-travel/a", { schema: "./schema", requiresSchemas: ["@voyant-travel/b"] })
    seedModule(tmp, "@voyant-travel/b", { schema: "./schema", requiresSchemas: ["@voyant-travel/a"] })

    expect(() => resolveSchemas({ modules: ["@voyant-travel/a"] }, { cwd: tmp })).toThrow(
      /Circular schema dependency/,
    )
  })

  it("respects ModuleEntry { resolve, options } shorthand", () => {
    seedModule(tmp, "@voyant-travel/db", null)
    seedModule(tmp, "@voyant-travel/crm", {
      schema: "./schema",
      requiresSchemas: ["@voyant-travel/db"],
    })
    const result = resolveSchemas(
      {
        modules: [{ resolve: "@voyant-travel/crm", options: { whatever: true } }],
      },
      { cwd: tmp },
    )
    expect(result).toEqual(["@voyant-travel/db/schema", "@voyant-travel/crm/schema"])
  })

  it("seeds the closure from additionalSchemas alongside modules", () => {
    seedModule(tmp, "@voyant-travel/db", { schema: "./schema", requiresSchemas: [] })
    seedModule(tmp, "@voyant-travel/crm", { schema: "./schema", requiresSchemas: ["@voyant-travel/db"] })
    seedModule(tmp, "@voyant-travel/catalog", {
      schema: "./schema",
      requiresSchemas: ["@voyant-travel/db"],
    })

    const result = resolveSchemas(
      { modules: ["@voyant-travel/crm"], additionalSchemas: ["@voyant-travel/catalog"] },
      { cwd: tmp },
    )

    expect(result).toContain("@voyant-travel/crm/schema")
    expect(result).toContain("@voyant-travel/catalog/schema")
    expect(result).toContain("@voyant-travel/db/schema")
  })

  it("walks requiresSchemas transitively for additionalSchemas entries", () => {
    seedModule(tmp, "@voyant-travel/db", null)
    seedModule(tmp, "@voyant-travel/facilities", {
      schema: "./schema",
      requiresSchemas: ["@voyant-travel/db"],
    })
    seedModule(tmp, "@voyant-travel/accommodations", {
      schema: "./schema",
      requiresSchemas: ["@voyant-travel/db", "@voyant-travel/facilities"],
    })

    // accommodations is migrated but not mounted as a module.
    const result = resolveSchemas(
      { modules: [], additionalSchemas: ["@voyant-travel/accommodations"] },
      { cwd: tmp },
    )

    expect(result).toEqual([
      "@voyant-travel/db/schema",
      "@voyant-travel/facilities/schema",
      "@voyant-travel/accommodations/schema",
    ])
  })

  it("honors a non-default schema subpath from the manifest", () => {
    seedModule(tmp, "@voyant-travel/db", null)
    seedModule(tmp, "@voyant-travel/flights", {
      schema: "./reference/local-postgres",
      requiresSchemas: ["@voyant-travel/db"],
    })

    const result = resolveSchemas({ additionalSchemas: ["@voyant-travel/flights"] }, { cwd: tmp })

    expect(result).toContain("@voyant-travel/flights/reference/local-postgres")
  })
})
