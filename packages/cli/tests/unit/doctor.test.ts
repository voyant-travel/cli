import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  collectWranglerInfo,
  doctorCommand,
  parseRequiredBindings,
  runDeploymentGraphPreflight,
  runEnvPreflight,
} from "../../src/commands/doctor.js"
import { prepareProjectArtifacts } from "../../src/lib/project-artifacts.js"
import { writeProjectFixture } from "../helpers/project-fixture.js"

const VALID_GRAPH_HASH = `sha256:${"a".repeat(64)}`

describe("parseRequiredBindings", () => {
  const source = `
    interface CloudflareBindings {
      /** Optional metrics. */
      METRICS?: AnalyticsEngineDataset
      // KV namespaces
      RATE_LIMIT: KVNamespace
      CACHE: KVNamespace
      MEDIA_BUCKET: R2Bucket
      DOCUMENTS_BUCKET: R2Bucket
      INTERNAL_API_KEY: string
      BETTER_AUTH_SECRET: string
      DATABASE_URL: string
      DATABASE_URL_REPLICAS?: string
    }
  `

  it("extracts required bindings classified by category, skipping optionals", () => {
    const got = parseRequiredBindings(source)
    expect(got).toEqual([
      { name: "RATE_LIMIT", category: "kv" },
      { name: "CACHE", category: "kv" },
      { name: "MEDIA_BUCKET", category: "r2" },
      { name: "DOCUMENTS_BUCKET", category: "r2" },
      { name: "INTERNAL_API_KEY", category: "secret" },
      { name: "BETTER_AUTH_SECRET", category: "secret" },
      { name: "DATABASE_URL", category: "secret" },
    ])
    // optional members are excluded
    expect(got.find((b) => b.name === "METRICS")).toBeUndefined()
    expect(got.find((b) => b.name === "DATABASE_URL_REPLICAS")).toBeUndefined()
  })

  it("returns [] when the interface is absent", () => {
    expect(parseRequiredBindings("export const x = 1")).toEqual([])
  })
})

describe("collectWranglerInfo", () => {
  it("collects KV/R2 binding names + vars and flags placeholders (JSONC with comments)", () => {
    const src = `{
      // bindings
      "kv_namespaces": [
        { "binding": "CACHE", "id": "replace-with-cache-kv-namespace-id" },
        { "binding": "RATE_LIMIT", "id": "abc123" }
      ],
      "r2_buckets": [{ "binding": "MEDIA_BUCKET", "bucket_name": "media" }],
      "vars": { "PUBLIC_FLAG": "true" }
    }`
    const info = collectWranglerInfo(src)
    expect(info.kvBindings.sort()).toEqual(["CACHE", "RATE_LIMIT"])
    expect(info.r2Bindings).toEqual(["MEDIA_BUCKET"])
    expect(info.vars).toEqual(["PUBLIC_FLAG"])
    expect(info.placeholders).toEqual(["replace-with-cache-kv-namespace-id"])
  })

  it("returns empty info on unparseable input", () => {
    expect(collectWranglerInfo("{ not json")).toEqual({
      kvBindings: [],
      r2Bindings: [],
      vars: [],
      placeholders: [],
    })
  })
})

describe("runEnvPreflight", () => {
  function ctx(cwd: string) {
    const out: string[] = []
    const err: string[] = []
    return {
      ctx: {
        argv: [],
        cwd,
        stdout: (c: string) => out.push(c),
        stderr: (c: string) => err.push(c),
      },
      out,
      err,
    }
  }

  it("skips cleanly when no env.d.ts / wrangler.jsonc exist", () => {
    const { ctx: c, out } = ctx("/tmp/nonexistent-voyant-doctor-dir")
    const code = runEnvPreflight(c, { strict: false })
    expect(code).toBe(0)
    expect(out.join("")).toContain("skipped")
  })
})

describe("runDeploymentGraphPreflight", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-deployment-graph-doctor-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function ctx(cwd = tmp) {
    const out: string[] = []
    const err: string[] = []
    return {
      ctx: {
        argv: [],
        cwd,
        stdout: (c: string) => out.push(c),
        stderr: (c: string) => err.push(c),
      },
      out,
      err,
    }
  }

  it("skips cleanly when no deployment artifacts exist", () => {
    const { ctx: c, out } = ctx()

    const code = withDatabaseUrlSync(undefined, () => runDeploymentGraphPreflight(c))

    expect(code).toBe(0)
    expect(out.join("")).toContain("deployment graph preflight: skipped")
  })

  it("passes for valid generated deployment graph artifacts", () => {
    writeDeploymentGraphFixture(tmp)
    writeFileSync(join(tmp, ".env"), "DATABASE_URL=postgres://user:pass@example.test:5432/voyant\n")
    const { ctx: c, out, err } = ctx()

    const code = withDatabaseUrlSync(undefined, () => runDeploymentGraphPreflight(c))

    expect(code).toBe(0)
    expect(err.join("")).toBe("")
    expect(out.join("")).toContain("deployment graph preflight: OK")
    expect(out.join("")).toContain("1 modules; 1 plugins; 2 packages")
    expect(out.join("")).toContain("1 required resource env")
  })

  it("prefers a deployment graph doctor report contract when one is provided", () => {
    writeDeploymentGraphDoctorReport(tmp)
    const { ctx: c, out, err } = ctx()

    const code = runDeploymentGraphPreflight(c, {
      reportPath: "deployment-graph-report.json",
    })

    expect(code).toBe(0)
    expect(err.join("")).toBe("")
    expect(out.join("")).toContain("deployment graph preflight: OK")
    expect(out.join("")).toContain("1 modules; 1 plugins; 2 packages")
  })

  it("uses an explicit doctor report instead of validating legacy artifacts", () => {
    writeDeploymentGraphFixture(tmp, { manifestGraphHash: VALID_GRAPH_HASH })
    writeDeploymentGraphDoctorReport(tmp)
    const { ctx: c, out, err } = ctx()

    const code = withDatabaseUrlSync(undefined, () =>
      runDeploymentGraphPreflight(c, {
        reportPath: "deployment-graph-report.json",
      }),
    )

    expect(code).toBe(0)
    expect(err.join("")).toBe("")
    expect(out.join("")).toContain("deployment graph preflight: OK")
  })

  it("fails an invalid explicit doctor report without falling back to artifacts", () => {
    writeDeploymentGraphFixture(tmp)
    writeFileSync(join(tmp, ".env"), "DATABASE_URL=postgres://user:pass@example.test:5432/voyant\n")
    writeJson(join(tmp, "deployment-graph-report.json"), {
      schemaVersion: "voyant.graph-doctor-report.v0",
    })
    const { ctx: c, err } = ctx()

    const code = runDeploymentGraphPreflight(c, {
      reportPath: "deployment-graph-report.json",
    })

    expect(code).toBe(1)
    expect(err.join("")).toContain("deployment graph preflight: FAILED")
    expect(err.join("")).toContain("deployment graph doctor report schema must be")
  })

  it("fails with stable diagnostics from a deployment graph doctor report", () => {
    writeDeploymentGraphDoctorReport(tmp, {
      ok: false,
      diagnostics: [
        {
          code: "VOYANT_GRAPH_ARTIFACT_STALE",
          severity: "error",
          source: "starters/operator/deployment-graph.generated.json",
          facet: "deployment-graph",
          message: "starters/operator/deployment-graph.generated.json is stale.",
          hint: "Run `pnpm --filter operator graph:emit` to refresh generated artifacts.",
        },
      ],
    })
    const { ctx: c, err } = ctx()

    const code = runDeploymentGraphPreflight(c, {
      reportPath: "deployment-graph-report.json",
    })

    expect(code).toBe(1)
    expect(err.join("")).toContain("deployment graph preflight: FAILED")
    expect(err.join("")).toContain("VOYANT_GRAPH_ARTIFACT_STALE")
    expect(err.join("")).toContain("source=starters/operator/deployment-graph.generated.json")
    expect(err.join("")).toContain("facet=deployment-graph")
  })

  it("fails when graph resource env is missing", () => {
    writeDeploymentGraphFixture(tmp)
    const { ctx: c, err } = ctx()

    const code = withDatabaseUrlSync(undefined, () => runDeploymentGraphPreflight(c))

    expect(code).toBe(1)
    expect(err.join("")).toContain("deployment graph preflight: FAILED")
    expect(err.join("")).toContain("secret DATABASE_URL is required for database:postgres")
  })

  it("accepts required graph resource env from process env", () => {
    writeDeploymentGraphFixture(tmp)
    const { ctx: c, out, err } = ctx()

    const code = withDatabaseUrlSync("postgres://user:pass@example.test:5432/voyant", () =>
      runDeploymentGraphPreflight(c),
    )

    expect(code).toBe(0)
    expect(err.join("")).toBe("")
    expect(out.join("")).toContain("deployment graph preflight: OK")
  })

  it("fails when the graph body does not match its content hash", () => {
    const { graph } = writeDeploymentGraphFixture(tmp)
    writeJson(join(tmp, "deployment-graph.generated.json"), {
      ...graph,
      modules: [
        ...graph.modules,
        {
          id: "@voyant-travel/finance",
          packageName: "@voyant-travel/finance",
        },
      ],
    })
    const { ctx: c, err } = ctx()

    const code = runDeploymentGraphPreflight(c)

    expect(code).toBe(1)
    expect(err.join("")).toContain("does not match canonical graph hash")
  })

  it("honors an explicit manifest path", () => {
    const root = join(tmp, "nested")
    writeDeploymentGraphFixture(root)
    writeFileSync(
      join(root, ".env"),
      "DATABASE_URL=postgres://user:pass@example.test:5432/voyant\n",
    )
    const { ctx: c, out } = ctx(tmp)

    const code = withDatabaseUrlSync(undefined, () =>
      runDeploymentGraphPreflight(c, {
        manifestPath: "nested/deployment-artifacts.generated.json",
      }),
    )

    expect(code).toBe(0)
    expect(out.join("")).toContain("deployment graph preflight: OK")
  })
})

describe("doctorCommand --json", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-doctor-json-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function ctx(argv: string[]) {
    const out: string[] = []
    const err: string[] = []
    return {
      ctx: {
        argv,
        cwd: tmp,
        stdout: (c: string) => out.push(c),
        stderr: (c: string) => err.push(c),
      },
      out,
      err,
    }
  }

  it("emits one machine-readable report and captures skipped checks", async () => {
    const { ctx: c, out, err } = ctx(["--json", "--skip-db", "--skip-admin"])

    const code = await withDatabaseUrlAsync(undefined, () => doctorCommand(c))
    const report = JSON.parse(out.join("")) as {
      schemaVersion: string
      ok: boolean
      checks: Array<{ id: string; status: string; stdout: string; stderr: string }>
    }

    expect(code).toBe(0)
    expect(err.join("")).toBe("")
    expect(report.schemaVersion).toBe("voyant.doctor.v1")
    expect(report.ok).toBe(true)
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ["env", "skipped"],
      ["deployment-graph", "skipped"],
      ["db", "skipped"],
      ["admin", "skipped"],
    ])
    expect(report.checks[0]?.stdout).toContain("env preflight: skipped")
  })

  it("uses resolved Node graph bindings instead of Wrangler for unified projects", async () => {
    writeProjectFixture(tmp)
    await prepareProjectArtifacts(tmp)
    writeFileSync(
      join(tmp, "env.d.ts"),
      "interface CloudflareBindings { CACHE: KVNamespace; DATABASE_URL: string }\n",
    )
    writeFileSync(join(tmp, "wrangler.jsonc"), JSON.stringify({ kv_namespaces: [] }))
    const { ctx: c, out, err } = ctx(["--json", "--skip-db", "--skip-admin"])

    const code = await withDatabaseUrlAsync(undefined, () => doctorCommand(c))
    const report = JSON.parse(out.join("")) as {
      ok: boolean
      checks: Array<{ id: string; status: string; stdout: string }>
    }

    expect(code).toBe(0)
    expect(err.join("")).toBe("")
    expect(report.ok).toBe(true)
    expect(report.checks[0]).toMatchObject({ id: "env", status: "skipped" })
    expect(report.checks[0]?.stdout).toContain("unified Node project")
    expect(report.checks[1]).toMatchObject({ id: "deployment-graph", status: "passed" })
  })

  it("reports required package secrets from the resolved Node graph", async () => {
    writeProjectFixture(tmp)
    addMockUnitFacets(
      tmp,
      `secrets: [{ id: specifier + "#secret.api-token", key: "LOYALTY_API_TOKEN", required: true }],`,
    )
    await prepareProjectArtifacts(tmp)
    const { ctx: c, out } = ctx(["--json", "--skip-db", "--skip-admin"])

    const code = await doctorCommand(c)
    const report = JSON.parse(out.join("")) as {
      ok: boolean
      checks: Array<{ id: string; diagnostics?: Array<{ code: string; facet?: string }> }>
    }

    expect(code).toBe(1)
    expect(report.ok).toBe(false)
    expect(report.checks[1]?.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "VOYANT_NODE_SECRET_MISSING",
        facet: "secrets",
      }),
    )
  })

  it("reports required package config that has no selected value or default", async () => {
    writeProjectFixture(tmp)
    addMockUnitFacets(
      tmp,
      `config: [{ id: specifier + "#config.region", key: "region", required: true }],`,
    )
    await prepareProjectArtifacts(tmp)
    const { ctx: c, out } = ctx(["--json", "--skip-db", "--skip-admin"])

    expect(await doctorCommand(c)).toBe(1)
    const report = JSON.parse(out.join("")) as {
      checks: Array<{ diagnostics?: Array<{ code: string; facet?: string }> }>
    }
    expect(report.checks[1]?.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "VOYANT_NODE_CONFIG_MISSING",
        facet: "config",
      }),
    )
  })

  it("rejects migration artifacts that omit a declared setup migration", async () => {
    writeProjectFixture(tmp)
    addMockUnitFacets(
      tmp,
      `setupMigrations: [{ id: specifier + "#setup.seed", runtime: { entry: specifier, export: "seed" } }],`,
    )
    await prepareProjectArtifacts(tmp)
    const { ctx: c, out } = ctx(["--json", "--skip-db", "--skip-admin"])

    expect(await doctorCommand(c)).toBe(1)
    const report = JSON.parse(out.join("")) as {
      checks: Array<{ diagnostics?: Array<{ code: string; facet?: string }> }>
    }
    expect(report.checks[1]?.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "VOYANT_MIGRATION_PLAN_INCOMPLETE",
        facet: "setupMigrations",
      }),
    )
  })

  it("rejects unusable Node resource and provider declarations", async () => {
    writeProjectFixture(tmp)
    addMockUnitFacets(
      tmp,
      `resources: [{ id: specifier + "#resource.database", required: true }],
        providers: [{ id: specifier + "#provider.database", port: "database.client", runtime: { entry: specifier } }],`,
    )
    await prepareProjectArtifacts(tmp)
    const { ctx: c, out } = ctx(["--json", "--skip-db", "--skip-admin"])

    expect(await doctorCommand(c)).toBe(1)
    const report = JSON.parse(out.join("")) as {
      checks: Array<{ diagnostics?: Array<{ code: string; facet?: string }> }>
    }
    expect(report.checks[1]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "VOYANT_NODE_RESOURCE_INVALID", facet: "resources" }),
        expect.objectContaining({ code: "VOYANT_NODE_PROVIDER_INVALID", facet: "providers" }),
      ]),
    )
  })

  it("captures failing check output in JSON and exits non-zero", async () => {
    writeFileSync(
      join(tmp, "env.d.ts"),
      "interface CloudflareBindings {\n  CACHE: KVNamespace\n  DATABASE_URL: string\n}\n",
    )
    writeFileSync(join(tmp, "wrangler.jsonc"), JSON.stringify({ kv_namespaces: [] }))
    const {
      ctx: c,
      out,
      err,
    } = ctx([
      "--json",
      "--strict",
      "--env-types",
      "env.d.ts",
      "--wrangler",
      "wrangler.jsonc",
      "--skip-db",
      "--skip-admin",
    ])

    const code = await withDatabaseUrlAsync(undefined, () => doctorCommand(c))
    const report = JSON.parse(out.join("")) as {
      ok: boolean
      checks: Array<{ id: string; status: string; exitCode: number; stderr: string }>
    }

    expect(code).toBe(1)
    expect(err.join("")).toBe("")
    expect(report.ok).toBe(false)
    expect(report.checks).toMatchObject([
      {
        id: "env",
        status: "failed",
        exitCode: 1,
      },
      {
        id: "deployment-graph",
        status: "skipped",
      },
      {
        id: "db",
        status: "skipped",
      },
      {
        id: "admin",
        status: "skipped",
      },
    ])
    expect(report.checks[0]?.stderr).toContain("env preflight: FAILED")
  })

  it("includes deployment graph artifact failures in JSON output", async () => {
    writeDeploymentGraphFixture(tmp, { manifestGraphHash: VALID_GRAPH_HASH })
    const { ctx: c, out } = ctx(["--json", "--skip-env", "--skip-db", "--skip-admin"])

    const code = await withDatabaseUrlAsync(undefined, () => doctorCommand(c))
    const report = JSON.parse(out.join("")) as {
      ok: boolean
      checks: Array<{ id: string; status: string; exitCode: number; stderr: string }>
    }

    expect(code).toBe(1)
    expect(report.ok).toBe(false)
    expect(report.checks).toMatchObject([
      { id: "env", status: "skipped" },
      {
        id: "deployment-graph",
        status: "failed",
        exitCode: 1,
      },
      { id: "db", status: "skipped" },
      { id: "admin", status: "skipped" },
    ])
    expect(report.checks[1]?.stderr).toContain("does not match graph contentHash")
  })

  it("includes deployment graph resource env failures in JSON output", async () => {
    writeDeploymentGraphFixture(tmp)
    const { ctx: c, out } = ctx(["--json", "--skip-env", "--skip-db", "--skip-admin"])

    const code = await withDatabaseUrlAsync(undefined, () => doctorCommand(c))
    const report = JSON.parse(out.join("")) as {
      ok: boolean
      checks: Array<{ id: string; status: string; exitCode: number; stderr: string }>
    }

    expect(code).toBe(1)
    expect(report.ok).toBe(false)
    expect(report.checks).toMatchObject([
      { id: "env", status: "skipped" },
      {
        id: "deployment-graph",
        status: "failed",
        exitCode: 1,
      },
      { id: "db", status: "skipped" },
      { id: "admin", status: "skipped" },
    ])
    expect(report.checks[1]?.stderr).toContain(
      "secret DATABASE_URL is required for database:postgres",
    )
  })

  it("includes the deployment graph doctor report contract in JSON output", async () => {
    writeDeploymentGraphDoctorReport(tmp, {
      ok: false,
      diagnostics: [
        {
          code: "VOYANT_GRAPH_MISSING_CAPABILITY",
          severity: "error",
          source: "@acme/voyant-plugin-loyalty",
          facet: "requires.capabilities",
          message: "Required capability identity.people is not provided.",
        },
      ],
    })
    const {
      ctx: c,
      out,
      err,
    } = ctx([
      "--json",
      "--skip-env",
      "--skip-db",
      "--skip-admin",
      "--deployment-graph-report",
      "deployment-graph-report.json",
    ])

    const code = await withDatabaseUrlAsync(undefined, () => doctorCommand(c))
    const report = JSON.parse(out.join("")) as {
      ok: boolean
      checks: Array<{
        id: string
        status: string
        diagnostics?: Array<{ code: string }>
        report?: { schemaVersion: string; ok: boolean }
      }>
    }

    expect(code).toBe(1)
    expect(err.join("")).toBe("")
    expect(report.ok).toBe(false)
    expect(report.checks[1]).toMatchObject({
      id: "deployment-graph",
      status: "failed",
      report: {
        schemaVersion: "voyant.graph-doctor-report.v1",
        ok: false,
      },
      diagnostics: [{ code: "VOYANT_GRAPH_MISSING_CAPABILITY" }],
    })
  })
})

function withDatabaseUrlSync<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.DATABASE_URL
  if (value === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
}

async function withDatabaseUrlAsync<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.DATABASE_URL
  if (value === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
}

function writeDeploymentGraphFixture(
  root: string,
  options: { manifestGraphHash?: string } = {},
): {
  graph: Record<string, unknown> & {
    modules: Array<Record<string, unknown>>
  }
} {
  mkdirSync(root, { recursive: true })
  const graphWithoutHash = {
    schemaVersion: "voyant.resolved-graph.v1",
    project: {},
    deployment: { target: "node", mode: "self-hosted", providers: {} },
    modules: [
      {
        id: "@voyant-travel/bookings",
        packageName: "@voyant-travel/bookings",
      },
    ],
    plugins: [
      {
        id: "@voyant-travel/plugin-smartbill",
        packageName: "@voyant-travel/plugin-smartbill",
      },
    ],
    capabilities: { provided: [], required: [] },
    packageRecords: [
      {
        packageName: "@voyant-travel/bookings",
        version: "0.0.0",
        source: { kind: "workspace" },
      },
      {
        packageName: "@voyant-travel/plugin-smartbill",
        version: "0.0.0",
        source: { kind: "workspace" },
      },
    ],
    diagnostics: [],
    requirements: {
      resources: [
        {
          resourceKey: "database:postgres",
          roles: ["database"],
          provider: "postgres",
          required: true,
          env: [
            {
              name: "DATABASE_URL",
              kind: "secret",
              required: true,
              description: "Primary Postgres connection URL.",
            },
            {
              name: "DATABASE_URL_DIRECT",
              kind: "secret",
              required: false,
              description: "Direct Postgres URL.",
            },
          ],
        },
      ],
    },
  }
  const graphHash = `sha256:${createHash("sha256")
    .update(canonicalJson(graphWithoutHash))
    .digest("hex")}`
  const graph = { ...graphWithoutHash, contentHash: graphHash }

  writeFileSync(join(root, "managed-profile.json"), "{}\n")
  writeJson(join(root, "deployment-graph.generated.json"), graph)
  writeJson(join(root, "deployment-artifacts.generated.json"), {
    schemaVersion: "voyant.deployment-artifacts.v1",
    graphHash: options.manifestGraphHash ?? graphHash,
    graph: "deployment-graph.generated.json",
    runtimeEntries: [
      {
        id: "@voyant-travel/framework#runtime.node",
        target: "node",
        file: "src/runtime-entry.generated.ts",
        graphHash,
        kind: "managed-profile-node",
        profileSnapshot: "managed-profile.json",
      },
    ],
  })
  return { graph }
}

function writeDeploymentGraphDoctorReport(
  root: string,
  options: {
    ok?: boolean
    diagnostics?: Array<{
      code: string
      severity: "info" | "warning" | "error"
      source?: string
      facet?: string
      location?: string
      message: string
      hint?: string
    }>
  } = {},
): void {
  mkdirSync(root, { recursive: true })
  writeJson(join(root, "deployment-graph-report.json"), {
    schemaVersion: "voyant.graph-doctor-report.v1",
    ok: options.ok ?? true,
    graph: {
      schemaVersion: "voyant.resolved-graph.v1",
      contentHash: VALID_GRAPH_HASH,
      target: "node",
      mode: "self-hosted",
      modules: {
        count: 1,
        ids: ["@voyant-travel/bookings"],
      },
      plugins: {
        count: 1,
        ids: ["@voyant-travel/plugin-smartbill"],
      },
      packageRecords: {
        count: 2,
        packageNames: ["@voyant-travel/bookings", "@voyant-travel/plugin-smartbill"],
      },
    },
    diagnostics: options.diagnostics ?? [],
  })
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function addMockUnitFacets(root: string, source: string): void {
  const resolverPath = join(root, "node_modules", "@voyant-travel", "framework", "project.mjs")
  const resolver = readFileSync(resolverPath, "utf8")
  writeFileSync(
    resolverPath,
    resolver.replace("        api: [],", `        ${source}\n        api: [],`),
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return sorted
}
