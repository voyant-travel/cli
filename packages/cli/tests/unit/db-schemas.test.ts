import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { dbSchemasCommand } from "../../src/commands/db-schemas.js"
import { prepareProjectArtifacts } from "../../src/lib/project-artifacts.js"
import { writeProjectFixture } from "../helpers/project-fixture.js"

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
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  }
}

function seedSchemaPackage(root: string, packageName: string): void {
  const basename = packageName.slice("@voyant-travel/".length)
  const packageRoot = join(root, "packages", basename)
  mkdirSync(join(packageRoot, "src"), { recursive: true })
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: packageName, version: "0.0.0", voyant: { schema: "./schema" } }),
  )
  writeFileSync(join(packageRoot, "src", "schema.ts"), "export const table = 1\n")
}

describe("dbSchemasCommand", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voyant-db-schemas-"))
    writeDatabaseProjectFixture(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("emits selected graph schemas in graph order and preserves generated project links", async () => {
    await prepareProjectArtifacts(root)
    const { ctx, out, err } = makeCtx(["--emit"], root)

    const code = await dbSchemasCommand(ctx)

    expect(err()).toBe("")
    expect(code).toBe(0)
    expect(out()).toContain("Wrote 3 schema entrypoint(s)")
    expect(readFileSync(join(root, "drizzle.schemas.generated.ts"), "utf8")).toContain(
      `export const schema = [
  "./packages/alpha/src/schema.ts",
  "./packages/zeta/src/schema.ts",
  "./drizzle.links.generated.ts",
] as const`,
    )
    expect(readFileSync(join(root, "drizzle.links.generated.ts"), "utf8")).toContain(
      `pgTable(
  "alpha_records_zeta_record"`,
    )
  })

  it("emits schemas when the config imports workspace TypeScript framework exports", async () => {
    rmSync(root, { recursive: true, force: true })
    writeDatabaseProjectFixture(root, "typescript")
    await prepareProjectArtifacts(root)
    const { ctx, out, err } = makeCtx(["--emit"], root)

    expect(await dbSchemasCommand(ctx)).toBe(0)
    expect(err()).toBe("")
    expect(out()).toContain("Wrote 3 schema entrypoint(s)")
    expect(readFileSync(join(root, "drizzle.schemas.generated.ts"), "utf8")).toContain(
      '"./drizzle.links.generated.ts"',
    )
  })
})

function writeDatabaseProjectFixture(
  root: string,
  frameworkSource: "javascript" | "typescript" = "javascript",
): void {
  writeProjectFixture(root, { frameworkSource })
  seedSchemaPackage(root, "@voyant-travel/zeta")
  seedSchemaPackage(root, "@voyant-travel/alpha")
  writeFileSync(
    join(root, "voyant.config.mjs"),
    `import { defineProject } from "@voyant-travel/framework/project"

export default defineProject({
  schemaVersion: "voyant.project.v1",
  modules: ["@voyant-travel/zeta", "@voyant-travel/alpha"],
  plugins: [],
  meta: { testDatabaseGraph: true },
})
`,
  )
}
