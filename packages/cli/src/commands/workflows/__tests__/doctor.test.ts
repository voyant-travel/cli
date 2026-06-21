import { describe, expect, it, vi } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import { type DoctorDeps, runWorkflowsDoctor } from "../doctor.js"

const DOCKER_DATABASE_URL = ["postgresql://voyant:voyant", "postgres:5432/voyant"].join("@")

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    readFile: vi.fn(async () =>
      [
        "VOYANT_HOST_PORT=3232",
        "VOYANT_BIND_HOST=0.0.0.0",
        "VOYANT_BIND_PORT=3232",
        "VOYANT_ENTRY_FILE=/app/workflows/bundle.mjs",
        `VOYANT_DATABASE_URL=${DOCKER_DATABASE_URL}`,
        "VOYANT_SKIP_MIGRATIONS=0",
        "VOYANT_DATABASE_WAIT_SECONDS=30",
        "",
      ].join("\n"),
    ),
    stat: vi.fn(async () => ({
      isFile: () => true,
      isDirectory: () => false,
    })),
    importModule: vi.fn(async () => ({})),
    runCommand: vi.fn(async () => ({ ok: true as const })),
    resetRegistry: vi.fn(),
    loadWorkflowEntry: vi.fn(async () => ({ warnings: [] })),
    getRegisteredWorkflows: vi.fn(() => [{ id: "wf-a" }] as { id: string }[]),
    scanDeclaredWorkflowIds: vi.fn(async () => [{ id: "wf-a", file: "wf-a.ts" }]),
    ...overrides,
  }
}

describe("runWorkflowsDoctor", () => {
  it("fails without --target", async () => {
    const outcome = await runWorkflowsDoctor(parseArgs([]), makeDeps())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/missing required --target/)
  })

  it("passes for a healthy docker target", async () => {
    const deps = makeDeps()
    const outcome = await runWorkflowsDoctor(parseArgs(["--target", "docker"]), deps)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.ok).toBe(true)
      expect(
        outcome.result.checks.some((check) => check.id === "docker.bundle.import" && check.ok),
      ).toBe(true)
    }
  })

  it("reports missing staged docker files", async () => {
    const outcome = await runWorkflowsDoctor(
      parseArgs(["--target", "docker"]),
      makeDeps({
        stat: vi.fn(async (path: string) => {
          if (String(path).endsWith("bundle.mjs")) {
            throw new Error("ENOENT")
          }
          return {
            isFile: () => true,
            isDirectory: () => false,
          }
        }),
      }),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.ok).toBe(false)
      expect(outcome.result.checks.some((check) => check.id === "docker.bundle" && !check.ok)).toBe(
        true,
      )
    }
  })

  it("validates docker compose rendering when requested", async () => {
    const runCommand = vi.fn(async () => ({ ok: true as const }))
    const outcome = await runWorkflowsDoctor(
      parseArgs(["--target", "docker", "--check-docker"]),
      makeDeps({ runCommand }),
    )
    expect(outcome.ok).toBe(true)
    expect(runCommand).toHaveBeenCalledWith({
      command: [
        "docker",
        "compose",
        "--env-file",
        expect.stringMatching(/apps\/selfhost-node-server\/dist\/selfhost\.env$/),
        "-f",
        "apps/selfhost-node-server/docker-compose.yml",
        "config",
      ],
      cwd: undefined,
    })
    if (outcome.ok) {
      expect(
        outcome.result.checks.some((check) => check.id === "docker.compose.config" && check.ok),
      ).toBe(true)
    }
  })

  it("rejects the removed cloudflare target", async () => {
    const outcome = await runWorkflowsDoctor(parseArgs(["--target", "cloudflare"]), makeDeps())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/missing required --target <docker\|entry>/)
      expect(outcome.exitCode).toBe(2)
    }
  })

  describe("entry target", () => {
    it("requires --file", async () => {
      const outcome = await runWorkflowsDoctor(parseArgs(["--target", "entry"]), makeDeps())
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.message).toMatch(/missing required --file/)
    })

    it("passes for a healthy entry", async () => {
      const outcome = await runWorkflowsDoctor(
        parseArgs(["--target", "entry", "--file", "src/workflows.ts"]),
        makeDeps(),
      )
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.result.target).toBe("entry")
        expect(outcome.result.ok).toBe(true)
        expect(outcome.result.checks.find((c) => c.id === "entry.registered")?.ok).toBe(true)
      }
    })

    it("reports a failed entry import", async () => {
      const outcome = await runWorkflowsDoctor(
        parseArgs(["--target", "entry", "--file", "src/workflows.ts"]),
        makeDeps({
          loadWorkflowEntry: vi.fn(async () => {
            throw new Error("boom")
          }),
        }),
      )
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.result.ok).toBe(false)
        expect(outcome.result.checks.find((c) => c.id === "entry.load")?.ok).toBe(false)
      }
    })

    it("flags duplicate (upstream-owned) workflow ids from registry warnings", async () => {
      const outcome = await runWorkflowsDoctor(
        parseArgs(["--target", "entry", "--file", "src/workflows.ts"]),
        makeDeps({
          loadWorkflowEntry: vi.fn(async () => ({
            warnings: [
              '[workflows] workflow id "channel.booking.push" re-registered — assuming HMR re-import.',
            ],
          })),
        }),
      )
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.result.ok).toBe(false)
        const dup = outcome.result.checks.find((c) => c.id === "entry.duplicate-ids")
        expect(dup?.ok).toBe(false)
        expect(dup?.message).toContain("channel.booking.push")
      }
    })

    it("flags workflows declared in source but never registered from the entry", async () => {
      const outcome = await runWorkflowsDoctor(
        parseArgs(["--target", "entry", "--file", "src/workflows.ts"]),
        makeDeps({
          getRegisteredWorkflows: vi.fn(() => [{ id: "wf-a" }] as { id: string }[]),
          scanDeclaredWorkflowIds: vi.fn(async () => [
            { id: "wf-a", file: "wf-a.ts" },
            { id: "wf-orphan", file: "extra/orphan.ts" },
          ]),
        }),
      )
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.result.ok).toBe(false)
        const unreg = outcome.result.checks.find((c) => c.id === "entry.unregistered")
        expect(unreg?.ok).toBe(false)
        expect(unreg?.message).toContain("wf-orphan")
        expect(unreg?.message).toContain("extra/orphan.ts")
      }
    })

    it("warns when the entry registers no workflows", async () => {
      const outcome = await runWorkflowsDoctor(
        parseArgs(["--target", "entry", "--file", "src/workflows.ts"]),
        makeDeps({
          getRegisteredWorkflows: vi.fn(() => [] as { id: string }[]),
          scanDeclaredWorkflowIds: vi.fn(async () => []),
        }),
      )
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.result.ok).toBe(false)
        expect(outcome.result.checks.find((c) => c.id === "entry.registered")?.ok).toBe(false)
      }
    })
  })
})
