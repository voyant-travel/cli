import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { buildCommand } from "../../src/commands/build-command.js"
import { validateProjectRuntimeConventions } from "../../src/lib/project-convention-validation.js"
import type { ResolvedProjectGraph } from "../../src/lib/project-resolution.js"
import { writeProjectFixture } from "../helpers/project-fixture.js"

describe("project runtime convention validation", () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it("makes voyant build reject webhookRoutes on a runtime-only project module", async () => {
    const root = temporaryProject()
    writeProjectFixture(root, { meta: { testWebhookConvention: true } })
    writeModule(
      root,
      `
      import { defineDeploymentModule } from "@voyant-travel/framework"
      import { Hono } from "hono"
      const webhookRoutes = new Hono()
      export default defineDeploymentModule({
        module: { name: "qa-probe" },
        webhookRoutes,
      })
    `,
    )
    const run = context(root, ["--artifacts-only", "--json"])

    expect(await buildCommand(run.ctx)).toBe(1)
    expect(JSON.parse(run.stderr.join(""))).toMatchObject({
      error: {
        code: "project_convention_invalid",
      },
    })
    expect(run.stderr.join("")).toContain("PROJECT_WEBHOOK_DECLARATION_REQUIRED")
    expect(run.stderr.join("")).toContain('surface: \\"webhook\\"')
    expect(run.stderr.join("")).toContain('direction: \\"inbound\\"')
  })

  it("accepts webhookRoutes when the selected graph declares an inbound webhook for the unit", async () => {
    const root = temporaryProject()
    writeModule(
      root,
      `
      const webhookRoutes = {}
      export default { module: { name: "qa-probe" }, webhookRoutes }
    `,
    )

    await expect(
      validateProjectRuntimeConventions(root, graph({ declaredInbound: true })),
    ).resolves.toBeUndefined()
  })

  it("does not treat comments or string contents as webhook route declarations", async () => {
    const root = temporaryProject()
    writeModule(
      root,
      `
      // webhookRoutes is graph-governed
      export default { module: { name: "qa-probe" }, label: "webhookRoutes" }
    `,
    )

    await expect(validateProjectRuntimeConventions(root, graph())).resolves.toBeUndefined()
  })

  it("ignores webhookRoutes properties on objects unrelated to the default deployment module", async () => {
    const root = temporaryProject()
    writeModule(
      root,
      `
        import { defineDeploymentModule } from "@voyant-travel/framework"
        const helperConfig = { webhookRoutes: "not a Hono module route" }
        export default defineDeploymentModule({
          module: { name: "qa-probe" },
          adminRoutes: helperConfig,
        })
      `,
    )

    await expect(validateProjectRuntimeConventions(root, graph())).resolves.toBeUndefined()
  })

  it("detects webhookRoutes returned directly by a deployment module factory", async () => {
    const root = temporaryProject()
    writeModule(
      root,
      `
        import { defineDeploymentModule as defineModule } from "@voyant-travel/framework"
        const webhookRoutes = {}
        export default defineModule(() => {
          return { module: { name: "qa-probe" }, webhookRoutes }
        })
      `,
    )

    await expect(validateProjectRuntimeConventions(root, graph())).rejects.toThrow(
      "PROJECT_WEBHOOK_DECLARATION_REQUIRED",
    )
  })

  function temporaryProject(): string {
    const root = mkdtempSync(join(tmpdir(), "voyant-project-convention-"))
    roots.push(root)
    return root
  }
})

function writeModule(root: string, source: string): void {
  const directory = join(root, "src", "modules", "qa-probe")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "index.ts"), source)
}

function graph(options: { declaredInbound?: boolean } = {}): ResolvedProjectGraph {
  return {
    schemaVersion: "voyant.resolved-graph.v1",
    contentHash: `sha256:${"a".repeat(64)}`,
    diagnostics: [],
    modules: [
      {
        id: "fixture-project#qa-probe",
        meta: {
          source: "project-convention",
          sourcePath: "src/modules/qa-probe/index.ts",
        },
      },
    ],
    extensions: [],
    plugins: [],
    webhookPlan: {
      inbound: options.declaredInbound ? [{ apiUnitId: "fixture-project#qa-probe" }] : [],
      outbound: [],
    },
  }
}

function context(root: string, argv: string[]) {
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
