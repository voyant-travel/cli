import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { dbDoctorCommand } from "../../src/commands/db-doctor.js"

function makeCtx(argv: string[], cwd: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    ctx: {
      argv,
      cwd,
      stdout: (c: string) => stdout.push(c),
      stderr: (c: string) => stderr.push(c),
    },
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  }
}

interface FixtureOpts {
  /** drizzle.config `schema` array entries (relative to template). */
  drizzleSchema: string[]
  /** migration .sql filenames to create under migrations/. */
  migrations?: string[]
  /** duplicate-prefix baseline contents, if any. */
  baseline?: { duplicates: Array<{ prefix: string; files: string[] }> }
}

function fixture(tmp: string, opts: FixtureOpts): void {
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0" }))
  // Plain object default export — no @voyant-travel/core import needed to load it.
  writeFileSync(join(tmp, "voyant.config.ts"), `export default { modules: ["@voyant-travel/db"] }\n`)

  const dbDir = join(tmp, "packages", "db")
  mkdirSync(join(dbDir, "src"), { recursive: true })
  writeFileSync(
    join(dbDir, "package.json"),
    JSON.stringify({ name: "@voyant-travel/db", version: "0.0.0", voyant: { schema: "./schema" } }),
  )
  writeFileSync(join(dbDir, "src", "schema.ts"), "export const t = 1\n")

  const schemaList = opts.drizzleSchema.map((s) => `    ${JSON.stringify(s)},`).join("\n")
  writeFileSync(
    join(tmp, "drizzle.config.ts"),
    `export default { schema: [\n${schemaList}\n  ], out: "./migrations", dialect: "postgresql" }\n`,
  )

  const migDir = join(tmp, "migrations")
  mkdirSync(join(migDir, "meta"), { recursive: true })
  writeFileSync(join(migDir, "meta", "0000_snapshot.json"), JSON.stringify({ tables: {} }))
  for (const m of opts.migrations ?? []) writeFileSync(join(migDir, m), "-- sql\n")
  if (opts.baseline) {
    writeFileSync(
      join(migDir, "duplicate-prefixes.baseline.json"),
      JSON.stringify(opts.baseline, null, 2),
    )
  }
}

describe("dbDoctorCommand", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-doctor-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("reports clean parity when drizzle.config matches the manifest (report mode exits 0)", async () => {
    fixture(tmp, { drizzleSchema: ["./packages/db/src/schema.ts"] })
    const { ctx, out } = makeCtx([], tmp)
    const code = await dbDoctorCommand(ctx)
    expect(out()).toContain("manifest-derived schema(s) match drizzle.config")
    expect(code).toBe(0)
  })

  it("flags a manifest schema missing from drizzle.config and fails under --fail-on-drift", async () => {
    fixture(tmp, { drizzleSchema: ["./packages/other/src/schema.ts"] }) // omits db schema
    const { ctx, out } = makeCtx(["--fail-on-drift"], tmp)
    const code = await dbDoctorCommand(ctx)
    expect(out()).toContain("MISSING from drizzle.config")
    expect(code).toBe(1)
  })

  it("fails on an un-baselined duplicate migration prefix", async () => {
    fixture(tmp, {
      drizzleSchema: ["./packages/db/src/schema.ts"],
      migrations: ["0001_a.sql", "0001_b.sql"],
    })
    const { ctx, out } = makeCtx(["--fail-on-drift"], tmp)
    const code = await dbDoctorCommand(ctx)
    expect(out()).toContain('Duplicate migration prefix "0001"')
    expect(code).toBe(1)
  })

  it("grandfathers a baselined duplicate prefix (report stays clean)", async () => {
    fixture(tmp, {
      drizzleSchema: ["./packages/db/src/schema.ts"],
      migrations: ["0001_a.sql", "0001_b.sql"],
      baseline: { duplicates: [{ prefix: "0001", files: ["0001_a.sql", "0001_b.sql"] }] },
    })
    const { ctx, out } = makeCtx(["--fail-on-drift"], tmp)
    const code = await dbDoctorCommand(ctx)
    expect(out()).toContain("grandfathered")
    expect(out()).not.toContain('Duplicate migration prefix "0001"')
    expect(code).toBe(0)
  })

  it("still flags a NEW file added to a baselined duplicate prefix", async () => {
    fixture(tmp, {
      drizzleSchema: ["./packages/db/src/schema.ts"],
      migrations: ["0001_a.sql", "0001_b.sql", "0001_c.sql"], // baseline only knows a+b
      baseline: { duplicates: [{ prefix: "0001", files: ["0001_a.sql", "0001_b.sql"] }] },
    })
    const { ctx, out } = makeCtx(["--fail-on-drift"], tmp)
    const code = await dbDoctorCommand(ctx)
    expect(out()).toContain('Duplicate migration prefix "0001"')
    expect(code).toBe(1)
  })
})
