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
import { themeManifestDigest } from "../../src/lib/theme-platform.js"
import { loadThemeTooling, type ThemeToolingReport } from "../../src/lib/theme-tooling.js"

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
    const run = io(root, ["dev", "--local", "--host", "0.0.0.0", "--port", "4455"])

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
    const run = io(root, ["dev", "--local"])

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
    const run = io(root, ["dev", "--local"])

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
    const run = io(root, ["dev", "--local"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ developTheme: async () => Promise.reject(error) }),
      }),
    ).toBe(1)
    expect(run.stderr.join("")).toContain(
      "ERROR THEME_CONFIG_NOT_FOUND $: Theme config was not found.",
    )
  })

  it("starts connected development with canonical remote data and revokes on exit", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    writeLinkedProject(root)
    const capability = "vyd_abcdefghijklmnopqrstuvwxyz234567"
    const revokeSession = vi.fn(async () => {})
    const replaceSessionManifest = vi.fn()
    const closeWatcher = vi.fn(async () => {})
    const resolveTarget = vi.fn(async (input) => ({
      schemaVersion: "voyant.theme-project-link.v1" as const,
      apiUrl: "https://sandbox.onvoyant.com",
      organizationId: "org_canonical",
      themeId: input.selectors.theme === "theme_override" ? "thm_override" : "thm_canonical",
      siteId: "site_canonical",
      installationId: "thi_canonical",
    }))
    const createSession = vi.fn(async (input) => ({
      sessionToken: capability,
      runtime: runtimeDescriptor({
        themeId: input.themeId,
        siteId: input.siteId,
        installationId: input.installationId,
        manifestDigest: input.manifestDigest,
      }),
    }))
    const handoffUrl = `https://sandbox.onvoyant.com/dash/theme-development/connect#code=vye_${"a".repeat(52)}`
    const createEditorHandoff = vi.fn(async () => ({
      handoffUrl,
      expiresAt: "2026-08-19T12:05:00.000Z",
    }))
    const childEnvironment: Record<string, string> = {}
    const developTheme = vi.fn(async (options) => {
      const prepared = await options.runtime?.adapter.prepare({
        descriptor: options.runtime.descriptor,
        projectRoot: options.projectRoot,
      })
      Object.assign(childEnvironment, prepared?.childEnvironment)
      return {
        url: "http://127.0.0.1:4545",
        wait: () => new Promise<number>(() => {}),
        reload: async () => {},
        close: async () => prepared?.dispose?.(),
      }
    })
    const run = io(root, [
      "dev",
      "--theme",
      "theme_override",
      "--site",
      "site_override",
      "--installation",
      "install_override",
      "--port",
      "4545",
    ])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({
          validateTheme: async () => validReport(),
          parseThemeDevelopmentRuntimeDescriptor: (value) => value,
          developTheme,
          watchThemeProject: async () => ({ close: closeWatcher }),
        }),
        createPlatformAdapter: () => ({
          listTargets: async () => ({ organizationId: "org_canonical", themes: [], sites: [] }),
          resolveTarget,
          createSession,
          createEditorHandoff,
          replaceSessionManifest,
          revokeSession,
        }),
        waitForShutdown: async (cleanup) => cleanup(),
      }),
    ).toBe(0)

    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        selectors: expect.objectContaining({
          theme: "theme_override",
          site: "site_override",
          installation: "install_override",
        }),
        contractVersion: "v1",
      }),
    )
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        themeId: "thm_override",
        siteId: "site_canonical",
        installationId: "thi_canonical",
        localOrigin: "http://127.0.0.1:4545",
        contractVersion: "v1",
      }),
    )
    expect(childEnvironment).toEqual({ VOYANT_THEME_DEVELOPMENT_CAPABILITY: capability })
    expect(revokeSession).toHaveBeenCalledOnce()
    expect(revokeSession).toHaveBeenCalledWith("tds_session")
    expect(createEditorHandoff).toHaveBeenCalledWith("tds_session", { expiresInSeconds: 300 })
    expect(run.stdout.join("")).toContain(handoffUrl)
    expect(run.stderr.join("")).not.toContain(handoffUrl)
    expect(closeWatcher).toHaveBeenCalledOnce()
    expect(run.stdout.join("") + run.stderr.join("")).not.toContain(capability)
    expect(readFileSync(join(root, ".voyant", "theme-project-link.json"), "utf8")).not.toContain(
      capability,
    )
    expect(JSON.stringify(developTheme.mock.calls)).not.toContain(capability)
  })

  it("keeps an invalid edit remote-only and CAS-updates then reloads on the next valid edit", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    writeLinkedProject(root)
    const capability = "vyd_never_print_this_capability"
    let onReport: ((report: ThemeToolingReport) => Promise<void>) | undefined
    const reload = vi.fn(async () => {})
    const replaceSessionManifest = vi.fn(async (_sessionId, input) =>
      runtimeDescriptor({
        themeId: "thm_canonical",
        siteId: "site_canonical",
        installationId: "thi_canonical",
        manifestDigest: input.manifestDigest,
      }),
    )
    const changed = {
      ...validReport(),
      theme: {
        contractVersion: "v1",
        manifest: { id: "fixture-theme", version: "0.2.0" },
      },
    }
    const run = io(root, ["dev"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({
          validateTheme: async () => validReport(),
          parseThemeDevelopmentRuntimeDescriptor: (value) => value,
          developTheme: async () => ({
            url: "http://127.0.0.1:4321",
            wait: () => new Promise<number>(() => {}),
            reload,
            close: async () => {},
          }),
          watchThemeProject: async (_options, callback) => {
            onReport = callback as typeof onReport
            return { close: async () => {} }
          },
        }),
        createPlatformAdapter: () => ({
          listTargets: async () => ({ organizationId: "org_canonical", themes: [], sites: [] }),
          resolveTarget: async () => canonicalLink(),
          createSession: async (input) => ({
            sessionToken: capability,
            runtime: runtimeDescriptor({
              themeId: input.themeId,
              siteId: input.siteId,
              installationId: input.installationId,
              manifestDigest: input.manifestDigest,
            }),
          }),
          createEditorHandoff: async () => ({
            handoffUrl: `https://sandbox.onvoyant.com/connect#code=vye_${"a".repeat(52)}`,
            expiresAt: "2026-08-19T12:05:00.000Z",
          }),
          replaceSessionManifest,
          revokeSession: async () => {},
        }),
        waitForShutdown: async (cleanup) => {
          await onReport?.({
            schemaVersion: "voyant.theme.tooling.v1",
            ok: false,
            diagnostics: [
              {
                code: "THEME_ROUTE_INVALID",
                severity: "error",
                message: "Route is invalid.",
                path: "$.manifest.routes.0",
              },
            ],
          })
          expect(replaceSessionManifest).not.toHaveBeenCalled()
          await onReport?.(changed)
          await cleanup()
        },
      }),
    ).toBe(0)

    expect(replaceSessionManifest).toHaveBeenCalledOnce()
    expect(replaceSessionManifest).toHaveBeenCalledWith(
      "tds_session",
      expect.objectContaining({
        expectedManifestDigest: themeManifestDigest({ id: "fixture-theme" }),
        manifest: changed.theme.manifest,
        manifestDigest: themeManifestDigest(changed.theme.manifest),
      }),
    )
    expect(reload).toHaveBeenCalledOnce()
    expect(run.stderr.join("")).toContain("keeping the last valid remote manifest")
    expect(run.stderr.join("")).toContain("manifest updated; Astro restarted")
    expect(run.stdout.join("") + run.stderr.join("")).not.toContain(capability)
  })

  it("keeps --local fixture development at zero cloud calls", async () => {
    const createPlatformAdapter = vi.fn(() => {
      throw new Error("cloud must not be initialized")
    })
    const close = vi.fn(async () => {})
    const run = io(root, ["dev", "--local"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({
          developTheme: async () => ({
            url: "http://127.0.0.1:4321",
            wait: () => new Promise<number>(() => {}),
            close,
          }),
        }),
        createPlatformAdapter,
        waitForShutdown: async (cleanup) => cleanup(),
      }),
    ).toBe(0)
    expect(createPlatformAdapter).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it("preserves fixture development by default for an unlinked project", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    const createPlatformAdapter = vi.fn(() => {
      throw new Error("cloud must not be initialized")
    })
    const developTheme = vi.fn(async () => ({
      url: "http://127.0.0.1:4321",
      wait: () => new Promise<number>(() => {}),
      close: async () => {},
    }))
    const run = io(root, ["dev"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ developTheme }),
        createPlatformAdapter,
        waitForShutdown: async (cleanup) => cleanup(),
      }),
    ).toBe(0)
    expect(createPlatformAdapter).not.toHaveBeenCalled()
    expect(developTheme).toHaveBeenCalledWith(
      expect.not.objectContaining({ runtime: expect.anything() }),
    )
  })

  it("fails closed instead of falling back when the project link is malformed", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    mkdirSync(join(root, ".voyant"), { recursive: true })
    writeFileSync(join(root, ".voyant", "theme-project-link.json"), "{\n")
    const developTheme = vi.fn()
    const run = io(root, ["dev"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ developTheme }),
      }),
    ).toBe(1)
    expect(developTheme).not.toHaveBeenCalled()
    expect(run.stderr.join("")).toContain("invalid JSON")
    expect(run.stderr.join("")).toContain("theme unlink")
  })

  it("rejects a network-wide host before creating a connected session", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    writeLinkedProject(root)
    const createPlatformAdapter = vi.fn()
    const developTheme = vi.fn()
    const run = io(root, ["dev", "--host", "0.0.0.0"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ developTheme }),
        createPlatformAdapter,
      }),
    ).toBe(1)
    expect(createPlatformAdapter).not.toHaveBeenCalled()
    expect(developTheme).not.toHaveBeenCalled()
    expect(run.stderr.join("")).toContain("private session capability")
  })

  it("does not fall back to fixtures when connected session creation fails", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    writeLinkedProject(root)
    const developTheme = vi.fn()
    const run = io(root, ["dev"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({
          validateTheme: async () => validReport(),
          parseThemeDevelopmentRuntimeDescriptor: (value) => value,
          developTheme,
        }),
        createPlatformAdapter: () => ({
          listTargets: async () => ({ organizationId: "org_canonical", themes: [], sites: [] }),
          resolveTarget: async () => canonicalLink(),
          createSession: async () => Promise.reject(new Error("session unavailable")),
          createEditorHandoff: async () => Promise.reject(new Error("unexpected")),
          replaceSessionManifest: async () => Promise.reject(new Error("unexpected")),
          revokeSession: async () => {},
        }),
      }),
    ).toBe(1)
    expect(developTheme).not.toHaveBeenCalled()
    expect(run.stderr.join("")).toContain("session unavailable")
  })

  it("fails before cloud access when the project SDK lacks connected development", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    writeLinkedProject(root)
    const createPlatformAdapter = vi.fn()
    const run = io(root, ["dev"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ developTheme: vi.fn() }),
        createPlatformAdapter,
      }),
    ).toBe(1)
    expect(createPlatformAdapter).not.toHaveBeenCalled()
    expect(run.stderr.join("")).toContain("Upgrade @voyant-travel/theme")
    expect(run.stderr.join("")).toContain("--local")
  })

  it("fails non-interactively on ambiguous cloud credentials without starting Astro", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    writeLinkedProject(root)
    const developTheme = vi.fn()
    const run = io(root, ["dev"])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({
          validateTheme: async () => validReport(),
          parseThemeDevelopmentRuntimeDescriptor: (value) => value,
          developTheme,
        }),
        createPlatformAdapter: () => {
          throw new Error(
            "You are logged in to multiple orgs. Select one with --org; no prompt is available.",
          )
        },
      }),
    ).toBe(1)
    expect(developTheme).not.toHaveBeenCalled()
    expect(run.stderr.join("")).toContain("multiple orgs")
    expect(run.stderr.join("")).toContain("--org")
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
    expect(THEME_SDK_SCAFFOLD_VERSION).toBe("1.6.0")
    expect(THEME_ASTRO_SCAFFOLD_VERSION).toBe("1.0.2")
    const config = readFileSync(join(target, "theme.config.ts"), "utf8")
    expect(config).toContain("defineTheme")
    expect(config).toContain('context: "home"')
    expect(config).toContain('{ id: "content", pattern: "/journal/[...path]", context: "content" }')
    expect(config).toContain('context: "notFound"')
    expect(config).toContain('contractVersion: "v1"')
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
      contractVersion: "v1",
      manifest: { id: "fixture-theme" },
      manifestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
    expect(JSON.parse(run.stdout.join(""))).toMatchObject({
      schemaVersion: "voyant.theme-link-result.v1",
      link: { themeId: "thm_123", siteId: "site_123" },
    })
    expect(readFileSync(join(root, ".voyant", "theme-project-link.json"), "utf8")).not.toContain(
      "token",
    )
  })

  it("lists actionable development targets without reading or writing the local project", async () => {
    const listTargets = vi.fn(async () => ({
      organizationId: "org_123",
      themes: [{ id: "thm_123", slug: "bucharest", name: "Bucharest", status: "active" }],
      sites: [
        {
          id: "site_123",
          slug: "preview",
          platformHostname: "preview.sandbox.onvoyant.com",
          status: "active",
          installations: [{ id: "thi_123", themeId: "thm_123", archived: false }],
        },
      ],
    }))
    const run = io(root, ["targets", "--api-url", "https://sandbox.onvoyant.com"])

    expect(
      await themeCommand(run.ctx, {
        createPlatformAdapter: () => ({
          listTargets,
          resolveTarget: async () => Promise.reject(new Error("unexpected")),
          createSession: async () => Promise.reject(new Error("unexpected")),
          createEditorHandoff: async () => Promise.reject(new Error("unexpected")),
          replaceSessionManifest: async () => Promise.reject(new Error("unexpected")),
          revokeSession: async () => Promise.reject(new Error("unexpected")),
        }),
      }),
    ).toBe(0)
    expect(listTargets).toHaveBeenCalledOnce()
    expect(run.stdout.join("")).toContain("bucharest (thm_123) — Bucharest [active]")
    expect(run.stdout.join("")).toContain("thi_123 — bucharest (thm_123) [active]")
    expect(run.stdout.join("")).toContain("voyant theme link --theme <id|slug>")
    expect(existsSync(join(root, ".voyant"))).toBe(false)
  })

  it("prints development targets as a stable JSON envelope", async () => {
    const run = io(root, ["targets", "--json"])

    expect(
      await themeCommand(run.ctx, {
        createPlatformAdapter: () => ({
          listTargets: async () => ({ organizationId: "org_123", themes: [], sites: [] }),
          resolveTarget: async () => Promise.reject(new Error("unexpected")),
          createSession: async () => Promise.reject(new Error("unexpected")),
          createEditorHandoff: async () => Promise.reject(new Error("unexpected")),
          replaceSessionManifest: async () => Promise.reject(new Error("unexpected")),
          revokeSession: async () => Promise.reject(new Error("unexpected")),
        }),
      }),
    ).toBe(0)
    expect(JSON.parse(run.stdout.join(""))).toEqual({
      schemaVersion: "voyant.theme-development-targets.v1",
      organizationId: "org_123",
      themes: [],
      sites: [],
    })
    expect(run.stderr).toEqual([])
  })

  it("does not write a link when remote target resolution fails", async () => {
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
    const run = io(root, [
      "link",
      "--theme",
      "thm_123",
      "--site",
      "site_123",
      "--installation",
      "thi_123",
      "--json",
    ])

    expect(
      await themeCommand(run.ctx, {
        loadTooling: async () => ({ validateTheme: async () => validReport() }),
        createPlatformAdapter: () => ({
          listTargets: async () => ({ organizationId: "org_123", themes: [], sites: [] }),
          resolveTarget: async () => {
            throw Object.assign(new Error("Target resolver is not deployed."), {
              code: "theme_target_resolver_unavailable",
            })
          },
          createSession: async () => Promise.reject(new Error("unexpected")),
          createEditorHandoff: async () => Promise.reject(new Error("unexpected")),
          replaceSessionManifest: async () => Promise.reject(new Error("unexpected")),
          revokeSession: async () => {},
        }),
      }),
    ).toBe(1)
    expect(JSON.parse(run.stderr.join(""))).toMatchObject({
      error: { code: "theme_link_failed" },
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
    const run = io(root, ["status", "--local", "--json"])

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
    theme: { contractVersion: "v1", manifest: { id: "fixture-theme" } },
  }
}

function canonicalLink() {
  return {
    schemaVersion: "voyant.theme-project-link.v1" as const,
    apiUrl: "https://sandbox.onvoyant.com",
    organizationId: "org_canonical",
    themeId: "thm_canonical",
    siteId: "site_canonical",
    installationId: "thi_canonical",
  }
}

function writeLinkedProject(root: string): void {
  mkdirSync(join(root, ".voyant"), { recursive: true })
  writeFileSync(
    join(root, ".voyant", "theme-project-link.json"),
    `${JSON.stringify(canonicalLink())}\n`,
  )
}

function runtimeDescriptor(overrides: {
  themeId: string
  siteId: string
  installationId: string
  manifestDigest: `sha256:${string}`
}) {
  return {
    schemaVersion: "voyant.theme-development-runtime.v1" as const,
    sessionId: "tds_session",
    ...overrides,
    perspective: "development" as const,
    contentEndpoint: "https://sandbox.onvoyant.com/cloud/v1/theme-development/content",
    publicApiEndpoint: "https://sandbox.onvoyant.com/cloud/v1/theme-development/public-api",
    editor: {
      baseUrl: "https://sandbox.onvoyant.com/theme-editor",
      protocolVersion: "voyant.theme-editor.v1" as const,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
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
