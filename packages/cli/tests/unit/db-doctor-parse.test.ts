import { describe, expect, it } from "vitest"

import { parseDrizzleConfig } from "../../src/commands/db-doctor.js"

describe("parseDrizzleConfig", () => {
  it("extracts a string-literal schema array and the out dir", () => {
    const source = `
      import { defineConfig } from "drizzle-kit"
      export default defineConfig({
        schema: [
          "../../packages/db/src/schema/index.ts",
          "../../packages/crm/src/schema.ts",
        ],
        out: "./migrations",
        dialect: "postgresql",
      })
    `
    const parsed = parseDrizzleConfig(source)
    expect(parsed.schemaEntries).toEqual([
      "../../packages/db/src/schema/index.ts",
      "../../packages/crm/src/schema.ts",
    ])
    expect(parsed.out).toBe("./migrations")
  })

  it("ignores entries inside comments", () => {
    const source = `
      export default defineConfig({
        schema: [
          // "../../packages/ghost/src/schema.ts",
          "../../packages/db/src/schema/index.ts",
          /* "../../packages/other/src/schema.ts" */
        ],
        out: "./migrations",
      })
    `
    const parsed = parseDrizzleConfig(source)
    expect(parsed.schemaEntries).toEqual(["../../packages/db/src/schema/index.ts"])
  })

  it("returns null entries when schema is derived (a call), not a literal list", () => {
    const source = `
      import { resolveSchemas } from "@voyant-travel/cli/drizzle"
      import config from "./voyant.config"
      export default defineConfig({
        schema: resolveSchemas(config),
        out: "./migrations",
      })
    `
    const parsed = parseDrizzleConfig(source)
    expect(parsed.schemaEntries).toBeNull()
  })

  it("returns null entries when schema imports the generated manifest", () => {
    const source = `
      import { schema } from "./drizzle.schemas.generated.js"
      export default defineConfig({ schema, out: "./migrations" })
    `
    const parsed = parseDrizzleConfig(source)
    expect(parsed.schemaEntries).toBeNull()
  })

  it("returns null entries when the array mixes literals and a spread/call", () => {
    const source = `
      export default defineConfig({
        schema: ["./a.ts", ...resolveSchemas(config)],
        out: "./migrations",
      })
    `
    const parsed = parseDrizzleConfig(source)
    expect(parsed.schemaEntries).toBeNull()
  })

  it("defaults out to ./drizzle when absent", () => {
    const source = `export default defineConfig({ schema: ["./a.ts"] })`
    expect(parseDrizzleConfig(source).out).toBe("./drizzle")
  })

  it("flags derived schemas that include local schemas (generated manifest import)", () => {
    const source = `
      import { schema } from "./drizzle.schemas.generated.ts"
      export default defineConfig({ schema: [...schema], out: "./migrations" })
    `
    expect(parseDrizzleConfig(source).derivedIncludesLocalSchemas).toBe(true)
  })

  it("flags derived schemas that include local schemas (resolveSchemaManifest)", () => {
    const source = `
      import { resolveSchemaManifest } from "@voyant-travel/cli/drizzle"
      export default defineConfig({ schema: resolveSchemaManifest(config), out: "./migrations" })
    `
    expect(parseDrizzleConfig(source).derivedIncludesLocalSchemas).toBe(true)
  })

  it("does NOT flag a bare resolveSchemas() (omits template-local schemas)", () => {
    const source = `
      import { resolveSchemas } from "@voyant-travel/cli/drizzle"
      export default defineConfig({ schema: resolveSchemas(config), out: "./migrations" })
    `
    expect(parseDrizzleConfig(source).derivedIncludesLocalSchemas).toBe(false)
  })
})
