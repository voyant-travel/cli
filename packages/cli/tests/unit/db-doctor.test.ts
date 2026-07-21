import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { dbDoctorCommand } from "../../src/commands/db-doctor.js"
import { dbSchemasCommand } from "../../src/commands/db-schemas.js"
import { prepareProjectArtifacts } from "../../src/lib/project-artifacts.js"
import { writeProjectConfig, writeProjectFixture } from "../helpers/project-fixture.js"

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
  writeFileSync(
    join(tmp, "voyant.config.ts"),
    `export default { modules: ["@voyant-travel/db"] }\n`,
  )

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

function graphConfigFixture(tmp: string): void {
  fixture(tmp, { drizzleSchema: ["./packages/db/src/schema.ts"] })
  writeFileSync(
    join(tmp, "voyant.config.ts"),
    `export default {
  modules: [{
    schemaVersion: "voyant.module.v1",
    id: "@voyant-travel/db",
    packageName: "@voyant-travel/db",
  }],
  extensions: [],
  plugins: [],
}
`,
  )
}

async function unifiedGraphFixture(tmp: string): Promise<void> {
  writeProjectFixture(tmp)
  for (const packageName of ["alpha", "zeta"]) {
    const packageRoot = join(tmp, "packages", packageName)
    mkdirSync(join(packageRoot, "src"), { recursive: true })
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: `@voyant-travel/${packageName}`,
        version: "0.0.0",
        voyant: { schema: "./schema" },
      }),
    )
    writeFileSync(join(packageRoot, "src", "schema.ts"), "export const table = 1\n")
  }
  writeFileSync(
    join(tmp, "voyant.config.mjs"),
    `import { defineProject } from "@voyant-travel/framework/project"
export default defineProject({
  schemaVersion: "voyant.project.v1",
  modules: ["@voyant-travel/zeta", "@voyant-travel/alpha"],
  plugins: [],
  meta: { testDatabaseGraph: true },
})
`,
  )
  writeFileSync(
    join(tmp, "drizzle.config.ts"),
    `import { schema } from "./drizzle.schemas.generated.ts"
export default { schema: [...schema], out: "./migrations", dialect: "postgresql" }
`,
  )
  const migrations = join(tmp, "migrations", "meta")
  mkdirSync(migrations, { recursive: true })
  writeFileSync(join(migrations, "0000_snapshot.json"), JSON.stringify({ tables: {} }))
  writeFileSync(join(tmp, "drizzle.links.generated.ts"), "export const placeholder = true\n")
  await prepareProjectArtifacts(tmp)
  const emitted = makeCtx(["--emit"], tmp)
  expect(await dbSchemasCommand(emitted.ctx)).toBe(0)
}

describe("dbDoctorCommand", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-doctor-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("validates a clean graph-native project without drizzle.config", async () => {
    writeProjectFixture(tmp)
    renameSync(join(tmp, "voyant.config.mjs"), join(tmp, "voyant.config.ts"))
    await prepareProjectArtifacts(tmp)
    const { ctx, out, err } = makeCtx(["--fail-on-drift"], tmp)

    const code = await dbDoctorCommand(ctx)

    expect(out()).toContain("voyant db doctor (graph-native project)")
    expect(out()).toContain("Generated project artifacts match the current project graph")
    expect(out()).toContain("Migration plan:")
    expect(out()).toContain("No drift detected.")
    expect(err()).toBe("")
    expect(code).toBe(0)
  })

  it("reports stale graph-native artifacts without failing in report mode", async () => {
    writeProjectFixture(tmp)
    await prepareProjectArtifacts(tmp)
    writeProjectConfig(tmp, { modules: ["@acme/bookings", "@acme/loyalty"] })
    const { ctx, out, err } = makeCtx([], tmp)

    const code = await dbDoctorCommand(ctx)

    expect(out()).toContain("Generated project artifacts are stale")
    expect(out()).toContain("Run `voyant build` or `voyant develop`")
    expect(out()).toContain("Report mode exits 0")
    expect(err()).toBe("")
    expect(code).toBe(0)
  })

  it("reports missing graph-native artifacts with build guidance", async () => {
    writeProjectFixture(tmp)
    const { ctx, out, err } = makeCtx(["--fail-on-drift"], tmp)

    const code = await dbDoctorCommand(ctx)

    expect(out()).toContain("Generated project artifacts are missing")
    expect(out()).toContain("Run `voyant build` or `voyant develop` to refresh .voyant/")
    expect(err()).not.toContain("Could not find a template with drizzle.config")
    expect(code).toBe(1)
  })

  it.each([
    "mts",
    "cjs",
  ])("detects a graph-native voyant.config.%s project before artifacts exist", async (extension) => {
    writeProjectFixture(tmp)
    rmSync(join(tmp, "voyant.config.mjs"))
    writeFileSync(
      join(tmp, `voyant.config.${extension}`),
      extension === "cjs"
        ? "module.exports = { modules: [], plugins: [] }\n"
        : "export default { modules: [], plugins: [] }\n",
    )
    const { ctx, out, err } = makeCtx(["--fail-on-drift"], tmp)

    const code = await dbDoctorCommand(ctx)

    expect(out()).toContain("voyant db doctor (graph-native project)")
    expect(out()).toContain("Generated project artifacts are missing")
    expect(err()).not.toContain("Could not find a template with drizzle.config")
    expect(code).toBe(1)
  })

  it("keeps graph-native resolution failures fatal in report mode", async () => {
    writeProjectFixture(tmp)
    const { ctx, out, err } = makeCtx(["--config", "missing.config.ts"], tmp)

    const code = await dbDoctorCommand(ctx)

    expect(out()).toBe("")
    expect(err()).toContain("Could not validate graph-native project")
    expect(err()).toContain("missing.config.ts")
    expect(code).toBe(1)
  })

  it("fails on stale graph-native artifacts under --fail-on-drift", async () => {
    writeProjectFixture(tmp)
    await prepareProjectArtifacts(tmp)
    writeProjectConfig(tmp, { modules: ["@acme/bookings", "@acme/loyalty"] })
    const { ctx, out } = makeCtx(["--fail-on-drift"], tmp)

    const code = await dbDoctorCommand(ctx)

    expect(out()).toContain("Generated project artifacts are stale")
    expect(out()).toContain("Exiting non-zero (--fail-on-drift)")
    expect(code).toBe(1)
  })

  it("reports clean parity when drizzle.config matches the manifest (report mode exits 0)", async () => {
    fixture(tmp, { drizzleSchema: ["./packages/db/src/schema.ts"] })
    const { ctx, out } = makeCtx([], tmp)
    const code = await dbDoctorCommand(ctx)
    expect(out()).toContain("manifest-derived schema(s) match drizzle.config")
    expect(code).toBe(0)
  })

  it("supports normalized graph config returned by defineConfig", async () => {
    graphConfigFixture(tmp)
    const { ctx, out } = makeCtx(["--fail-on-drift"], tmp)

    const code = await dbDoctorCommand(ctx)

    expect(out()).toContain("Manifest: all 1 module/extension/additionalSchema entr(ies) resolve.")
    expect(out()).toContain("manifest-derived schema(s) match drizzle.config")
    expect(code).toBe(0)
  })

  it("reports malformed graph units without passing undefined to path resolution", async () => {
    graphConfigFixture(tmp)
    writeFileSync(
      join(tmp, "voyant.config.ts"),
      `export default {
  modules: [{ schemaVersion: "voyant.module.v1", id: "local-module" }],
  extensions: [],
  plugins: [],
}
`,
    )
    const { ctx, out } = makeCtx(["--fail-on-drift"], tmp)

    const code = await dbDoctorCommand(ctx)

    expect(out()).toContain(
      "Schema manifest entries must be package strings or objects with a non-empty resolve or packageName field",
    )
    expect(out()).not.toContain('The "path" argument must be of type string')
    expect(code).toBe(1)
  })

  it("fails when a selected graph link is missing from the Drizzle snapshot", async () => {
    await unifiedGraphFixture(tmp)
    const { ctx, out } = makeCtx(["--fail-on-drift"], tmp)

    const code = await dbDoctorCommand(ctx)

    expect(out()).toContain("Link tables are MISSING from the latest Drizzle snapshot")
    expect(out()).toContain("alpha_records_zeta_record")
    expect(out()).not.toContain("Links: no link definitions found")
    expect(code).toBe(1)
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
