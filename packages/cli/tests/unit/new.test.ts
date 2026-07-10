import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { c } from "tar"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { newCommand } from "../../src/commands/new.js"

import { VOYANT_FRAMEWORK_VERSION } from "../../src/lib/voyant-version.js"

const expectedVoyantVersionRange = `^${VOYANT_FRAMEWORK_VERSION}`

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

/** Build a minimal fake starter directory under `root`. */
function seedStarter(root: string) {
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "template-operator",
        version: "1.2.3",
        dependencies: {
          "@voyant-travel/core": "workspace:*",
          "@voyant-travel/db": "workspace:*",
        },
        devDependencies: {
          "@voyant-travel/voyant-typescript-config": "workspace:*",
        },
      },
      null,
      2,
    ),
  )
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "entry.ts"), "// entry\n")
  writeFileSync(
    join(root, "drizzle.config.ts"),
    `export default {
  schema: [
    "../../packages/db/src/schema/index.ts",
    "../../packages/crm/src/schema.ts",
    "../../packages/bookings/src/schema.ts",
    "../../packages/products/src/schema.ts",
    "../../packages/legal/src/schema.ts",
  ],
}
`,
  )
  writeFileSync(join(root, ".env"), "SECRET=1\n")
  writeFileSync(join(root, ".dev.vars"), "SECRET=1\n")

  // These should be filtered out.
  mkdirSync(join(root, "node_modules", "foo"), { recursive: true })
  writeFileSync(join(root, "node_modules", "foo", "x.js"), "// skip\n")
  mkdirSync(join(root, "dist"), { recursive: true })
  writeFileSync(join(root, "dist", "bundle.js"), "// skip\n")
  mkdirSync(join(root, ".turbo"), { recursive: true })
  writeFileSync(join(root, ".turbo", "log.txt"), "skip\n")
}

function seedWorkspacePackage(
  workspaceRoot: string,
  relDir: string,
  name: string,
  version: string,
) {
  const dir = join(workspaceRoot, relDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }, null, 2))
}

describe("newCommand", () => {
  let tmp: string
  let previousFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-new-"))
    previousFetch = globalThis.fetch
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    if (previousFetch === undefined) {
      globalThis.fetch = undefined as unknown as typeof globalThis.fetch
    } else {
      globalThis.fetch = previousFetch
    }
  })

  it("fails without a project name", async () => {
    const { ctx, stderr } = makeCtx([], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Usage: voyant new <name>")
  })

  it("rejects invalid project names", async () => {
    const { ctx, stderr } = makeCtx(["../escape"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Invalid project name")
  })

  it("fails when the requested starter cannot be found", async () => {
    const { ctx, stderr } = makeCtx(["my-app", "--starter", "missing-starter"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Could not find a starter")
  })

  it("rejects the retired dmc starter alias", async () => {
    const { ctx, stderr } = makeCtx(["my-app", "--starter", "dmc"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Could not find a starter")
  })

  it("fails when target already exists without --force", async () => {
    seedStarter(join(tmp, "starters", "operator"))
    mkdirSync(join(tmp, "my-app"))
    const { ctx, stderr } = makeCtx(["my-app"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("already exists")
  })

  it("overwrites the target when --force is set", async () => {
    seedStarter(join(tmp, "starters", "operator"))
    mkdirSync(join(tmp, "my-app"))
    writeFileSync(join(tmp, "my-app", "stale.txt"), "old\n")
    const { ctx, stdout } = makeCtx(["my-app", "--starter", "operator", "--force"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("Created my-app")
    expect(existsSync(join(tmp, "my-app", "stale.txt"))).toBe(true) // merge, not wipe
    expect(existsSync(join(tmp, "my-app", "src", "entry.ts"))).toBe(true)
  })

  it("expands the operator-standard preset into an explicit clean project", async () => {
    const { ctx, stdout } = makeCtx(["my-app", "--preset", "operator-standard"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(0)
    const out = stdout.join("")
    expect(out).toContain("Created my-app")
    expect(out).toContain("Next steps:")
    expect(existsSync(join(tmp, "my-app", "package.json"))).toBe(true)
    expect(existsSync(join(tmp, "my-app", "src", "modules", ".gitkeep"))).toBe(true)
    expect(existsSync(join(tmp, "my-app", "src", "plugins", ".gitkeep"))).toBe(true)
    expect(existsSync(join(tmp, "my-app", "src", "entry.ts"))).toBe(false)

    const pkg = JSON.parse(readFileSync(join(tmp, "my-app", "package.json"), "utf8"))
    expect(pkg.devDependencies["@voyant-travel/cli"]).toMatch(/^\^\d+\.\d+\.\d+/)

    const config = readFileSync(join(tmp, "my-app", "voyant.config.ts"), "utf8")
    expect(config).toContain('from "@voyant-travel/framework/project"')
    expect(config).toContain('"presetLineage": "operator-standard"')
    expect(config).toContain('"@voyant-travel/bookings"')
    expect(config).toContain('"@voyant-travel/finance/booking-tax-extension"')
    expect(readFileSync(join(tmp, "my-app", ".gitignore"), "utf8")).toContain(".voyant/")
  })

  it("uses operator-standard when no preset or starter is given", async () => {
    const { ctx } = makeCtx(["my-app"], tmp)
    expect(await newCommand(ctx)).toBe(0)
    expect(readFileSync(join(tmp, "my-app", "voyant.config.ts"), "utf8")).toContain(
      '"presetLineage": "operator-standard"',
    )
  })

  it("resolves the operator starter from a sibling Voyant checkout and composes local package versions", async () => {
    const workspaceRoot = join(tmp, "voyant-all", "voyant")
    const cliRoot = join(tmp, "voyant-all", "cli")
    mkdirSync(workspaceRoot, { recursive: true })
    mkdirSync(cliRoot, { recursive: true })
    writeFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n')
    seedStarter(join(workspaceRoot, "starters", "operator"))
    seedWorkspacePackage(workspaceRoot, "packages/core", "@voyant-travel/core", "1.1.0")
    seedWorkspacePackage(workspaceRoot, "packages/db", "@voyant-travel/db", "1.2.0")
    seedWorkspacePackage(workspaceRoot, "packages/crm", "@voyant-travel/crm", "1.3.0")
    seedWorkspacePackage(workspaceRoot, "packages/bookings", "@voyant-travel/bookings", "1.4.0")
    seedWorkspacePackage(workspaceRoot, "packages/legal", "@voyant-travel/legal", "1.5.0")
    seedWorkspacePackage(
      workspaceRoot,
      "packages/typescript-config",
      "@voyant-travel/voyant-typescript-config",
      "1.6.0",
    )

    const { ctx } = makeCtx(["my-app", "--starter", "operator"], cliRoot)
    const code = await newCommand(ctx)

    expect(code).toBe(0)
    expect(existsSync(join(cliRoot, "my-app", "src", "entry.ts"))).toBe(true)
    const pkg = JSON.parse(readFileSync(join(cliRoot, "my-app", "package.json"), "utf8"))
    expect(pkg.dependencies["@voyant-travel/core"]).toBe("^1.1.0")
    expect(pkg.dependencies["@voyant-travel/db"]).toBe("^1.2.0")
    expect(pkg.dependencies["@voyant-travel/crm"]).toBe("^1.3.0")
    expect(pkg.dependencies["@voyant-travel/bookings"]).toBe("^1.4.0")
    expect(pkg.dependencies["@voyant-travel/legal"]).toBe("^1.5.0")
    expect(pkg.devDependencies["@voyant-travel/voyant-typescript-config"]).toBe("^1.6.0")
  })

  it("rewrites package.json name + version + private", async () => {
    seedStarter(join(tmp, "starters", "operator"))
    const { ctx } = makeCtx(["my-app", "--starter", "operator"], tmp)
    await newCommand(ctx)
    const pkg = JSON.parse(readFileSync(join(tmp, "my-app", "package.json"), "utf8"))
    expect(pkg.name).toBe("my-app")
    expect(pkg.version).toBe("0.0.1")
    expect(pkg.private).toBe(true)
    expect(pkg.dependencies["@voyant-travel/core"]).toBe(expectedVoyantVersionRange)
    expect(pkg.dependencies["@voyant-travel/crm"]).toBe(expectedVoyantVersionRange)
    expect(pkg.dependencies["@voyant-travel/legal"]).toBe(expectedVoyantVersionRange)
    expect(pkg.devDependencies["@voyant-travel/voyant-typescript-config"]).toBe(
      expectedVoyantVersionRange,
    )
  })

  it("skips node_modules, dist, .turbo, and secret env files when copying", async () => {
    seedStarter(join(tmp, "starters", "operator"))
    const { ctx } = makeCtx(["my-app", "--starter", "operator"], tmp)
    await newCommand(ctx)
    expect(existsSync(join(tmp, "my-app", "node_modules"))).toBe(false)
    expect(existsSync(join(tmp, "my-app", "dist"))).toBe(false)
    expect(existsSync(join(tmp, "my-app", ".turbo"))).toBe(false)
    expect(existsSync(join(tmp, "my-app", ".env"))).toBe(false)
    expect(existsSync(join(tmp, "my-app", ".dev.vars"))).toBe(false)
  })

  it("writes a default voyant.config.ts when the starter lacks one", async () => {
    seedStarter(join(tmp, "starters", "operator"))
    const { ctx } = makeCtx(["my-app", "--starter", "operator"], tmp)
    await newCommand(ctx)
    const cfg = readFileSync(join(tmp, "my-app", "voyant.config.ts"), "utf8")
    expect(cfg).toContain("defineVoyantConfig")
    expect(cfg).toContain('deployment: "cloudflare-worker"')
  })

  it("preserves an existing voyant.config.ts from the starter", async () => {
    const starterRoot = join(tmp, "starters", "operator")
    seedStarter(starterRoot)
    writeFileSync(join(starterRoot, "voyant.config.ts"), "// pre-existing config\n")
    const { ctx } = makeCtx(["my-app", "--starter", "operator"], tmp)
    await newCommand(ctx)
    const cfg = readFileSync(join(tmp, "my-app", "voyant.config.ts"), "utf8")
    expect(cfg).toBe("// pre-existing config\n")
  })

  it("honors --starter with an explicit path", async () => {
    const customStarter = join(tmp, "my-starter")
    seedStarter(customStarter)
    const { ctx } = makeCtx(["my-app", "--starter", customStarter], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(0)
    expect(existsSync(join(tmp, "my-app", "src", "entry.ts"))).toBe(true)
  })

  it("honors --starter with a built-in starter alias", async () => {
    seedStarter(join(tmp, "starters", "operator"))
    const { ctx } = makeCtx(["my-app", "--starter", "operator"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(0)
    expect(existsSync(join(tmp, "my-app", "src", "entry.ts"))).toBe(true)
  })

  it("rejects --template for new projects", async () => {
    seedStarter(join(tmp, "starters", "operator"))
    const { ctx, stderr } = makeCtx(["my-app", "--template", "operator"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Unknown option for voyant new: --template")
  })

  it("rejects unknown presets", async () => {
    const { ctx, stderr } = makeCtx(["my-app", "--preset", "pms-standard"], tmp)
    expect(await newCommand(ctx)).toBe(1)
    expect(stderr.join("")).toContain("Unknown preset: pms-standard")
  })

  it("rejects combining a preset and starter", async () => {
    const { ctx, stderr } = makeCtx(
      ["my-app", "--preset", "operator-standard", "--starter", "operator"],
      tmp,
    )
    expect(await newCommand(ctx)).toBe(1)
    expect(stderr.join("")).toContain("cannot be used together")
  })

  it("rewrites monorepo drizzle config into a standalone schema entrypoint", async () => {
    seedStarter(join(tmp, "starters", "operator"))
    const { ctx } = makeCtx(["my-app", "--starter", "operator"], tmp)
    await newCommand(ctx)
    const drizzle = readFileSync(join(tmp, "my-app", "drizzle.config.ts"), "utf8")
    const schema = readFileSync(join(tmp, "my-app", "src", "db", "voyant-schema.ts"), "utf8")
    expect(drizzle).toContain('schema: "./src/db/voyant-schema.ts"')
    expect(schema).toContain('export * from "@voyant-travel/db/schema"')
    expect(schema).toContain('export * from "@voyant-travel/bookings/schema"')
    expect(schema).toContain('export * from "@voyant-travel/legal/schema"')
  })

  it("downloads a built-in starter from a versioned release tarball", async () => {
    const starterRoot = join(tmp, "remote-starter")
    seedStarter(starterRoot)

    const archivePath = join(tmp, `voyant-starter-operator-${VOYANT_FRAMEWORK_VERSION}.tar.gz`)
    await c(
      {
        cwd: starterRoot,
        file: archivePath,
        gzip: true,
      },
      ["."],
    )

    const archive = readFileSync(archivePath)
    globalThis.fetch = async (input) => {
      expect(String(input)).toContain(
        `/v${VOYANT_FRAMEWORK_VERSION}/voyant-starter-operator-${VOYANT_FRAMEWORK_VERSION}.tar.gz`,
      )
      return new Response(archive, {
        status: 200,
        headers: { "content-type": "application/gzip" },
      })
    }

    const workspace = join(tmp, "workspace")
    mkdirSync(workspace, { recursive: true })
    const { ctx } = makeCtx(["my-app", "--starter", "operator"], workspace)
    const code = await newCommand(ctx)
    expect(code).toBe(0)
    expect(existsSync(join(workspace, "my-app", "src", "entry.ts"))).toBe(true)
    expect(existsSync(join(workspace, "my-app", ".env"))).toBe(false)
  })

  it("fails when --starter points at a missing directory", async () => {
    const { ctx, stderr } = makeCtx(["my-app", "--starter", join(tmp, "nope")], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Could not find a starter")
  })
})
