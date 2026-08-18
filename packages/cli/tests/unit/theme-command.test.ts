import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createJiti } from "jiti"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ASTRO_CLOUDFLARE_SCAFFOLD_VERSION,
  ASTRO_SCAFFOLD_VERSION,
  CLI_SCAFFOLD_VERSION_RANGE,
  scaffoldTheme,
  THEME_ASTRO_SCAFFOLD_VERSION,
  THEME_SDK_SCAFFOLD_VERSION,
  themeCommand,
} from "../../src/commands/theme.js"
import { main } from "../../src/index.js"
import { loadThemeTooling } from "../../src/lib/theme-tooling.js"

const FIXTURE = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "fixtures/mock-theme-tooling",
)

describe("voyant theme", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voyant-theme-command-"))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("dispatches the nested command from the CLI entry point", async () => {
    const run = io(root)
    expect(await main(["theme", "--help"], run.options)).toBe(0)
    expect(run.stdout.join("")).toContain("voyant theme init")
  })

  it("passes the project root and config to the pinned validator", async () => {
    const validateTheme = vi.fn(async () => validReport())
    const run = io(root, ["check", "--config", "custom.theme.ts"])

    expect(await themeCommand(run.ctx, { loadTooling: async () => ({ validateTheme }) })).toBe(0)
    expect(validateTheme).toHaveBeenCalledWith({
      projectRoot: root,
      configFile: "custom.theme.ts",
    })
    expect(run.stdout.join("")).toContain("voyant theme check: ok")
  })

  it("preserves the SDK report in JSON mode and exits non-zero when invalid", async () => {
    const report = {
      schemaVersion: "voyant.theme.tooling.v1" as const,
      ok: false,
      configPath: join(root, "theme.config.ts"),
      diagnostics: [
        {
          code: "THEME_ROUTE_MISSING",
          severity: "error" as const,
          message: "Declare the home route.",
          path: "routes.home",
          source: { file: "theme.config.ts", path: ["manifest", "routes", 0] },
        },
      ],
    }
    const run = io(root, ["check", "--json"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ validateTheme: async () => report }),
      }),
    ).toBe(1)
    expect(JSON.parse(run.stdout.join(""))).toEqual(report)
    expect(run.stderr).toEqual([])
  })

  it("renders SDK diagnostics as actionable human output", async () => {
    const run = io(root, ["build"])
    const report = {
      ...validReport(),
      ok: false,
      diagnostics: [
        {
          code: "THEME_MANIFEST_INVALID",
          severity: "error" as const,
          message: "Expected a theme name.",
          path: "name",
          source: { file: "theme.config.ts", path: ["manifest", "name"] },
        },
      ],
    }

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ buildTheme: async () => report }),
      }),
    ).toBe(1)
    expect(run.stderr.join("")).toContain(
      "ERROR THEME_MANIFEST_INVALID name: Expected a theme name. (theme.config.ts)",
    )
  })

  it("keeps SDK subprocess stdout silent for a JSON build report", async () => {
    const buildTheme = vi.fn(async () => validReport())
    const run = io(root, ["build", "--json"])

    expect(await themeCommand(run.ctx, { loadTooling: async () => ({ buildTheme }) })).toBe(0)
    expect(buildTheme).toHaveBeenCalledWith({
      projectRoot: root,
      configFile: undefined,
      output: "silent",
    })
    expect(JSON.parse(run.stdout.join(""))).toEqual(validReport())
  })

  it("suppresses project tooling import and config stdout while framing a JSON report", async () => {
    const run = io(root, ["check", "--json"])
    const validateTheme = vi.fn(async () => {
      process.stdout.write("config noise\n")
      return validReport()
    })
    const loadTooling = vi.fn(async () => {
      process.stdout.write("module import noise\n")
      return { validateTheme }
    })

    expect(await themeCommand(run.ctx, { loadTooling })).toBe(0)
    expect(run.stdout).toEqual([`${JSON.stringify(validReport(), null, 2)}\n`])
  })

  it("rejects an incompatible tooling report at runtime", async () => {
    const run = io(root, ["check", "--json"])
    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({
          validateTheme: async () => ({ ok: true }) as never,
        }),
      }),
    ).toBe(1)
    expect(JSON.parse(run.stderr.join("")).error).toMatchObject({
      code: "theme_check_failed",
      message: expect.stringContaining("invalid check report"),
    })
  })

  it("starts and closes the SDK development handle", async () => {
    const close = vi.fn(async () => {})
    const wait = vi.fn(() => new Promise<number>(() => {}))
    const developTheme = vi.fn(async () => ({ url: "http://localhost:4455", close, wait }))
    const waitForShutdown = vi.fn(async (cleanup: () => Promise<void>) => cleanup())
    const run = io(root, ["dev", "--host", "0.0.0.0", "--port", "4455"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ developTheme }),
        waitForShutdown,
      }),
    ).toBe(0)
    expect(developTheme).toHaveBeenCalledWith({
      projectRoot: root,
      configFile: undefined,
      host: "0.0.0.0",
      port: 4455,
    })
    expect(close).toHaveBeenCalledOnce()
    expect(run.stderr.join("")).toContain("http://localhost:4455")
  })

  it("returns when the development server exits before a signal", async () => {
    const close = vi.fn(async () => {})
    const waitForShutdown = vi.fn(() => new Promise<void>(() => {}))
    const run = io(root, ["dev"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({
          developTheme: async () => ({
            url: "http://localhost:4321",
            close,
            wait: async () => 0,
          }),
        }),
        waitForShutdown,
      }),
    ).toBe(0)
    expect(close).toHaveBeenCalledOnce()
  })

  it("propagates an early non-zero development server exit", async () => {
    const close = vi.fn(async () => {})
    const run = io(root, ["dev"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({
          developTheme: async () => ({
            url: "http://localhost:4321",
            close,
            wait: async () => 7,
          }),
        }),
        waitForShutdown: () => new Promise<void>(() => {}),
      }),
    ).toBe(7)
    expect(close).toHaveBeenCalledOnce()
    expect(run.stderr.join("")).toContain("exited with code 7")
  })

  it("prints structured SDK diagnostics when development cannot start", async () => {
    const error = Object.assign(new Error("Cannot start an invalid theme."), {
      diagnostics: [
        {
          code: "THEME_CONFIG_NOT_FOUND",
          severity: "error" as const,
          message: "Theme config was not found.",
          path: "$",
        },
      ],
    })
    const run = io(root, ["dev"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ developTheme: async () => Promise.reject(error) }),
      }),
    ).toBe(1)
    expect(run.stderr.join("")).toContain(
      "ERROR THEME_CONFIG_NOT_FOUND $: Theme config was not found.",
    )
  })

  it("scaffolds a tour-capable Astro theme and refuses a non-empty target", async () => {
    const target = join(root, "Example Theme")
    const result = await scaffoldTheme(target)

    expect(result).toMatchObject({
      schemaVersion: "voyant.theme.init.v1",
      ok: true,
      name: "example-theme",
    })
    expect(JSON.parse(readFileSync(join(target, "package.json"), "utf8"))).toMatchObject({
      engines: { node: ">=22.12.0" },
      dependencies: {
        "@voyant-travel/theme": THEME_SDK_SCAFFOLD_VERSION,
        "@voyant-travel/astro": THEME_ASTRO_SCAFFOLD_VERSION,
        "@astrojs/cloudflare": ASTRO_CLOUDFLARE_SCAFFOLD_VERSION,
        astro: ASTRO_SCAFFOLD_VERSION,
      },
      devDependencies: { "@voyant-travel/cli": CLI_SCAFFOLD_VERSION_RANGE },
    })
    expect(THEME_SDK_SCAFFOLD_VERSION).toBe("0.1.0-alpha.14")
    expect(THEME_ASTRO_SCAFFOLD_VERSION).toBe("0.1.0-alpha.13")
    const config = readFileSync(join(target, "theme.config.ts"), "utf8")
    expect(config).toContain("defineTheme")
    expect(config).toContain('context: "home"')
    expect(config).toContain('{ id: "content", pattern: "/journal/[...path]", context: "content" }')
    expect(config).toContain('context: "notFound"')
    expect(config).toContain('contractVersion: "v1alpha4"')
    expect(config).toContain('context: "tourIndex"')
    expect(config).toContain('context: "tourDetail"')
    expect(config).toContain('{ id: "catalog.pricing.v1" }')
    expect(config).toContain('{ id: "booking.session.v1" }')
    expect(config).toContain('kind: "home"')
    expect(config).toContain('kind: "content"')
    expect(config).toContain('kind: "notFound"')
    expect(config).toContain('kind: "tourIndex"')
    expect(config).toContain('kind: "tourDetail"')
    expect(readFileSync(join(target, "astro.config.mjs"), "utf8")).toContain(
      "voyantTheme({ theme })",
    )
    const page = readFileSync(join(target, "src/pages/[...path].astro"), "utf8")
    expect(page).toContain("resolveThemeContext(Astro.url)")
    expect(page).toContain('context.kind === "tourIndex"')
    expect(page).toContain('context.kind === "tourDetail"')
    expect(page).toContain('context.kind === "notFound"')
    expect(readFileSync(join(target, "src/env.d.ts"), "utf8")).toContain(
      "@voyant-travel/astro/virtual",
    )
    expect(readFileSync(join(target, "wrangler.jsonc"), "utf8")).toContain(
      '"main": "@astrojs/cloudflare/entrypoints/server"',
    )

    const fixturePackage = join(target, "node_modules/@voyant-travel/theme")
    cpSync(FIXTURE, fixturePackage, { recursive: true })
    const loader = createJiti(join(target, "package.json"), {
      interopDefault: false,
      moduleCache: false,
    })
    const loaded = (await loader.import(join(target, "theme.config.ts"))) as {
      default: unknown
    }
    const fixtureSdk = (await loader.import("@voyant-travel/theme")) as {
      checkThemeDefinition(theme: unknown): { ok: boolean; diagnostics: unknown[] }
    }
    expect(fixtureSdk.checkThemeDefinition(loaded.default)).toEqual({ ok: true, diagnostics: [] })
    const invalidTheme = structuredClone(loaded.default) as {
      manifest: { routes: Array<{ context: string; pattern: string }> }
    }
    const contentRoute = invalidTheme.manifest.routes.find((route) => route.context === "content")
    if (contentRoute) contentRoute.pattern = "/:slug"
    expect(fixtureSdk.checkThemeDefinition(invalidTheme).ok).toBe(false)
    await expect(scaffoldTheme(target)).rejects.toThrow("non-empty directory")

    const numericTarget = join(root, "123_theme")
    expect((await scaffoldTheme(numericTarget)).name).toBe("theme-123-theme")
  })

  it("resolves the tooling export from the project dependency", async () => {
    const packageDirectory = join(root, "node_modules/@voyant-travel/theme")
    cpSync(FIXTURE, packageDirectory, { recursive: true })
    const tooling = await loadThemeTooling(root)

    expect(typeof tooling.validateTheme).toBe("function")
    expect(await tooling.validateTheme?.({ projectRoot: root })).toMatchObject({
      schemaVersion: "voyant.theme.tooling.v1",
      ok: true,
    })
  })

  it("validates and writes an injected remote Theme Project Link", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    const validateTheme = vi.fn(async () => validReport())
    const validate = vi.fn(async () => ({
      schemaVersion: "voyant.theme-project-link.v1" as const,
      apiUrl: "https://sandbox.onvoyant.com",
      organizationId: "org_123",
      themeId: "thm_123",
      siteId: "site_123",
      installationId: "thi_123",
    }))
    const run = io(root, [
      "link",
      "--theme",
      "thm_123",
      "--site",
      "site_123",
      "--installation",
      "thi_123",
      "--api-url",
      "https://sandbox.onvoyant.com",
      "--org",
      "org_123",
      "--json",
    ])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ validateTheme }),
        validateLink: { validate },
      }),
    ).toBe(0)
    expect(validateTheme).toHaveBeenCalledWith({
      projectRoot: root,
      configFile: join(root, "theme.config.ts"),
    })
    expect(validate).toHaveBeenCalledWith({
      project: {
        projectRoot: root,
        configPath: join(root, "theme.config.ts"),
        linkPath: join(root, ".voyant", "theme-project-link.json"),
      },
      selectors: {
        theme: "thm_123",
        site: "site_123",
        installation: "thi_123",
        apiUrl: "https://sandbox.onvoyant.com",
        organization: "org_123",
      },
    })
    expect(JSON.parse(run.stdout.join(""))).toMatchObject({
      schemaVersion: "voyant.theme-link-result.v1",
      link: { themeId: "thm_123", siteId: "site_123" },
    })
    expect(readFileSync(join(root, ".voyant", "theme-project-link.json"), "utf8")).not.toContain(
      "token",
    )
  })

  it("does not write a link when the default remote Adapter is unavailable", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    const run = io(root, ["link", "--theme", "thm_123", "--json"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ validateTheme: async () => validReport() }),
      }),
    ).toBe(1)
    expect(JSON.parse(run.stderr.join(""))).toMatchObject({
      error: { code: "theme_link_validation_unavailable" },
    })
    expect(existsSync(join(root, ".voyant", "theme-project-link.json"))).toBe(false)
  })

  it("requires explicit selectors deterministically when no local link exists", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    const run = io(root, ["link", "--json"])

    expect(await themeCommand(run.ctx)).toBe(1)
    expect(JSON.parse(run.stderr.join(""))).toMatchObject({
      error: { code: "theme_selector_required" },
    })
  })

  it("reports status without remote validation or credentials", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    mkdirSync(join(root, ".voyant"), { recursive: true })
    writeFileSync(
      join(root, ".voyant", "theme-project-link.json"),
      `${JSON.stringify({
        schemaVersion: "voyant.theme-project-link.v1",
        apiUrl: "https://api.voyant.travel",
        organizationId: "org_123",
        themeId: "thm_123",
      })}\n`,
    )
    const run = io(root, ["status", "--json"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ validateTheme: async () => validReport() }),
      }),
    ).toBe(0)
    expect(JSON.parse(run.stdout.join(""))).toMatchObject({
      schemaVersion: "voyant.theme-status.v1",
      linked: true,
      link: { themeId: "thm_123" },
      local: { valid: true },
      remoteValidation: "not_checked",
    })
    expect(run.stdout.join("")).not.toContain("token")
  })

  it("unlinks locally without loading tooling or invoking remote validation", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    mkdirSync(join(root, ".voyant"), { recursive: true })
    writeFileSync(
      join(root, ".voyant", "theme-project-link.json"),
      `${JSON.stringify({
        schemaVersion: "voyant.theme-project-link.v1",
        apiUrl: "https://api.voyant.travel",
        organizationId: "org_123",
        themeId: "thm_123",
      })}\n`,
    )
    const run = io(root, ["unlink", "--json"])

    expect(await themeCommand(run.ctx)).toBe(0)
    expect(JSON.parse(run.stdout.join(""))).toMatchObject({ removed: true })
    expect(existsSync(join(root, ".voyant", "theme-project-link.json"))).toBe(false)
  })
})

function validReport() {
  return {
    schemaVersion: "voyant.theme.tooling.v1" as const,
    ok: true,
    diagnostics: [],
  }
}

function io(cwd: string, argv: string[] = []) {
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
    options: {
      cwd,
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
  }
}
