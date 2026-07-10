import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import type { DeploymentGraphArtifact } from "../../src/lib/deployment-artifact-reader.js"
import {
  createDockerDeploymentTargetAdapter,
  type DeploymentTargetContext,
  validateDeploymentPlan,
} from "../../src/lib/deployment-target.js"

describe("Docker deployment target", () => {
  it("plans executable Node phases with migration before deployment and smoke testing last", () => {
    const adapter = createDockerDeploymentTargetAdapter()
    const plan = adapter.plan(context())

    expect(plan).not.toBeInstanceOf(Promise)
    if (plan instanceof Promise) throw new Error("expected a synchronous Docker plan")
    expect(plan.operations.map(({ id, phase }) => ({ id, phase }))).toEqual([
      { id: "validate-source-graph", phase: "validate" },
      { id: "emit-compose-manifest", phase: "build" },
      { id: "docker-compose-build", phase: "build" },
      { id: "docker-compose-migrate", phase: "migrate" },
      { id: "docker-compose-up", phase: "deploy" },
      { id: "http-health-check", phase: "smoke-test" },
    ])
    expect(plan.operations[3]?.command).toEqual([
      "docker",
      "compose",
      "--file",
      ".voyant/deploy/docker/compose.generated.json",
      "run",
      "--rm",
      "migrate",
    ])
    expect(plan.operations[4]?.command).toEqual([
      "docker",
      "compose",
      "--file",
      ".voyant/deploy/docker/compose.generated.json",
      "up",
      "--detach",
      "--no-deps",
      "app",
    ])
    expect(plan.metadata?.healthUrl).toBe("http://127.0.0.1:8080/api/health")
  })

  it("executes build, migration, start, and HTTP smoke phases in order", async () => {
    const root = mkdtempSync(join(tmpdir(), "voyant-docker-target-"))
    const events: string[] = []
    const adapter = createDockerDeploymentTargetAdapter({
      execute(command) {
        events.push(command.slice(4).join(" "))
        return { stdout: `${command.at(-1)} complete` }
      },
      async waitForHttpHealth(url) {
        events.push(`health ${url}`)
      },
    })

    try {
      const targetContext = context({}, root)
      const plan = adapter.plan(targetContext)
      if (plan instanceof Promise) throw new Error("expected a synchronous Docker plan")
      const output = await adapter.deploy(targetContext, plan)

      expect(events).toEqual([
        "build migrate app",
        "run --rm migrate",
        "up --detach --no-deps app",
        "health http://127.0.0.1:8080/api/health",
      ])
      expect(output).toMatchObject({ applied: true })

      const manifest = JSON.parse(
        readFileSync(join(root, ".voyant/deploy/docker/compose.generated.json"), "utf8"),
      )
      expect(manifest.services.migrate).toMatchObject({
        command: [
          "pnpm",
          "exec",
          "voyant",
          "migrate",
          "--deployment-artifacts",
          ".voyant/deployment-artifacts.generated.json",
        ],
        restart: "no",
      })
      expect(manifest.services.app.depends_on).toEqual({
        migrate: { condition: "service_completed_successfully" },
      })
      expect(manifest.services.app.ports).toEqual(["8080:8080"])
      expect(manifest.services.app.environment.PORT).toBe("8080")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects non-Node graphs before a plan can be printed or executed", () => {
    const targetContext = context()
    targetContext.artifact.graph.deployment.target = "cloudflare-worker"
    const adapter = createDockerDeploymentTargetAdapter()
    const plan = adapter.plan(targetContext)
    if (plan instanceof Promise) throw new Error("expected a synchronous Docker plan")

    expect(() => validateDeploymentPlan(plan, targetContext, "docker")).toThrow(
      "deployment graph target must be node, got cloudflare-worker",
    )
  })
})

function context(
  options: Readonly<Record<string, string | boolean>> = {},
  cwd = "/workspace/app",
): DeploymentTargetContext {
  const contentHash = `sha256:${"a".repeat(64)}`
  return {
    cwd,
    dryRun: false,
    options,
    artifact: {
      manifestPath: join(cwd, ".voyant/deployment-artifacts.generated.json"),
      graphPath: join(cwd, ".voyant/deployment-graph.generated.json"),
      rootDir: join(cwd, ".voyant"),
      contentHash,
      manifest: {
        schemaVersion: "voyant.deployment-artifacts.v1",
        graphHash: contentHash,
        graph: "deployment-graph.generated.json",
        runtimeEntries: [
          {
            id: "@voyant-travel/framework#runtime.node",
            target: "node",
            file: "src/runtime-entry.generated.js",
            graphHash: contentHash,
            kind: "node",
          },
        ],
      },
      graph: {
        schemaVersion: "voyant.resolved-graph.v1",
        contentHash,
        project: {},
        deployment: { target: "node" },
        requirements: { resources: [] },
        modules: [],
        plugins: [],
        packageRecords: [],
        diagnostics: [],
      },
    } satisfies DeploymentGraphArtifact,
  }
}
