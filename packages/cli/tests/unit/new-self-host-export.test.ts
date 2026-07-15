import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { newCommand } from "../../src/commands/new.js"
import type {
  SelfHostExportApi,
  SelfHostProjection,
} from "../../src/templates/self-host-export-project.js"

const HASH_A = `sha256:${"a".repeat(64)}`
const HASH_B = `sha256:${"b".repeat(64)}`
const GIT_REFERENCE = "git+https://github.com/acme/voyant-payments.git#0123456789abcdef"

function makeCtx(argv: string[], cwd: string) {
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

function projection(overrides: Partial<SelfHostProjection> = {}): SelfHostProjection {
  return {
    schemaVersion: "voyant.self-host-projection.v1",
    ready: true,
    frameworkVersion: "0.45.0",
    sourceGraphHash: HASH_A,
    projectedGraphHash: HASH_B,
    starter: {
      schemaVersion: "voyant.node-starter.v2",
      rootFiles: [".env.example", ".gitignore", "package.json", "voyant.config.ts"],
      optionalDirectories: [
        "src/api/admin",
        "src/api/public",
        "src/admin",
        "src/modules",
        "src/extensions",
        "src/workflows",
        "src/jobs",
        "src/subscribers",
        "src/links",
        "src/scripts",
      ],
      seedEntry: "src/scripts/seed.ts",
      deploymentTarget: "node",
      databaseProvider: "postgres",
      defaultPlugins: [],
      packageScripts: {
        dev: "voyant develop",
        build: "voyant build",
        start: "voyant start",
        seed: "voyant exec ./src/scripts/seed.ts",
        "db:migrate": "voyant migrate",
      },
      runtimeDependencies: [
        "@voyant-travel/framework",
        "@voyant-travel/runtime",
        "@voyant-travel/operator-standard",
        "@tanstack/react-query",
        "@tanstack/react-router",
        "react",
        "react-dom",
        "pg",
      ],
      developmentDependencies: ["@voyant-travel/cli", "tsx", "typescript"],
      gitignoreEntries: [".voyant/", "dist/", "node_modules/", ".env", ".env.*", "!.env.example"],
    },
    project: {
      productBom: {
        schemaVersion: "voyant.product-bom-reference.v1",
        id: "@voyant-travel/operator-standard",
        version: "1",
      },
      modules: [
        {
          id: "@acme/voyant-loyalty#modules/rewards",
          resolve: "@acme/voyant-loyalty/modules/rewards",
          packageName: "@acme/voyant-loyalty",
          version: "1.2.3",
          config: { nested: { enabled: true }, tier: "gold" },
        },
      ],
      extensions: [
        {
          id: "@acme/voyant-loyalty#extensions/admin/rewards",
          resolve: "@acme/voyant-loyalty/extensions/admin/rewards",
          packageName: "@acme/voyant-loyalty",
          version: "1.2.3",
        },
      ],
      plugins: [
        {
          id: "@acme/voyant-payments#stripe",
          resolve: "@acme/voyant-payments/stripe",
          packageName: "@acme/voyant-payments",
          config: { capture: "manual" },
        },
      ],
      deployment: {
        target: "node",
        mode: "self-hosted",
        providers: {
          database: "postgres",
          storage: "s3-compatible",
          auth: "better-auth",
          sms: "twilio",
        },
      },
    },
    graph: {
      packageRecords: [
        {
          packageName: "@acme/voyant-loyalty",
          version: "1.2.3",
          source: { kind: "registry", reference: "@1.2.3", integrity: "sha512-loyalty" },
        },
        {
          packageName: "@acme/voyant-payments",
          source: { kind: "git", reference: GIT_REFERENCE },
        },
        {
          packageName: "@voyant-travel/framework",
          version: "0.45.0",
          source: { kind: "registry", reference: "@0.45.0" },
        },
      ],
    },
    providerRemaps: [
      {
        role: "auth",
        from: "voyant-cloud",
        to: "better-auth",
        reason: "self-host-default",
      },
      {
        role: "sms",
        from: "voyant-cloud",
        to: "twilio",
        reason: "explicit-override",
      },
    ],
    provisioning: {
      resources: [
        {
          resourceKey: "auth:better-auth",
          roles: ["auth"],
          provider: "better-auth",
          required: true,
          env: [
            {
              name: "BETTER_AUTH_SECRET",
              kind: "secret",
              required: true,
              description: "Better Auth signing secret.",
            },
          ],
        },
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
          ],
        },
      ],
      database: {
        engine: "postgresql",
        format: "pg-custom",
        dump: { path: "database/operator.dump", byteLength: 4096, contentHash: HASH_A },
      },
      objectStorage: {
        objects: [
          {
            logicalStore: "media",
            key: "logos/operator.png",
            path: "objects/media/logos/operator.png",
            byteLength: 1024,
            contentHash: HASH_B,
          },
        ],
      },
    },
    diagnostics: [],
    ...overrides,
  }
}

function successfulApi(
  project: (options: {
    providerOverrides?: Readonly<Record<string, string>>
  }) => SelfHostProjection = () => projection(),
) {
  const validate = vi.fn(async (input: unknown) => ({
    ok: true as const,
    value: input,
    issues: [] as const,
  }))
  const projectExport = vi.fn(async (_input: unknown, options = {}) => project(options))
  const api: SelfHostExportApi = {
    validateVoyantSelfHostExportBundle: validate,
    projectVoyantSelfHostExport: projectExport,
  }
  return { api, validate, projectExport }
}

function writeBundle(root: string, value: unknown = { schemaVersion: "fixture" }): string {
  const path = join(root, "export.json")
  writeFileSync(path, JSON.stringify(value))
  return path
}

function allFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files.push(relative(root, join(entry.parentPath, entry.name)))
  }
  return files.sort()
}

function fileSnapshot(root: string): Record<string, string> {
  return Object.fromEntries(
    allFiles(root).map((path) => [path, readFileSync(join(root, path), "utf8")]),
  )
}

describe("newCommand --from-export", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-self-host-export-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("validates first and preserves nested selections, exact versions, config, and git sources", async () => {
    const bundlePath = writeBundle(tmp)
    const { api, validate, projectExport } = successfulApi()
    const { ctx } = makeCtx(["my-app", "--from-export", bundlePath], tmp)

    expect(await newCommand(ctx, { loadSelfHostExportApi: async () => api })).toBe(0)
    expect(validate).toHaveBeenCalledOnce()
    expect(projectExport.mock.invocationCallOrder[0]).toBeGreaterThan(
      validate.mock.invocationCallOrder[0] ?? 0,
    )

    const config = readFileSync(join(tmp, "my-app", "voyant.config.ts"), "utf8")
    expect(config).toContain('import { defineProject } from "@voyant-travel/framework/project"')
    expect(config).toContain('"resolve": "@acme/voyant-loyalty/modules/rewards"')
    expect(config).toContain('"resolve": "@acme/voyant-loyalty/extensions/admin/rewards"')
    expect(config).toContain('"resolve": "@acme/voyant-payments/stripe"')
    expect(config).toContain('"tier": "gold"')
    expect(config).toContain('"mode": "self-hosted"')

    const packageJson = JSON.parse(readFileSync(join(tmp, "my-app", "package.json"), "utf8"))
    expect(packageJson.dependencies).toMatchObject({
      "@acme/voyant-loyalty": "1.2.3",
      "@acme/voyant-payments": GIT_REFERENCE,
      "@voyant-travel/framework": "0.45.0",
    })
    expect(packageJson.dependencies).not.toHaveProperty("@acme/voyant-loyalty/modules/rewards")
  })

  it("passes repeatable provider overrides to projection and emits the projected choices", async () => {
    const bundlePath = writeBundle(tmp)
    const { api, projectExport } = successfulApi(({ providerOverrides }) => {
      const next = projection()
      return {
        ...next,
        project: {
          ...next.project,
          deployment: {
            ...next.project.deployment,
            providers: { ...next.project.deployment.providers, ...providerOverrides },
          },
        },
      }
    })
    const { ctx } = makeCtx(
      [
        "my-app",
        "--from-export",
        bundlePath,
        "--provider",
        "sms=twilio",
        "--provider=email=resend",
      ],
      tmp,
    )

    expect(await newCommand(ctx, { loadSelfHostExportApi: async () => api })).toBe(0)
    expect(projectExport).toHaveBeenCalledWith(expect.anything(), {
      providerOverrides: { email: "resend", sms: "twilio" },
    })
    const config = readFileSync(join(tmp, "my-app", "voyant.config.ts"), "utf8")
    expect(config).toContain('"email": "resend"')
    expect(config).toContain('"sms": "twilio"')
  })

  it("refuses unsupported projections with actionable diagnostics and leaves no target", async () => {
    const bundlePath = writeBundle(tmp)
    const blocked = projection({
      ready: false,
      diagnostics: [
        {
          code: "VOYANT_SELF_HOST_PROVIDER_UNSUPPORTED",
          severity: "error",
          path: "$.resolvedGraph.deployment.providers.sms",
          message: "Provider sms=voyant-cloud has no supported self-host projection.",
          hint: "Set providerOverrides.sms to one of: twilio, none.",
        },
      ],
    })
    const { api } = successfulApi(() => blocked)
    const { ctx, stderr } = makeCtx(["my-app", "--from-export", bundlePath], tmp)

    expect(await newCommand(ctx, { loadSelfHostExportApi: async () => api })).toBe(1)
    expect(stderr.join("")).toContain("VOYANT_SELF_HOST_PROVIDER_UNSUPPORTED")
    expect(stderr.join("")).toContain("--provider")
    expect(stderr.join("")).toContain("providerOverrides.sms")
    expect(existsSync(join(tmp, "my-app"))).toBe(false)
  })

  it("refuses invalid bundles before projection", async () => {
    const bundlePath = writeBundle(tmp)
    const projectExport = vi.fn()
    const api: SelfHostExportApi = {
      async validateVoyantSelfHostExportBundle() {
        return {
          ok: false,
          issues: [
            {
              code: "VOYANT_EXPORT_GRAPH_HASH_MISMATCH",
              path: "$.graphHash",
              message: "graphHash does not match resolvedGraph.contentHash.",
            },
          ],
        }
      },
      projectVoyantSelfHostExport: projectExport,
    }
    const { ctx, stderr } = makeCtx(["my-app", "--from-export", bundlePath], tmp)

    expect(await newCommand(ctx, { loadSelfHostExportApi: async () => api })).toBe(1)
    expect(stderr.join("")).toContain("VOYANT_EXPORT_GRAPH_HASH_MISMATCH")
    expect(stderr.join("")).toContain("$.graphHash")
    expect(projectExport).not.toHaveBeenCalled()
    expect(existsSync(join(tmp, "my-app"))).toBe(false)
  })

  it("reports non-portable package sources without creating a partial project", async () => {
    const bundlePath = writeBundle(tmp)
    const blocked = projection({
      ready: false,
      diagnostics: [
        {
          code: "VOYANT_SELF_HOST_PACKAGE_SOURCE_UNAVAILABLE",
          severity: "error",
          path: '$.resolvedGraph.packageRecords["@acme/private"].source',
          message: "Package @acme/private uses non-portable source kind workspace.",
          hint: "Publish the package to a registry or provide an installable git source.",
        },
      ],
    })
    const { api } = successfulApi(() => blocked)
    const { ctx, stderr } = makeCtx(["my-app", "--from-export", bundlePath], tmp)

    expect(await newCommand(ctx, { loadSelfHostExportApi: async () => api })).toBe(1)
    expect(stderr.join("")).toContain("VOYANT_SELF_HOST_PACKAGE_SOURCE_UNAVAILABLE")
    expect(stderr.join("")).toContain("installable git source")
    expect(existsSync(join(tmp, "my-app"))).toBe(false)
  })

  it("writes only blank secret placeholders and excludes bundle secret values", async () => {
    const secretValue = "super-secret-export-value"
    const bundlePath = writeBundle(tmp, { secretValue })
    const next = projection()
    ;(next.provisioning.resources[0]?.env[0] as unknown as { value: string }).value = secretValue
    const { api } = successfulApi(() => next)
    const { ctx } = makeCtx(["my-app", "--from-export", bundlePath], tmp)

    expect(await newCommand(ctx, { loadSelfHostExportApi: async () => api })).toBe(0)
    const generated = fileSnapshot(join(tmp, "my-app"))
    expect(Object.values(generated).join("\n")).not.toContain(secretValue)
    expect(generated[".env.example"]).toContain("BETTER_AUTH_SECRET=\n")
    expect(generated["SELF_HOST_PROVISIONING.md"]).toContain("`BETTER_AUTH_SECRET`")
  })

  it("uses the small starter shape and produces deterministic output", async () => {
    const firstRoot = join(tmp, "first")
    const secondRoot = join(tmp, "second")
    mkdirSync(firstRoot)
    mkdirSync(secondRoot)
    const firstBundle = writeBundle(firstRoot)
    const secondBundle = writeBundle(secondRoot)
    const { api } = successfulApi()

    const first = makeCtx(["my-app", "--from-export", firstBundle], firstRoot)
    const second = makeCtx(["my-app", "--from-export", secondBundle], secondRoot)
    expect(await newCommand(first.ctx, { loadSelfHostExportApi: async () => api })).toBe(0)
    expect(await newCommand(second.ctx, { loadSelfHostExportApi: async () => api })).toBe(0)

    const firstProject = join(firstRoot, "my-app")
    const secondProject = join(secondRoot, "my-app")
    expect(allFiles(firstProject)).toEqual([
      ".env.example",
      ".gitignore",
      "SELF_HOST_PROVISIONING.md",
      "package.json",
      "src/scripts/seed.ts",
      "voyant.config.ts",
    ])
    for (const directory of projection().starter.optionalDirectories) {
      expect(existsSync(join(firstProject, directory))).toBe(true)
    }
    expect(fileSnapshot(firstProject)).toEqual(fileSnapshot(secondProject))
  })

  it("validates collisions before writing and replaces a forced target only after readiness", async () => {
    const bundlePath = writeBundle(tmp)
    const target = join(tmp, "my-app")
    mkdirSync(target)
    writeFileSync(join(target, "stale.txt"), "keep until ready\n")
    const blocked = projection({ ready: false, diagnostics: [] })
    const blockedApi = successfulApi(() => blocked).api

    const blockedCtx = makeCtx(["my-app", "--from-export", bundlePath, "--force"], tmp)
    expect(
      await newCommand(blockedCtx.ctx, { loadSelfHostExportApi: async () => blockedApi }),
    ).toBe(1)
    expect(readFileSync(join(target, "stale.txt"), "utf8")).toBe("keep until ready\n")

    const readyApi = successfulApi().api
    const readyCtx = makeCtx(["my-app", "--from-export", bundlePath, "--force"], tmp)
    expect(await newCommand(readyCtx.ctx, { loadSelfHostExportApi: async () => readyApi })).toBe(0)
    expect(existsSync(join(target, "stale.txt"))).toBe(false)
    expect(existsSync(join(target, "package.json"))).toBe(true)
  })
})
