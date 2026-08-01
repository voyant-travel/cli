import { mkdir, readdir, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

import { getStringFlag, parseArgs } from "../lib/args.js"
import { errorMessage, fail, printJson, wantsJson } from "../lib/output.js"
import { waitForShutdownSignal } from "../lib/shutdown.js"
import {
  assertThemeDevelopmentHandle,
  assertThemeToolingReport,
  loadThemeTooling,
  requireThemeToolingFunction,
  type ThemeDiagnostic,
  type ThemeToolingModule,
  type ThemeToolingReport,
  themeDiagnosticsFromError,
} from "../lib/theme-tooling.js"
import type { CommandContext, CommandResult } from "../types.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 4321
export const THEME_SDK_SCAFFOLD_VERSION = "0.1.0-alpha.0"
// 1.1.0 is the first CLI release containing the nested theme commands.
export const CLI_SCAFFOLD_VERSION_RANGE = "^1.1.0"

export interface ThemeCommandDeps {
  loadTooling?: (projectRoot: string) => Promise<ThemeToolingModule>
  scaffold?: typeof scaffoldTheme
  waitForShutdown?: (cleanup: () => Promise<void>) => Promise<void>
}

/** `voyant theme <init|check|build|dev>` — project-pinned theme development tooling. */
export async function themeCommand(
  ctx: CommandContext,
  deps: ThemeCommandDeps = {},
): Promise<CommandResult> {
  const { positionals } = parseArgs(ctx.argv)
  const sub = positionals[0]
  const requestedHelp = sub === "help" || ctx.argv.includes("--help") || ctx.argv.includes("-h")
  if (!sub || requestedHelp) {
    ctx.stdout(`${THEME_USAGE}\n`)
    return requestedHelp ? 0 : 1
  }

  const index = ctx.argv.indexOf(sub)
  const subCtx = { ...ctx, argv: index >= 0 ? ctx.argv.slice(index + 1) : [] }
  switch (sub) {
    case "init":
      return themeInitCommand(subCtx, deps)
    case "check":
      return runThemeReportCommand(subCtx, "check", "validateTheme", deps)
    case "build":
      return runThemeReportCommand(subCtx, "build", "buildTheme", deps)
    case "dev":
      return themeDevCommand(subCtx, deps)
    default:
      ctx.stderr(`Unknown theme subcommand: ${sub}. Expected "init", "check", "build", or "dev".\n`)
      return 1
  }
}

async function themeInitCommand(
  ctx: CommandContext,
  deps: ThemeCommandDeps,
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, { booleanFlags: ["json"] })
  const targetArg = args.positionals[0] ?? "."
  const target = resolve(ctx.cwd, targetArg)
  try {
    const result = await (deps.scaffold ?? scaffoldTheme)(target)
    if (wantsJson(args)) return printJson(ctx, result)
    ctx.stdout(`Created theme ${result.name} in ${result.directory}\n`)
    ctx.stdout("Next: install dependencies, then run `voyant theme dev`.\n")
    return 0
  } catch (error) {
    return fail(ctx, args, `voyant theme init: ${errorMessage(error)}`, "theme_init_failed")
  }
}

async function runThemeReportCommand(
  ctx: CommandContext,
  command: "check" | "build",
  functionName: "validateTheme" | "buildTheme",
  deps: ThemeCommandDeps,
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, { booleanFlags: ["json"] })
  try {
    const tooling = await (deps.loadTooling ?? loadThemeTooling)(ctx.cwd)
    const run = requireThemeToolingFunction(tooling, functionName, command)
    const options = { projectRoot: ctx.cwd, configFile: getStringFlag(args, "config") }
    const report = assertThemeToolingReport(
      await run(
        functionName === "buildTheme"
          ? { ...options, output: wantsJson(args) ? "silent" : "inherit" }
          : options,
      ),
      command,
    )
    if (wantsJson(args)) {
      printJson(ctx, report)
    } else {
      emitHumanReport(ctx, command, report)
    }
    return report.ok ? 0 : 1
  } catch (error) {
    return fail(
      ctx,
      args,
      `voyant theme ${command}: ${errorMessage(error)}`,
      `theme_${command}_failed`,
    )
  }
}

async function themeDevCommand(
  ctx: CommandContext,
  deps: ThemeCommandDeps,
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const portFlag = getStringFlag(args, "port")
  const port = portFlag === undefined ? DEFAULT_PORT : Number.parseInt(portFlag, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ctx.stderr(`voyant theme dev: --port must be 1-65535 (got "${String(portFlag)}")\n`)
    return 2
  }

  let cleanup: (() => Promise<void>) | undefined
  try {
    const tooling = await (deps.loadTooling ?? loadThemeTooling)(ctx.cwd)
    const developTheme = requireThemeToolingFunction(tooling, "developTheme", "dev")
    const handle = assertThemeDevelopmentHandle(
      await developTheme({
        projectRoot: ctx.cwd,
        configFile: getStringFlag(args, "config"),
        host: getStringFlag(args, "host") ?? DEFAULT_HOST,
        port,
      }),
    )
    let closed = false
    cleanup = async () => {
      if (closed) return
      closed = true
      await handle.close()
    }
    ctx.stderr(`voyant theme dev: ${handle.url}\n`)
    await (deps.waitForShutdown ?? waitForShutdownSignal)(cleanup)
    return 0
  } catch (error) {
    if (cleanup) {
      try {
        await cleanup()
      } catch {
        // Preserve the original lifecycle error.
      }
    }
    ctx.stderr(`voyant theme dev: ${errorMessage(error)}\n`)
    const diagnostics = themeDiagnosticsFromError(error)
    if (diagnostics) {
      for (const diagnostic of diagnostics) emitHumanDiagnostic(ctx, diagnostic)
    } else {
      ctx.stderr("Run `voyant theme check` for structured validation diagnostics.\n")
    }
    return 1
  }
}

function emitHumanReport(
  ctx: CommandContext,
  command: "check" | "build",
  report: ThemeToolingReport,
): void {
  for (const diagnostic of report.diagnostics) emitHumanDiagnostic(ctx, diagnostic)
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length
  const warnings = report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  ).length
  const detail = `${errors} error(s), ${warnings} warning(s)`
  const output = report.ok ? ctx.stdout : ctx.stderr
  output(`voyant theme ${command}: ${report.ok ? "ok" : "failed"} (${detail})\n`)
}

function emitHumanDiagnostic(ctx: CommandContext, diagnostic: ThemeDiagnostic): void {
  const location = diagnostic.path ? ` ${diagnostic.path}` : ""
  const sourceFile =
    diagnostic.source && typeof diagnostic.source.file === "string"
      ? ` (${diagnostic.source.file})`
      : ""
  ctx.stderr(
    `  ${diagnostic.severity.toUpperCase()} ${diagnostic.code}${location}: ${diagnostic.message}${sourceFile}\n`,
  )
}

export interface ScaffoldThemeResult {
  schemaVersion: "voyant.theme.init.v1"
  ok: true
  name: string
  directory: string
  files: readonly string[]
}

export async function scaffoldTheme(directory: string): Promise<ScaffoldThemeResult> {
  await mkdir(directory, { recursive: true })
  const existing = await readdir(directory)
  if (existing.length > 0) {
    throw new Error(`Refusing to scaffold into non-empty directory ${directory}.`)
  }

  const name = packageName(basename(directory))
  const files = themeTemplateFiles(name)
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = resolve(directory, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents, { encoding: "utf8", flag: "wx" })
  }
  return {
    schemaVersion: "voyant.theme.init.v1",
    ok: true,
    name,
    directory,
    files: Object.keys(files).sort(),
  }
}

function packageName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!normalized) return "voyant-theme"
  return /^[a-z]/.test(normalized) ? normalized : `theme-${normalized}`
}

function themeTemplateFiles(name: string): Record<string, string> {
  return {
    ".gitignore": "node_modules/\ndist/\n.astro/\n",
    "README.md": `# ${name}\n\nA Voyant Astro theme.\n\n\`\`\`sh\npnpm install\npnpm theme:check\npnpm dev\n\`\`\`\n`,
    "package.json": `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          dev: "voyant theme dev",
          "theme:check": "voyant theme check",
          build: "voyant theme build",
        },
        dependencies: {
          "@voyant-travel/astro": THEME_SDK_SCAFFOLD_VERSION,
          "@voyant-travel/theme": THEME_SDK_SCAFFOLD_VERSION,
          astro: "^5.0.0",
        },
        devDependencies: {
          "@voyant-travel/cli": CLI_SCAFFOLD_VERSION_RANGE,
        },
      },
      null,
      2,
    )}\n`,
    "astro.config.mjs": `import { voyantTheme } from "@voyant-travel/astro"\nimport { defineConfig } from "astro/config"\nimport theme from "./theme.config.ts"\n\nexport default defineConfig({ integrations: [voyantTheme({ theme })] })\n`,
    "src/env.d.ts": `/// <reference types="astro/client" />\n/// <reference types="@voyant-travel/astro/virtual" />\n`,
    "src/pages/index.astro": `---\nimport { resolveThemeContext } from "virtual:voyant-theme"\n\nconst context = resolveThemeContext(Astro.url)\n---\n\n<html lang={context.locale}>\n  <head><title>{context.title}</title></head>\n  <body>\n    <main>\n      <h1>{context.title}</h1>\n      {context.kind === "home" && <p>Your Voyant theme is ready.</p>}\n    </main>\n  </body>\n</html>\n`,
    "src/pages/[...slug].astro": `---\nimport { resolveThemeContext } from "virtual:voyant-theme"\n\nconst context = resolveThemeContext(Astro.url)\n---\n\n<html lang={context.locale}>\n  <head><title>{context.title}</title></head>\n  <body>\n    <main>\n      <h1>{context.title}</h1>\n      {context.kind === "content" && <p>{context.body}</p>}\n      {context.kind === "notFound" && <p>{context.message}</p>}\n    </main>\n  </body>\n</html>\n`,
    "theme.config.ts": `import { defineTheme } from "@voyant-travel/theme"\n\nexport default defineTheme({\n  contractVersion: "v1alpha1",\n  manifest: {\n    id: "${name}",\n    name: "${name}",\n    version: "0.1.0",\n    routes: [\n      { id: "home", pattern: "/", context: "home" },\n      { id: "content", pattern: "/:slug", context: "content" },\n      { id: "not-found", pattern: "/404", context: "notFound" },\n    ],\n    settings: [],\n    sections: [],\n  },\n  fixtures: {\n    home: {\n      kind: "home",\n      path: "/",\n      locale: "en",\n      site: { name: "${name}" },\n      navigation: [{ label: "Welcome", href: "/welcome" }],\n      settings: {},\n      title: "${name}",\n      sections: [],\n    },\n    content: [{\n      kind: "content",\n      path: "/welcome",\n      slug: "welcome",\n      locale: "en",\n      site: { name: "${name}" },\n      navigation: [{ label: "Home", href: "/" }],\n      settings: {},\n      title: "Welcome",\n      summary: "A fixture-backed content page.",\n      body: "Build your first Voyant theme here.",\n    }],\n    notFound: {\n      kind: "notFound",\n      path: "/404",\n      locale: "en",\n      site: { name: "${name}" },\n      navigation: [{ label: "Home", href: "/" }],\n      settings: {},\n      title: "Page not found",\n      message: "The requested page does not exist.",\n    },\n  },\n})\n`,
    "tsconfig.json": `{\n  "extends": "astro/tsconfigs/strict"\n}\n`,
  }
}

const THEME_USAGE = `voyant theme - develop themes with the project's installed SDK

usage:
  voyant theme init [directory] [--json]
  voyant theme check [--config <path>] [--json]
  voyant theme build [--config <path>] [--json]
  voyant theme dev [--config <path>] [--host <host>] [--port <n>]

commands:
  init    Scaffold a minimal Astro theme
  check   Validate the theme and print deterministic diagnostics
  build   Validate and build the theme
  dev     Start the theme development server
`
