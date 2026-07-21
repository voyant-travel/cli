import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildCommand } from "../../src/commands/build-command.js"
import { deployCommand } from "../../src/commands/deploy.js"
import { doctorCommand } from "../../src/commands/doctor.js"
import { migrateCommand } from "../../src/commands/migrate-command.js"
import { writeProjectConfig, writeProjectFixture } from "../helpers/project-fixture.js"

describe("unified project graph lifecycle", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voyant-project-lifecycle-"))
    writeProjectFixture(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("uses one contentHash across project resolution and every deployment target", async () => {
    const build = io(["--artifacts-only", "--json"], root)
    expect(await buildCommand(build.ctx)).toBe(0)
    const buildReport = JSON.parse(build.stdout.join("")) as { contentHash: string }

    const doctor = io(["--json", "--skip-env", "--skip-db", "--skip-admin"], root)
    expect(await doctorCommand(doctor.ctx)).toBe(0)
    const doctorReport = JSON.parse(doctor.stdout.join("")) as {
      checks: Array<{ id: string; contentHash?: string }>
    }
    const doctorHash = doctorReport.checks.find(
      (check) => check.id === "deployment-graph",
    )?.contentHash

    const migrate = io(["--json"], root)
    expect(await migrateCommand(migrate.ctx)).toBe(0)
    const migrateReport = JSON.parse(migrate.stdout.join("")) as { contentHash: string }

    const cloud = io(["fixture", "--dry-run", "--json"], root)
    expect(await deployCommand(cloud.ctx)).toBe(0)
    const cloudHash = JSON.parse(cloud.stdout.join("")).source.contentHash as string

    const docker = io(["--target", "docker", "--dry-run", "--json"], root)
    expect(await deployCommand(docker.ctx)).toBe(0)
    const dockerHash = JSON.parse(docker.stdout.join("")).source.contentHash as string

    writeFileSync(
      join(root, "deployment-adapter.mjs"),
      `export default {
  name: "custom",
  plan({ artifact }) {
    return {
      schemaVersion: "voyant.deployment-plan.v1",
      target: "custom",
      source: {
        artifactManifest: ".voyant/deployment-artifacts.generated.json",
        graph: ".voyant/deployment-graph.generated.json",
        contentHash: artifact.contentHash,
      },
      operations: [],
    }
  },
  deploy() { throw new Error("dry-run must not deploy") },
}
`,
    )
    const custom = io(
      ["--target", "custom", "--adapter", "./deployment-adapter.mjs", "--dry-run", "--json"],
      root,
    )
    expect(await deployCommand(custom.ctx)).toBe(0)
    const customHash = JSON.parse(custom.stdout.join("")).source.contentHash as string

    expect(doctorHash).toBe(buildReport.contentHash)
    expect(migrateReport.contentHash).toBe(buildReport.contentHash)
    expect(cloudHash).toBe(buildReport.contentHash)
    expect(dockerHash).toBe(buildReport.contentHash)
    expect(customHash).toBe(buildReport.contentHash)
  }, 15_000)

  it("doctor and deploy reject stale artifacts while migrate refreshes them", async () => {
    const build = io(["--artifacts-only"], root)
    expect(await buildCommand(build.ctx)).toBe(0)
    writeProjectConfig(root, { modules: ["@acme/bookings"], plugins: ["@acme/payments"] })

    const doctor = io(["--json", "--skip-env", "--skip-db", "--skip-admin"], root)
    expect(await doctorCommand(doctor.ctx)).toBe(1)
    const doctorReport = JSON.parse(doctor.stdout.join("")) as {
      checks: Array<{ id: string; stderr: string }>
    }
    expect(doctorReport.checks.find((check) => check.id === "deployment-graph")?.stderr).toContain(
      "artifacts are stale",
    )

    const migrate = io(["--json"], root)
    expect(await migrateCommand(migrate.ctx)).toBe(0)
    expect(JSON.parse(migrate.stdout.join(""))).toMatchObject({ ok: true })

    writeProjectConfig(root, { modules: ["@acme/bookings"], plugins: [] })
    const deploy = io(["fixture", "--dry-run", "--json"], root)
    expect(await deployCommand(deploy.ctx)).toBe(1)
    expect(JSON.parse(deploy.stderr.join(""))).toMatchObject({
      error: { code: "artifact_stale" },
    })
  })
})

function io(argv: string[], cwd: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    ctx: {
      argv,
      cwd,
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
  }
}
