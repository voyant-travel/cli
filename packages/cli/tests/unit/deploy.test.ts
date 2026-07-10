import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { deployCommand } from "../../src/commands/deploy.js"

const tempRoots: string[] = []

describe("deploy target adapters", () => {
  let previousFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    previousFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = previousFetch as typeof globalThis.fetch
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it("plans and triggers the default Cloud target with the source graph contentHash", async () => {
    const fixture = writeDeploymentFixture({ project: { appSlug: "web" } })
    const dryRun = makeContext(fixture.root, ["--dry-run", "--json"])

    expect(await deployCommand(dryRun.ctx)).toBe(0)
    const plan = JSON.parse(dryRun.stdout.join(""))
    expect(plan.target).toBe("voyant-cloud")
    expect(plan.source.contentHash).toBe(fixture.contentHash)

    let requestBody: Record<string, unknown> | undefined
    let requestUrl: string | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input)
      requestBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          data: {
            id: "dep_123",
            status: "queued",
            environment: "production",
            version: fixture.contentHash,
            trigger: "cli",
            createdAt: "2026-07-10T00:00:00.000Z",
            completedAt: null,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof globalThis.fetch

    const apply = makeContext(fixture.root, [
      "--json",
      "--token",
      "token",
      "--api-url",
      "https://api.test",
    ])
    expect(await deployCommand(apply.ctx)).toBe(0)
    expect(requestUrl).toBe("https://api.test/cloud/v1/apps/web/deployments")
    expect(requestBody).toEqual({ environment: "production", version: fixture.contentHash })
    const result = JSON.parse(apply.stdout.join(""))
    expect(result.id).toBe("dep_123")
    expect(result.sourceContentHash).toBe(fixture.contentHash)
    expect(result.plan.source.contentHash).toBe(fixture.contentHash)
  })

  it("emits a deterministic whole-application Docker manifest with the source contentHash", async () => {
    const fixture = writeDeploymentFixture({ project: {} })
    const run = makeContext(fixture.root, ["--target", "docker", "--emit-manifest", "--json"])

    expect(await deployCommand(run.ctx)).toBe(0)
    const result = JSON.parse(run.stdout.join(""))
    expect(result.sourceContentHash).toBe(fixture.contentHash)
    expect(result.plan.source.contentHash).toBe(fixture.contentHash)

    const manifestPath = join(fixture.root, result.output.manifest)
    const first = readFileSync(manifestPath, "utf8")
    const manifest = JSON.parse(first)
    expect(manifest["x-voyant"].source.contentHash).toBe(fixture.contentHash)
    expect(manifest["x-voyant"].application.modules).toEqual([
      "@voyant-travel/bookings",
      "@voyant-travel/catalog",
    ])
    expect(manifest["x-voyant"].application.plugins).toEqual(["@voyant-travel/plugin-smartbill"])
    expect(manifest["x-voyant"].application.runtimeEntries).toEqual([
      expect.objectContaining({
        id: "@voyant-travel/framework#runtime.node",
        graphHash: fixture.contentHash,
      }),
    ])
    expect(manifest.services.app.environment.DATABASE_URL).toContain("DATABASE_URL is required")

    expect(await deployCommand(run.ctx)).toBe(0)
    expect(readFileSync(manifestPath, "utf8")).toBe(first)
  })

  it("loads the project-specified custom adapter without loading project config or resolving a graph", async () => {
    const fixture = writeDeploymentFixture({
      project: { meta: { deploymentAdapter: "./deployment-adapter.mjs" } },
    })
    writeFileSync(
      join(fixture.root, "voyant.config.mjs"),
      'throw new Error("project config import would re-resolve the graph")\n',
    )
    writeFileSync(
      join(fixture.root, "deployment-adapter.mjs"),
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
      operations: [
        { id: "publish", phase: "deploy", description: "Publish custom target." },
      ],
    }
  },
  deploy(_context, plan) {
    return { adapter: "custom", contentHash: plan.source.contentHash }
  },
}
`,
    )

    const run = makeContext(fixture.root, ["--target", "custom", "--dry-run", "--json"])
    expect(await deployCommand(run.ctx)).toBe(0)
    const plan = JSON.parse(run.stdout.join(""))
    expect(plan.target).toBe("custom")
    expect(plan.source.contentHash).toBe(fixture.contentHash)
    expect(run.stderr).toEqual([])
  })

  it("rejects unsupported and stale graph artifacts before target planning", async () => {
    const unsupported = writeDeploymentFixture({ project: {} })
    const unsupportedManifestPath = join(
      unsupported.root,
      ".voyant",
      "deployment-artifacts.generated.json",
    )
    const unsupportedManifest = JSON.parse(readFileSync(unsupportedManifestPath, "utf8"))
    unsupportedManifest.schemaVersion = "voyant.deployment-artifacts.v2"
    writeJson(unsupportedManifestPath, unsupportedManifest)

    const unsupportedRun = makeContext(unsupported.root, [
      "--target",
      "docker",
      "--dry-run",
      "--json",
    ])
    expect(await deployCommand(unsupportedRun.ctx)).toBe(1)
    expect(JSON.parse(unsupportedRun.stderr.join("")).error.code).toBe("artifact_unsupported")

    const stale = writeDeploymentFixture({ project: {} })
    const graphPath = join(stale.root, ".voyant", "deployment-graph.generated.json")
    const graph = JSON.parse(readFileSync(graphPath, "utf8"))
    graph.modules.push({ id: "@voyant-travel/finance" })
    writeJson(graphPath, graph)

    const staleRun = makeContext(stale.root, ["--target", "docker", "--dry-run", "--json"])
    expect(await deployCommand(staleRun.ctx)).toBe(1)
    expect(JSON.parse(staleRun.stderr.join("")).error.code).toBe("artifact_stale")
  })
})

function makeContext(cwd: string, argv: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    ctx: {
      argv,
      cwd,
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
    stdout,
    stderr,
  }
}

function writeDeploymentFixture(options: { project: Record<string, unknown> }): {
  root: string
  contentHash: string
} {
  const root = mkdtempSync(join(tmpdir(), "voyant-deploy-test-"))
  tempRoots.push(root)
  const artifactRoot = join(root, ".voyant")
  mkdirSync(join(artifactRoot, "src"), { recursive: true })

  const graphWithoutHash = {
    schemaVersion: "voyant.resolved-graph.v1",
    project: options.project,
    deployment: { target: "node", mode: "self-hosted", providers: {} },
    requirements: {
      resources: [
        {
          resourceKey: "database:postgres",
          provider: "postgres",
          required: true,
          roles: ["database"],
          env: [
            {
              name: "DATABASE_URL",
              kind: "secret",
              required: true,
              description: "Primary Postgres connection URL.",
            },
          ],
        },
      ],
    },
    modules: [{ id: "@voyant-travel/catalog" }, { id: "@voyant-travel/bookings" }],
    plugins: [{ id: "@voyant-travel/plugin-smartbill" }],
    capabilities: { provided: [], required: [] },
    packageRecords: [],
    provisioning: {
      scheduledJobs: [{ id: "@voyant-travel/bookings#workflow.release-holds" }],
    },
    diagnostics: [],
  }
  const contentHash = `sha256:${createHash("sha256")
    .update(canonicalJson(graphWithoutHash))
    .digest("hex")}`
  writeJson(join(artifactRoot, "deployment-graph.generated.json"), {
    ...graphWithoutHash,
    contentHash,
  })
  writeFileSync(join(artifactRoot, "src", "runtime-entry.generated.ts"), "export {}\n")
  writeFileSync(join(artifactRoot, "managed-profile.json"), "{}\n")
  writeJson(join(artifactRoot, "deployment-artifacts.generated.json"), {
    schemaVersion: "voyant.deployment-artifacts.v1",
    graphHash: contentHash,
    graph: "deployment-graph.generated.json",
    runtimeEntries: [
      {
        id: "@voyant-travel/framework#runtime.node",
        target: "node",
        file: "src/runtime-entry.generated.ts",
        graphHash: contentHash,
        kind: "managed-profile-node",
        profileSnapshot: "managed-profile.json",
      },
    ],
  })
  return { root, contentHash }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
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
