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

  it("validates the cloudflare target staging files", async () => {
    const outcome = await runWorkflowsDoctor(
      parseArgs(["--target", "cloudflare"]),
      makeDeps({
        readFile: vi.fn(async () =>
          JSON.stringify({
            kv_namespaces: [{ binding: "BUNDLE_HASHES", id: "abc123" }],
            vars: { R2_ACCOUNT_ID: "acct_123" },
          }),
        ),
      }),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.target).toBe("cloudflare")
      expect(outcome.result.ok).toBe(true)
      expect(
        outcome.result.checks.some((check) => check.id === "cloudflare.bundle.import" && check.ok),
      ).toBe(true)
    }
  })

  it("reports unresolved wrangler placeholders for cloudflare self-host", async () => {
    const outcome = await runWorkflowsDoctor(
      parseArgs(["--target", "cloudflare"]),
      makeDeps({
        readFile: vi.fn(async () =>
          [
            'id = "replace-me-after-wrangler-kv-namespace-create"',
            'R2_ACCOUNT_ID = "replace-with-your-cf-account-id"',
          ].join("\n"),
        ),
      }),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.ok).toBe(false)
      expect(
        outcome.result.checks.some(
          (check) =>
            check.id.includes("replace-me-after-wrangler-kv-namespace-create") && !check.ok,
        ),
      ).toBe(true)
      expect(
        outcome.result.checks.some(
          (check) => check.id.includes("replace-with-your-cf-account-id") && !check.ok,
        ),
      ).toBe(true)
    }
  })

  it("runs a wrangler dry-run when requested", async () => {
    const runCommand = vi.fn(async () => ({ ok: true as const }))
    const outcome = await runWorkflowsDoctor(
      parseArgs(["--target", "cloudflare", "--check-cloudflare"]),
      makeDeps({
        readFile: vi.fn(async () =>
          JSON.stringify({
            kv_namespaces: [{ binding: "BUNDLE_HASHES", id: "abc123" }],
            vars: { R2_ACCOUNT_ID: "acct_123" },
          }),
        ),
        runCommand,
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(runCommand).toHaveBeenCalledWith({
      command: [
        "pnpm",
        "--filter",
        "@voyant-travel/workflows-selfhost-cloudflare-worker",
        "run",
        "deploy",
        "--dry-run",
      ],
      cwd: undefined,
      env: expect.objectContaining({
        WRANGLER_LOG_PATH: "/tmp/voyant-workflows-selfhost-cloudflare.log",
      }),
    })
    if (outcome.ok) {
      expect(
        outcome.result.checks.some(
          (check) => check.id === "cloudflare.wrangler.dry-run" && check.ok,
        ),
      ).toBe(true)
    }
  })
})
