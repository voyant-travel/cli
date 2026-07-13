import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { migrateCommand } from "../../src/commands/migrate-command.js"
import { prepareProjectArtifacts } from "../../src/lib/project-artifacts.js"
import { writeProjectConfig, writeProjectFixture } from "../helpers/project-fixture.js"

let currentHash = ""

describe("voyant migrate", () => {
  let root: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "voyant-migrate-"))
    writeProjectFixture(root)
    currentHash = (await prepareProjectArtifacts(root)).manifest.graphHash
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__runVoyantMigrations
    rmSync(root, { recursive: true, force: true })
  })

  it("applies by default and reports applied, skipped, and failed records", async () => {
    let received: unknown
    ;(globalThis as Record<string, unknown>).__runVoyantMigrations = (options: unknown) => {
      received = options
      return result({
        applied: [status("@acme/bookings#migration.initial", "applied")],
        skipped: [status("@acme/bookings#setup.old", "skipped")],
        failed: [],
      })
    }
    const run = context([])

    expect(await migrateCommand(run.ctx)).toBe(0)
    expect(received).toEqual({ dryRun: false })
    expect(run.stdout.join("")).toContain("applied 1")
    expect(run.stdout.join("")).toContain("skipped 1")
    expect(run.stdout.join("")).toContain("failed  0")
  })

  it("supports plan-only and dry-run modes without conflating them", async () => {
    let calls = 0
    ;(globalThis as Record<string, unknown>).__runVoyantMigrations = (options: unknown) => {
      calls += 1
      expect(options).toEqual({ dryRun: true })
      return result({
        applied: [],
        skipped: [status("@acme/bookings#migration.initial", "skipped", "dry_run")],
        failed: [],
      })
    }

    const plan = context(["--plan", "--json"])
    expect(await migrateCommand(plan.ctx)).toBe(0)
    expect(JSON.parse(plan.stdout.join("")).migrationCount).toBe(1)
    expect(calls).toBe(0)

    const dryRun = context(["--dry-run", "--json"])
    expect(await migrateCommand(dryRun.ctx)).toBe(0)
    expect(JSON.parse(dryRun.stdout.join("")).skipped).toHaveLength(1)
    expect(calls).toBe(1)
  })

  it("loads .env without overriding platform values", async () => {
    writeFileSync(join(root, ".env"), "DATABASE_URL=project\nMIGRATION_ENV=loaded\n")
    const env = { DATABASE_URL: "platform" } as Record<string, string | undefined>
    const run = context(["--plan"])

    expect(await migrateCommand(run.ctx, { env })).toBe(0)
    expect(env).toEqual({ DATABASE_URL: "platform", MIGRATION_ENV: "loaded" })
  })

  it("refreshes stale source-project artifacts before loading the runner", async () => {
    writeProjectConfig(root, { modules: ["@acme/bookings", "@acme/finance"] })
    let called = false
    ;(globalThis as Record<string, unknown>).__runVoyantMigrations = () => {
      called = true
      return result({ applied: [], skipped: [], failed: [] })
    }
    const run = context(["--json"])
    const prepareArtifacts = vi.fn(async (...args: Parameters<typeof prepareProjectArtifacts>) => {
      const prepared = await prepareProjectArtifacts(...args)
      currentHash = prepared.manifest.graphHash
      return prepared
    })

    expect(await migrateCommand(run.ctx, { prepareArtifacts })).toBe(0)
    expect(prepareArtifacts).toHaveBeenCalledOnce()
    expect(called).toBe(true)
  })

  it("returns failure while preserving the runner's structured report", async () => {
    ;(globalThis as Record<string, unknown>).__runVoyantMigrations = () =>
      result({
        applied: [status("@acme/bookings#migration.initial", "applied")],
        skipped: [],
        failed: [status("@acme/bookings#setup", "failed", "backfill failed")],
      })
    const run = context(["--json"])

    expect(await migrateCommand(run.ctx)).toBe(1)
    const report = JSON.parse(run.stdout.join(""))
    expect(report.ok).toBe(false)
    expect(report.failed[0]).toMatchObject({
      id: "@acme/bookings#setup",
      detail: "backfill failed",
    })
  })

  it("runs an explicit source-free artifact when its executable runner is present", async () => {
    rmSync(join(root, "voyant.config.mjs"))
    rmSync(join(root, "node_modules"), { recursive: true, force: true })
    ;(globalThis as Record<string, unknown>).__runVoyantMigrations = () =>
      result({
        applied: [status("@acme/bookings#migration.initial", "applied")],
        skipped: [],
        failed: [],
      })
    const run = context([
      "--deployment-artifacts",
      ".voyant/deployment-artifacts.generated.json",
      "--json",
    ])
    const prepareArtifacts = vi.fn()

    expect(await migrateCommand(run.ctx, { prepareArtifacts })).toBe(0)
    expect(prepareArtifacts).not.toHaveBeenCalled()
    expect(JSON.parse(run.stdout.join("")).applied).toHaveLength(1)
  })

  function context(argv: string[]) {
    const stdout: string[] = []
    const stderr: string[] = []
    return {
      ctx: {
        argv,
        cwd: root,
        stdout: (chunk: string) => stdout.push(chunk),
        stderr: (chunk: string) => stderr.push(chunk),
      },
      stdout,
      stderr,
    }
  }
})

function result(parts: { applied: unknown[]; skipped: unknown[]; failed: unknown[] }) {
  return {
    schemaVersion: "voyant.migration-result.v1",
    contentHash: currentHash,
    ...parts,
  }
}

function status(
  id: string,
  state: "applied" | "skipped" | "failed",
  detail = state === "skipped" ? "already_applied" : "executed",
) {
  return { id, migrationKind: id.includes("#setup") ? "setup" : "schema", status: state, detail }
}
