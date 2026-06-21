import { describe, expect, it, vi } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import type { Bundler } from "../build.js"
import type { DeployDeps } from "../deploy.js"
import { runWorkflowsDeploy } from "../deploy.js"
import type { WorkflowDef } from "../list.js"

const CUSTOM_DATABASE_URL = ["postgresql://custom:custom", "db:5432/custom"].join("@")

function okBundler(): Bundler {
  return {
    bundle: vi.fn(async () => ({ ok: true as const })),
  } as unknown as Bundler
}

function makeDeps(overrides: Partial<DeployDeps> = {}): DeployDeps {
  const workflows: WorkflowDef[] = [
    {
      id: "wf",
      config: {
        id: "wf",
        description: "x",
        run: async () => 1,
      } as unknown as WorkflowDef["config"],
    },
  ]
  return {
    bundler: okBundler(),
    importModule: vi.fn(async () => {}),
    resetRegistry: vi.fn(),
    getRegisteredWorkflows: () => workflows,
    writeOut: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
    runCommand: vi.fn(async () => ({ ok: true as const })),
    now: () => "2026-04-18T00:00:00.000Z",
    ...overrides,
  }
}

describe("runWorkflowsDeploy", () => {
  it("fails without --target", async () => {
    const outcome = await runWorkflowsDeploy(parseArgs(["--file", "src/app.ts"]), makeDeps())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/missing required --target/)
  })

  it("fails without --file", async () => {
    const outcome = await runWorkflowsDeploy(parseArgs(["--target", "docker"]), makeDeps())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/missing required --file/)
  })

  it("validates docker port overrides", async () => {
    const outcome = await runWorkflowsDeploy(
      parseArgs(["--target", "docker", "--file", "src/app.ts", "--host-port", "70000"]),
      makeDeps(),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/--host-port must be 1-65535/)
  })

  it("builds a node bundle and stages it for docker", async () => {
    const copyFile = vi.fn(async () => {})
    const bundle = vi.fn(async () => ({ ok: true as const }))
    const writeOut = vi.fn(async () => {})

    const outcome = await runWorkflowsDeploy(
      parseArgs(["--target", "docker", "--file", "src/app.ts"]),
      makeDeps({
        bundler: { bundle } as unknown as Bundler,
        copyFile,
        writeOut,
      }),
    )

    expect(outcome.ok).toBe(true)
    const buildCall = bundle.mock.calls[0]![0] as Parameters<Bundler["bundle"]>[0]
    expect(buildCall.platform).toBe("node")
    expect(copyFile).toHaveBeenCalledTimes(1)
    const envWrite = writeOut.mock.calls.find(([path]) =>
      String(path).match(/apps\/selfhost-node-server\/dist\/selfhost\.env$/),
    )
    expect(envWrite).toBeTruthy()
    expect(copyFile.mock.calls[0]![1]).toMatch(/apps\/selfhost-node-server\/dist\/bundle\.mjs$/)
    if (outcome.ok) {
      expect(outcome.result.stagedConfigPath).toMatch(
        /apps\/selfhost-node-server\/dist\/selfhost\.env$/,
      )
      expect(outcome.result.applied).toBe(false)
      expect(outcome.result.nextStep).toMatch(/docker compose --env-file/)
    }
  })

  it("rejects the removed cloudflare target", async () => {
    const outcome = await runWorkflowsDeploy(
      parseArgs(["--target", "cloudflare", "--file", "src/app.ts"]),
      makeDeps(),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/missing required --target <docker>/)
      expect(outcome.exitCode).toBe(2)
    }
  })

  it("runs the target apply command when --apply is set", async () => {
    const runCommand = vi.fn(async () => ({ ok: true as const }))

    const outcome = await runWorkflowsDeploy(
      parseArgs(["--target", "docker", "--file", "src/app.ts", "--apply"]),
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
        "up",
        "--build",
        "-d",
      ],
      cwd: undefined,
    })
    if (outcome.ok) expect(outcome.result.applied).toBe(true)
  })

  it("lets docker deploy override bootstrap env values", async () => {
    const writeOut = vi.fn(async () => {})

    const outcome = await runWorkflowsDeploy(
      parseArgs([
        "--target",
        "docker",
        "--file",
        "src/app.ts",
        "--host-port",
        "4321",
        "--bind-port",
        "9000",
        "--database-url",
        CUSTOM_DATABASE_URL,
        "--skip-migrations",
        "--database-wait-seconds",
        "45",
        "--env-out",
        ".voyant/custom/docker.env",
      ]),
      makeDeps({ writeOut }),
    )

    expect(outcome.ok).toBe(true)
    const envWrite = writeOut.mock.calls.find(([path]) =>
      String(path).match(/\.voyant\/custom\/docker\.env$/),
    )
    expect(envWrite).toBeTruthy()
    const [path, content] = envWrite!
    expect(path).toMatch(/\.voyant\/custom\/docker\.env$/)
    expect(String(content)).toContain("VOYANT_HOST_PORT=4321")
    expect(String(content)).toContain("VOYANT_BIND_PORT=9000")
    expect(String(content)).toContain(`VOYANT_DATABASE_URL=${CUSTOM_DATABASE_URL}`)
    expect(String(content)).toContain("VOYANT_SKIP_MIGRATIONS=1")
    expect(String(content)).toContain("VOYANT_DATABASE_WAIT_SECONDS=45")
    if (outcome.ok) {
      expect(outcome.result.stagedConfigPath).toMatch(/\.voyant\/custom\/docker\.env$/)
    }
  })

  it("surfaces target apply failures", async () => {
    const outcome = await runWorkflowsDeploy(
      parseArgs(["--target", "docker", "--file", "src/app.ts", "--apply"]),
      makeDeps({
        runCommand: vi.fn(async () => ({
          ok: false as const,
          message: "compose failed",
          exitCode: 1,
        })),
      }),
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/docker apply failed: compose failed/)
      expect(outcome.exitCode).toBe(1)
    }
  })
})
