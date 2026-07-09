import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { CommandContext } from "../../types.js"
import {
  type LoadedFramework,
  managedDbDoctorCommand,
  resolveManagedSnapshotPath,
} from "../db-doctor-managed.js"

const FRAMEWORK_VERSION = "0.23.1"

function makeCtx(cwd: string, argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const ctx: CommandContext = {
    cwd,
    argv,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  }
  return { ctx, out: () => out.join(""), err: () => err.join("") }
}

/** A stand-in for the deployment's framework/profile API (dynamically loaded in prod). */
function fakeFramework(
  version: string | null = FRAMEWORK_VERSION,
  options: {
    graphApi?: boolean
    graphApiLoadError?: string
    graphDiagnostics?: ReadonlyArray<{
      code: string
      severity?: string
      source?: string
      message: string
      hint?: string
    }>
  } = {},
): LoadedFramework {
  return {
    version,
    api: {
      validateVoyantProject: (input) => {
        const profile = (input as { profile?: string }).profile
        return profile === "operator"
          ? { ok: true, issues: [] }
          : { ok: false, issues: [{ path: "profile", message: 'profile must be "operator".' }] }
      },
      getVoyantProjectMigrationMetadata: (project) => {
        const modules =
          (project as { customSource?: { modules?: string[] } }).customSource?.modules ?? []
        return {
          moduleSources: modules.map((packageName, i) => ({ packageName, priority: i + 1 })),
        }
      },
      resolveActiveModuleIds: () => ["bookings", "catalog"],
    },
    ...(options.graphApiLoadError
      ? { graphApiLoadError: options.graphApiLoadError }
      : options.graphApi === false
        ? {}
        : {
            graphApi: {
              resolveManagedProfileDeploymentGraph: async () => ({
                schemaVersion: "voyant.resolved-graph.v1",
                contentHash:
                  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                modules: [{ id: "@voyant-travel/bookings" }, { id: "@voyant-travel/catalog" }],
                plugins: [],
                diagnostics: options.graphDiagnostics ?? [],
              }),
            },
          }),
  }
}

/** A valid self-hosted operator snapshot (mirrors the managed-operator reference). */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "voyant.managed-profile.v1",
    profile: "operator",
    frameworkVersion: FRAMEWORK_VERSION,
    mode: "self-hosted",
    modules: [],
    plugins: [],
    settings: {},
    admin: { enabled: true, path: "/app" },
    ...overrides,
  }
}

/** Install a fake package into <root>/node_modules, optionally with migrations/. */
function installPackage(root: string, name: string, opts: { migrations?: boolean } = {}): void {
  const dir = join(root, "node_modules", ...name.split("/"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }))
  if (!opts.migrations) return
  const migrations = join(dir, "migrations")
  mkdirSync(join(migrations, "meta"), { recursive: true })
  writeFileSync(
    join(migrations, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [{ idx: 0, tag: "0001_init", when: 1 }],
    }),
  )
  writeFileSync(join(migrations, "0001_init.sql"), 'CREATE TABLE "x" ("id" text);')
}

function writeSnapshot(root: string, value: unknown): string {
  const path = join(root, "managed-profile.json")
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

describe("resolveManagedSnapshotPath", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "voyant-managed-doctor-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("returns null when neither a snapshot flag nor managed-profile.json exists", () => {
    expect(resolveManagedSnapshotPath(dir, undefined)).toBeNull()
  })

  it("auto-detects managed-profile.json at the cwd", () => {
    const path = writeSnapshot(dir, snapshot())
    expect(resolveManagedSnapshotPath(dir, undefined)).toBe(path)
  })

  it("honors an explicit --snapshot path (relative to cwd)", () => {
    expect(resolveManagedSnapshotPath(dir, "custom/profile.json")).toBe(
      join(dir, "custom", "profile.json"),
    )
  })
})

describe("managedDbDoctorCommand", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "voyant-managed-doctor-"))
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme-deployment" }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const loadFramework = async () => fakeFramework()

  it("passes a clean managed profile with a schema-owning custom module", async () => {
    installPackage(dir, "@acme/loyalty", { migrations: true })
    const snapshotPath = writeSnapshot(
      dir,
      snapshot({ customSource: { modules: ["@acme/loyalty"] } }),
    )

    const { ctx, out } = makeCtx(dir, [])
    const code = await managedDbDoctorCommand(ctx, { snapshotPath, loadFramework })

    expect(out()).toContain("No drift detected.")
    expect(out()).toMatch(/@acme\/loyalty.*ships 1 migration/)
    expect(out()).toMatch(/matches the snapshot/)
    expect(out()).toMatch(/Graph: resolved voyant\.resolved-graph\.v1 sha256:/)
    expect(out()).toMatch(/Graph: no diagnostics/)
    expect(code).toBe(0)
  })

  it("flags framework version drift", async () => {
    const snapshotPath = writeSnapshot(dir, snapshot({ frameworkVersion: "0.99.0" }))
    const { ctx, out } = makeCtx(dir, ["--fail-on-drift"])
    const code = await managedDbDoctorCommand(ctx, { snapshotPath, loadFramework })

    expect(out()).toMatch(/Framework version drift/)
    expect(code).toBe(1)
  })

  it("flags a declared custom module that is not installed", async () => {
    const snapshotPath = writeSnapshot(
      dir,
      snapshot({ customSource: { modules: ["@acme/missing"] } }),
    )
    const { ctx, out } = makeCtx(dir, ["--fail-on-drift"])
    const code = await managedDbDoctorCommand(ctx, { snapshotPath, loadFramework })

    expect(out()).toMatch(/@acme\/missing.*declared but not installed/)
    expect(code).toBe(1)
  })

  it("treats an installed schema-less custom module as OK", async () => {
    installPackage(dir, "@acme/analytics", { migrations: false })
    const snapshotPath = writeSnapshot(
      dir,
      snapshot({ customSource: { modules: ["@acme/analytics"] } }),
    )
    const { ctx, out } = makeCtx(dir, ["--fail-on-drift"])
    const code = await managedDbDoctorCommand(ctx, { snapshotPath, loadFramework })

    expect(out()).toMatch(/@acme\/analytics.*owns no schema/)
    expect(out()).toContain("No drift detected.")
    expect(code).toBe(0)
  })

  it("reports an invalid snapshot and does not run further checks", async () => {
    const snapshotPath = writeSnapshot(dir, snapshot({ profile: "not-a-profile" }))
    const { ctx, out } = makeCtx(dir, ["--fail-on-drift"])
    const code = await managedDbDoctorCommand(ctx, { snapshotPath, loadFramework })

    expect(out()).toMatch(/snapshot is invalid/)
    expect(code).toBe(1)
  })

  it("reports when the framework is not installed in the deployment", async () => {
    const snapshotPath = writeSnapshot(dir, snapshot())
    const { ctx, out } = makeCtx(dir, ["--fail-on-drift"])
    const code = await managedDbDoctorCommand(ctx, {
      snapshotPath,
      loadFramework: async () => null,
    })

    expect(out()).toMatch(/@voyant-travel\/framework is not installed/)
    expect(code).toBe(1)
  })

  it("reports deployment graph diagnostics when the installed framework exposes the graph API", async () => {
    const snapshotPath = writeSnapshot(dir, snapshot())
    const { ctx, out } = makeCtx(dir, ["--fail-on-drift"])
    const code = await managedDbDoctorCommand(ctx, {
      snapshotPath,
      loadFramework: async () =>
        fakeFramework(FRAMEWORK_VERSION, {
          graphDiagnostics: [
            {
              code: "VOYANT_GRAPH_MISSING_CAPABILITY",
              severity: "error",
              source: "@acme/voyant-loyalty",
              message: "Required capability acme.crm.people is not provided.",
              hint: "Select a CRM provider.",
            },
          ],
        }),
    })

    expect(out()).toMatch(/Deployment graph reported diagnostics/)
    expect(out()).toMatch(/VOYANT_GRAPH_MISSING_CAPABILITY/)
    expect(code).toBe(1)
  })

  it("keeps older framework installs compatible when the graph API is absent", async () => {
    const snapshotPath = writeSnapshot(dir, snapshot())
    const { ctx, out } = makeCtx(dir, ["--fail-on-drift"])
    const code = await managedDbDoctorCommand(ctx, {
      snapshotPath,
      loadFramework: async () => fakeFramework(FRAMEWORK_VERSION, { graphApi: false }),
    })

    expect(out()).toMatch(/does not expose @voyant-travel\/framework\/deployment-graph yet/)
    expect(out()).toContain("No drift detected.")
    expect(code).toBe(0)
  })

  it("reports a broken deployment graph export as drift", async () => {
    const snapshotPath = writeSnapshot(dir, snapshot())
    const { ctx, out } = makeCtx(dir, ["--fail-on-drift"])
    const code = await managedDbDoctorCommand(ctx, {
      snapshotPath,
      loadFramework: async () =>
        fakeFramework(FRAMEWORK_VERSION, {
          graphApiLoadError: "Cannot find module './deployment-graph.js'",
        }),
    })

    expect(out()).toMatch(/Could not load deployment graph API/)
    expect(out()).toMatch(/Cannot find module/)
    expect(code).toBe(1)
  })
})
