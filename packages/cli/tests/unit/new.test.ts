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

/** Build a minimal fake template directory under `root`. */
function seedTemplate(root: string) {
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

  it("fails when the requested template cannot be found", async () => {
    const { ctx, stderr } = makeCtx(["my-app", "--template", "missing-template"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Could not find a template")
  })

  it("rejects the retired dmc template alias", async () => {
    const { ctx, stderr } = makeCtx(["my-app", "--template", "dmc"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Could not find a template")
  })

  it("fails when target already exists without --force", async () => {
    seedTemplate(join(tmp, "templates", "operator"))
    mkdirSync(join(tmp, "my-app"))
    const { ctx, stderr } = makeCtx(["my-app"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("already exists")
  })

  it("overwrites the target when --force is set", async () => {
    seedTemplate(join(tmp, "templates", "operator"))
    mkdirSync(join(tmp, "my-app"))
    writeFileSync(join(tmp, "my-app", "stale.txt"), "old\n")
    const { ctx, stdout } = makeCtx(["my-app", "--force"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("Created my-app")
    expect(existsSync(join(tmp, "my-app", "stale.txt"))).toBe(true) // merge, not wipe
    expect(existsSync(join(tmp, "my-app", "src", "entry.ts"))).toBe(true)
  })

  it("scaffolds a new project from templates/operator", async () => {
    seedTemplate(join(tmp, "templates", "operator"))
    const { ctx, stdout } = makeCtx(["my-app"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(0)
    const out = stdout.join("")
    expect(out).toContain("Created my-app")
    expect(out).toContain("Next steps:")
    expect(existsSync(join(tmp, "my-app", "package.json"))).toBe(true)
    expect(existsSync(join(tmp, "my-app", "src", "entry.ts"))).toBe(true)
  })

  it("rewrites package.json name + version + private", async () => {
    seedTemplate(join(tmp, "templates", "operator"))
    const { ctx } = makeCtx(["my-app"], tmp)
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
    seedTemplate(join(tmp, "templates", "operator"))
    const { ctx } = makeCtx(["my-app"], tmp)
    await newCommand(ctx)
    expect(existsSync(join(tmp, "my-app", "node_modules"))).toBe(false)
    expect(existsSync(join(tmp, "my-app", "dist"))).toBe(false)
    expect(existsSync(join(tmp, "my-app", ".turbo"))).toBe(false)
    expect(existsSync(join(tmp, "my-app", ".env"))).toBe(false)
    expect(existsSync(join(tmp, "my-app", ".dev.vars"))).toBe(false)
  })

  it("writes a default voyant.config.ts when the template lacks one", async () => {
    seedTemplate(join(tmp, "templates", "operator"))
    const { ctx } = makeCtx(["my-app"], tmp)
    await newCommand(ctx)
    const cfg = readFileSync(join(tmp, "my-app", "voyant.config.ts"), "utf8")
    expect(cfg).toContain("defineVoyantConfig")
    expect(cfg).toContain('deployment: "cloudflare-worker"')
  })

  it("preserves an existing voyant.config.ts from the template", async () => {
    const templateRoot = join(tmp, "templates", "operator")
    seedTemplate(templateRoot)
    writeFileSync(join(templateRoot, "voyant.config.ts"), "// pre-existing config\n")
    const { ctx } = makeCtx(["my-app"], tmp)
    await newCommand(ctx)
    const cfg = readFileSync(join(tmp, "my-app", "voyant.config.ts"), "utf8")
    expect(cfg).toBe("// pre-existing config\n")
  })

  it("honors --template with an explicit path", async () => {
    const customTemplate = join(tmp, "my-template")
    seedTemplate(customTemplate)
    const { ctx } = makeCtx(["my-app", "--template", customTemplate], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(0)
    expect(existsSync(join(tmp, "my-app", "src", "entry.ts"))).toBe(true)
  })

  it("honors --template with a starter alias", async () => {
    seedTemplate(join(tmp, "templates", "operator"))
    const { ctx } = makeCtx(["my-app", "--template", "operator"], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(0)
    expect(existsSync(join(tmp, "my-app", "src", "entry.ts"))).toBe(true)
  })

  it("rewrites monorepo drizzle config into a standalone schema entrypoint", async () => {
    seedTemplate(join(tmp, "templates", "operator"))
    const { ctx } = makeCtx(["my-app"], tmp)
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
    seedTemplate(starterRoot)

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
    const { ctx } = makeCtx(["my-app", "--template", "operator"], workspace)
    const code = await newCommand(ctx)
    expect(code).toBe(0)
    expect(existsSync(join(workspace, "my-app", "src", "entry.ts"))).toBe(true)
    expect(existsSync(join(workspace, "my-app", ".env"))).toBe(false)
  })

  it("fails when --template points at a missing directory", async () => {
    const { ctx, stderr } = makeCtx(["my-app", "--template", join(tmp, "nope")], tmp)
    const code = await newCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Could not find a template")
  })
})
