import { mkdir, readdir, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import { errorMessage, fail, printJson, wantsJson } from "../lib/output.js"
import { waitForShutdownSignal } from "../lib/shutdown.js"
import {
  createThemePlatformAdapter,
  parseThemeDevelopmentRuntimeDescriptor,
  THEME_DEVELOPMENT_CAPABILITY_ENV,
  THEME_DEVELOPMENT_RUNTIME_ADAPTER_ID,
  type ThemePlatformAdapter,
  ThemePlatformError,
  themeManifestDigest,
} from "../lib/theme-platform.js"
import {
  type ResolvedThemeProject,
  readThemeProjectLink,
  removeThemeProjectLink,
  resolveThemeProject,
  resolveThemeTargetSelectors,
  type ThemeProjectLink,
  ThemeProjectLinkError,
  type ThemeTargetSelectors,
  writeThemeProjectLink,
} from "../lib/theme-project-link.js"
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
export const THEME_SDK_SCAFFOLD_VERSION = "1.6.0"
export const THEME_ASTRO_SCAFFOLD_VERSION = "1.0.2"
export const ASTRO_SCAFFOLD_VERSION = "7.1.6"
export const ASTRO_CLOUDFLARE_SCAFFOLD_VERSION = "14.1.7"
// 1.1.0 is the first CLI release containing the nested theme commands.
export const CLI_SCAFFOLD_VERSION_RANGE = "^1.2.0"

export interface ThemeCommandDeps {
  loadTooling?: (projectRoot: string) => Promise<ThemeToolingModule>
  scaffold?: typeof scaffoldTheme
  waitForShutdown?: typeof waitForShutdownSignal
  validateLink?: ThemeProjectLinkValidationAdapter
  createPlatformAdapter?: typeof createThemePlatformAdapter
}

export interface ThemeProjectLinkValidationInput {
  project: ResolvedThemeProject
  selectors: ThemeTargetSelectors
  contractVersion: string
  manifest: unknown
  manifestDigest: `sha256:${string}`
}

export interface ThemeProjectLinkValidationAdapter {
  validate(input: ThemeProjectLinkValidationInput): Promise<ThemeProjectLink>
}

/** Voyant Theme authoring, connected development, and local project linkage. */
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
    case "link":
      return themeLinkCommand(subCtx, deps)
    case "unlink":
      return themeUnlinkCommand(subCtx)
    case "status":
      return themeStatusCommand(subCtx, deps)
    default:
      ctx.stderr(
        `Unknown theme subcommand: ${sub}. Expected "init", "check", "build", "dev", "link", "unlink", or "status".\n`,
      )
      return 1
  }
}

async function themeLinkCommand(
  ctx: CommandContext,
  deps: ThemeCommandDeps,
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, { booleanFlags: ["json"] })
  try {
    const project = await resolveThemeProject({
      cwd: ctx.cwd,
      configFile: getStringFlag(args, "config"),
    })
    const existing = await readThemeProjectLink(project)
    const selectors = resolveThemeTargetSelectors(
      {
        theme: getStringFlag(args, "theme"),
        site: getStringFlag(args, "site"),
        installation: getStringFlag(args, "installation"),
        apiUrl: getStringFlag(args, "api-url"),
        organization: getStringFlag(args, "org"),
      },
      existing,
    )
    if (!selectors.theme) {
      return fail(
        ctx,
        args,
        "voyant theme link: --theme is required when the project has no existing link.",
        "theme_selector_required",
      )
    }
    if (selectors.installation && !selectors.site) {
      return fail(
        ctx,
        args,
        "voyant theme link: --installation requires --site or a linked Site.",
        "theme_site_selector_required",
      )
    }
    if (!selectors.site || !selectors.installation) {
      return fail(
        ctx,
        args,
        "voyant theme link: --site and --installation are required to resolve a canonical development target.",
        "theme_development_target_required",
      )
    }

    const report = await validateLocalTheme(project, deps)
    if (!report.ok) {
      if (wantsJson(args)) printJson(ctx, report)
      else emitHumanReport(ctx, "check", report)
      return 1
    }

    const definition = requireValidatedThemeDefinition(report)
    const adapter =
      deps.validateLink ??
      platformLinkValidationAdapter(
        (deps.createPlatformAdapter ?? createThemePlatformAdapter)({
          token: getStringFlag(args, "token"),
          apiUrl: selectors.apiUrl,
          org: selectors.organization,
        }),
      )
    const link = await adapter.validate({
      project,
      selectors: {
        theme: selectors.theme,
        site: selectors.site,
        installation: selectors.installation,
        apiUrl: selectors.apiUrl,
        organization: selectors.organization,
      },
      contractVersion: definition.contractVersion,
      manifest: definition.manifest,
      manifestDigest: themeManifestDigest(definition.manifest),
    })
    const stored = await writeThemeProjectLink(project, link)
    const result = {
      schemaVersion: "voyant.theme-link-result.v1",
      ok: true,
      projectRoot: project.projectRoot,
      linkPath: project.linkPath,
      link: stored,
    }
    if (wantsJson(args)) return printJson(ctx, result)
    ctx.stdout(`Linked Theme Project to ${stored.themeId}.\n`)
    if (stored.siteId) ctx.stdout(`Default Site: ${stored.siteId}\n`)
    if (stored.installationId) ctx.stdout(`Default installation: ${stored.installationId}\n`)
    return 0
  } catch (error) {
    return failThemeProjectCommand(ctx, args, "link", error)
  }
}

async function themeUnlinkCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, { booleanFlags: ["json"] })
  try {
    const project = await resolveThemeProject({
      cwd: ctx.cwd,
      configFile: getStringFlag(args, "config"),
    })
    const removed = await removeThemeProjectLink(project)
    const result = {
      schemaVersion: "voyant.theme-unlink-result.v1",
      ok: true,
      removed,
      projectRoot: project.projectRoot,
      linkPath: project.linkPath,
    }
    if (wantsJson(args)) return printJson(ctx, result)
    ctx.stdout(
      removed
        ? "Removed the local Theme Project Link. No remote resources were changed.\n"
        : "Theme Project is not linked; no remote resources were changed.\n",
    )
    return 0
  } catch (error) {
    return failThemeProjectCommand(ctx, args, "unlink", error)
  }
}

async function themeStatusCommand(
  ctx: CommandContext,
  deps: ThemeCommandDeps,
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, { booleanFlags: ["json", "local"] })
  try {
    const project = await resolveThemeProject({
      cwd: ctx.cwd,
      configFile: getStringFlag(args, "config"),
    })
    const [link, local] = await Promise.all([
      readThemeProjectLink(project),
      validateLocalTheme(project, deps),
    ])
    let remoteValidation: "not_checked" | "target_resolved" = "not_checked"
    if (link && !getBooleanFlag(args, "local")) {
      const platform = (deps.createPlatformAdapter ?? createThemePlatformAdapter)({
        token: getStringFlag(args, "token"),
        apiUrl: getStringFlag(args, "api-url") ?? link.apiUrl,
        org: getStringFlag(args, "org") ?? link.organizationId,
      })
      if (!local.ok) {
        throw new ThemePlatformError(
          "theme_local_invalid",
          "Remote target validation requires a valid local Theme manifest.",
        )
      }
      const definition = requireValidatedThemeDefinition(local)
      const resolved = await platform.resolveTarget({
        selectors: {
          theme: link.themeId,
          site: link.siteId,
          installation: link.installationId,
          apiUrl: link.apiUrl,
          organization: link.organizationId,
        },
        contractVersion: definition.contractVersion,
        manifest: definition.manifest,
        manifestDigest: themeManifestDigest(definition.manifest),
      })
      if (
        resolved.organizationId !== link.organizationId ||
        resolved.themeId !== link.themeId ||
        resolved.siteId !== link.siteId ||
        resolved.installationId !== link.installationId
      ) {
        throw new ThemePlatformError(
          "theme_link_target_changed",
          "The linked Theme target no longer resolves to the stored canonical identity. Run `voyant theme link` again.",
        )
      }
      remoteValidation = "target_resolved"
    }
    const result = {
      schemaVersion: "voyant.theme-status.v1",
      projectRoot: project.projectRoot,
      configPath: project.configPath,
      linked: link !== null,
      link,
      local: {
        valid: local.ok,
        diagnostics: local.diagnostics,
      },
      remoteValidation,
    }
    if (wantsJson(args)) return printJson(ctx, result)
    ctx.stdout(`Theme Project: ${project.projectRoot}\n`)
    ctx.stdout(`Local theme: ${local.ok ? "valid" : "invalid"}\n`)
    if (!link) {
      ctx.stdout("Remote Theme: not linked\n")
    } else {
      ctx.stdout(`Remote Theme: ${link.themeId}\n`)
      ctx.stdout(`Organization: ${link.organizationId}\n`)
      if (link.siteId) ctx.stdout(`Default Site: ${link.siteId}\n`)
      if (link.installationId) ctx.stdout(`Default installation: ${link.installationId}\n`)
      ctx.stdout(
        `Remote validation: ${remoteValidation === "target_resolved" ? "target resolved" : "not checked"}\n`,
      )
    }
    return local.ok ? 0 : 1
  } catch (error) {
    return failThemeProjectCommand(ctx, args, "status", error)
  }
}

async function validateLocalTheme(
  project: ResolvedThemeProject,
  deps: ThemeCommandDeps,
): Promise<ThemeToolingReport> {
  const tooling = await (deps.loadTooling ?? loadThemeTooling)(project.projectRoot)
  const validateTheme = requireThemeToolingFunction(tooling, "validateTheme", "check")
  return assertThemeToolingReport(
    await validateTheme({ projectRoot: project.projectRoot, configFile: project.configPath }),
    "check",
  )
}

function platformLinkValidationAdapter(
  platform: ThemePlatformAdapter,
): ThemeProjectLinkValidationAdapter {
  return {
    async validate(input) {
      return platform.resolveTarget({
        selectors: input.selectors,
        contractVersion: input.contractVersion,
        manifest: input.manifest,
        manifestDigest: input.manifestDigest,
      })
    },
  }
}

function failThemeProjectCommand(
  ctx: CommandContext,
  args: ReturnType<typeof parseArgs>,
  command: "link" | "unlink" | "status",
  error: unknown,
): 1 {
  const code =
    error instanceof ThemeProjectLinkError || error instanceof ThemePlatformError
      ? error.code
      : `theme_${command}_failed`
  return fail(ctx, args, `voyant theme ${command}: ${errorMessage(error)}`, code)
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
    const options = { projectRoot: ctx.cwd, configFile: getStringFlag(args, "config") }
    const json = wantsJson(args)
    const report = assertThemeToolingReport(
      await withSuppressedProcessStdout(json, async () => {
        const tooling = await (deps.loadTooling ?? loadThemeTooling)(ctx.cwd)
        const run = requireThemeToolingFunction(tooling, functionName, command)
        return run(
          functionName === "buildTheme"
            ? { ...options, output: json ? "silent" : "inherit" }
            : options,
        )
      }),
      command,
    )
    if (json) {
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
  const args = parseArgs(ctx.argv, { booleanFlags: ["local", "json"] })
  const portFlag = getStringFlag(args, "port")
  const port = portFlag === undefined ? DEFAULT_PORT : Number.parseInt(portFlag, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ctx.stderr(`voyant theme dev: --port must be 1-65535 (got "${String(portFlag)}")\n`)
    return 2
  }

  let cleanup: (() => Promise<void>) | undefined
  let shutdownController: AbortController | undefined
  let revokeSession: (() => Promise<void>) | undefined
  try {
    const explicitLocal = getBooleanFlag(args, "local")
    const explicitConnectedTarget = ["theme", "site", "installation", "api-url", "org"].some(
      (flag) => getStringFlag(args, flag) !== undefined,
    )
    const configFile = getStringFlag(args, "config")
    let project: ResolvedThemeProject | undefined
    let linked: ThemeProjectLink | null = null
    if (!explicitLocal) {
      try {
        project = await resolveThemeProject({ cwd: ctx.cwd, configFile })
      } catch (error) {
        if (
          explicitConnectedTarget ||
          !(error instanceof ThemeProjectLinkError) ||
          error.code !== "theme_project_not_found"
        ) {
          throw error
        }
      }
      if (project) linked = await readThemeProjectLink(project)
    }
    const connected = !explicitLocal && (linked !== null || explicitConnectedTarget)
    const local = !connected
    const projectRoot = project?.projectRoot ?? ctx.cwd
    const resolvedConfigFile = project?.configPath ?? configFile
    const tooling = await (deps.loadTooling ?? loadThemeTooling)(projectRoot)
    const developTheme = requireThemeToolingFunction(tooling, "developTheme", "dev")
    let runtime:
      | {
          descriptor: unknown
          adapter: NonNullable<
            NonNullable<Parameters<typeof developTheme>[0]["runtime"]>
          >["adapter"]
        }
      | undefined

    if (!local) {
      if (!project) throw new Error("Connected Theme Project resolution failed.")
      const host = getStringFlag(args, "host") ?? DEFAULT_HOST
      if (host === "0.0.0.0" || host === "::") {
        throw new ThemePlatformError(
          "theme_development_network_host_forbidden",
          "Connected development cannot bind to 0.0.0.0 or :: because it carries a private session capability. Use 127.0.0.1 or localhost.",
        )
      }
      if (typeof tooling.parseThemeDevelopmentRuntimeDescriptor !== "function") {
        throw new ThemePlatformError(
          "theme_sdk_upgrade_required",
          "The project-installed @voyant-travel/theme does not support connected development. Upgrade @voyant-travel/theme and @voyant-travel/astro, or use `voyant theme dev --local` for fixture mode.",
        )
      }
      const report = assertThemeToolingReport(
        await requireThemeToolingFunction(
          tooling,
          "validateTheme",
          "check",
        )({
          projectRoot,
          configFile: resolvedConfigFile,
        }),
        "check",
      )
      if (!report.ok) {
        emitHumanReport(ctx, "check", report)
        return 1
      }
      const definition = requireValidatedThemeDefinition(report)
      const manifest = definition.manifest
      const manifestDigest = themeManifestDigest(manifest)
      const selectors = resolveThemeTargetSelectors(
        {
          theme: getStringFlag(args, "theme"),
          site: getStringFlag(args, "site"),
          installation: getStringFlag(args, "installation"),
          apiUrl: getStringFlag(args, "api-url"),
          organization: getStringFlag(args, "org"),
        },
        linked,
      )
      requireConnectedThemeTarget(selectors)
      const platform = (deps.createPlatformAdapter ?? createThemePlatformAdapter)({
        token: getStringFlag(args, "token"),
        apiUrl: selectors.apiUrl,
        org: selectors.organization,
      })
      const link = await platform.resolveTarget({
        selectors,
        contractVersion: definition.contractVersion,
        manifest,
        manifestDigest,
      })
      const session = await platform.createSession({
        themeId: link.themeId,
        siteId: link.siteId,
        installationId: link.installationId,
        localOrigin: developmentOrigin(host, port),
        contractVersion: definition.contractVersion,
        manifest,
        manifestDigest,
      })
      let revoked = false
      const sessionId = session.runtime.sessionId
      revokeSession = async () => {
        if (revoked) return
        revoked = true
        if (typeof sessionId !== "string" || sessionId.length === 0) return
        try {
          await platform.revokeSession(sessionId)
        } catch {
          // Session capabilities are short-lived; revocation is best effort on exit.
        }
      }
      const descriptor = parseThemeDevelopmentRuntimeDescriptor(
        tooling.parseThemeDevelopmentRuntimeDescriptor(session.runtime),
      )
      if (Date.parse(descriptor.expiresAt) <= Date.now()) {
        throw new ThemePlatformError(
          "theme_development_session_expired",
          "The Voyant platform returned an already-expired Theme Development Session.",
        )
      }
      assertRuntimeMatchesTarget(descriptor, link, manifestDigest)
      runtime = {
        descriptor,
        adapter: {
          id: THEME_DEVELOPMENT_RUNTIME_ADAPTER_ID,
          async prepare(context) {
            if (
              !isRecord(context.descriptor) ||
              context.descriptor.sessionId !== descriptor.sessionId
            ) {
              throw new Error("Theme tooling prepared a different development session.")
            }
            return {
              childEnvironment: {
                [THEME_DEVELOPMENT_CAPABILITY_ENV]: session.sessionToken,
              },
              dispose: revokeSession,
            }
          },
        },
      }
    }
    const handle = assertThemeDevelopmentHandle(
      await developTheme({
        projectRoot,
        configFile: resolvedConfigFile,
        host: getStringFlag(args, "host") ?? DEFAULT_HOST,
        port,
        ...(runtime ? { runtime } : {}),
      }),
    )
    let closed = false
    cleanup = async () => {
      if (closed) return
      closed = true
      try {
        await handle.close()
      } finally {
        await revokeSession?.()
      }
    }
    ctx.stderr(`voyant theme dev: ${handle.url}\n`)
    if (runtime) {
      ctx.stderr(
        "voyant theme dev: the remote editor manifest is pinned for this session; restart after changing theme.config until live manifest reload is enabled.\n",
      )
    }
    shutdownController = new AbortController()
    let shutdownRequested = false
    const shutdown = (deps.waitForShutdown ?? waitForShutdownSignal)(
      async () => {
        shutdownRequested = true
        await cleanup?.()
      },
      { abortSignal: shutdownController.signal },
    ).then(() => ({ kind: "shutdown" as const }))
    const completed = handle.wait().then((code) => {
      if (!Number.isInteger(code) || code < 0) {
        throw new Error("Theme tooling returned an invalid development server exit code.")
      }
      return { kind: "completed" as const, code }
    })
    const outcome = await Promise.race([shutdown, completed])
    shutdownController.abort()
    if (outcome.kind === "shutdown" || shutdownRequested) return 0

    await cleanup()
    if (outcome.code !== 0) {
      ctx.stderr(`voyant theme dev: development server exited with code ${outcome.code}.\n`)
    }
    return outcome.code
  } catch (error) {
    shutdownController?.abort()
    if (cleanup) {
      try {
        await cleanup()
      } catch {
        // Preserve the original lifecycle error.
      }
    }
    await revokeSession?.()
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

function requireValidatedThemeDefinition(report: ThemeToolingReport): {
  contractVersion: string
  manifest: Record<string, unknown>
} {
  if (
    !isRecord(report.theme) ||
    typeof report.theme.contractVersion !== "string" ||
    report.theme.contractVersion.length === 0 ||
    !isRecord(report.theme.manifest)
  ) {
    throw new ThemePlatformError(
      "theme_sdk_upgrade_required",
      "The project-installed @voyant-travel/theme did not return its validated manifest. Upgrade @voyant-travel/theme before starting connected development.",
    )
  }
  return {
    contractVersion: report.theme.contractVersion,
    manifest: report.theme.manifest,
  }
}

function requireConnectedThemeTarget(
  selectors: ReturnType<typeof resolveThemeTargetSelectors>,
): void {
  if (!selectors.theme || !selectors.site || !selectors.installation) {
    throw new ThemePlatformError(
      "theme_development_target_required",
      "Connected development requires a Theme, Site, and installation. Run `voyant theme link --theme <id> --site <id> --installation <id>` or pass all three flags.",
    )
  }
  if (!selectors.apiUrl || !selectors.organization) {
    throw new ThemePlatformError(
      "theme_project_link_required",
      "Connected development requires a linked API URL and organization. Run `voyant theme link` first.",
    )
  }
}

function assertRuntimeMatchesTarget(
  runtime: ReturnType<typeof parseThemeDevelopmentRuntimeDescriptor>,
  link: ThemeProjectLink & { siteId: string; installationId: string },
  manifestDigest: string,
): void {
  if (
    runtime.themeId !== link.themeId ||
    runtime.siteId !== link.siteId ||
    runtime.installationId !== link.installationId ||
    runtime.manifestDigest !== manifestDigest
  ) {
    throw new ThemePlatformError(
      "theme_development_target_mismatch",
      "The Voyant platform returned a Theme Development Runtime for a different target or manifest.",
    )
  }
}

function developmentOrigin(host: string, port: number): string {
  const formatted = host.includes(":") ? `[${host}]` : host
  const url = new URL(`http://${formatted}:${port}`)
  if (url.hostname !== host && url.hostname !== `[${host}]`) {
    throw new ThemePlatformError(
      "theme_development_host_invalid",
      "--host must be a host name or IP address.",
    )
  }
  return url.origin
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function withSuppressedProcessStdout<T>(
  suppress: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  if (!suppress) return operation()
  const write = process.stdout.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    return await operation()
  } finally {
    process.stdout.write = write
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
    ".gitignore": "node_modules/\ndist/\n.astro/\n.wrangler/\n.voyant/\n",
    "README.md": `# ${name}\n\nA Voyant Astro theme with fixture-backed home, content, and tour pages. Tour catalog content is immutable; current pricing, availability, booking, and checkout stay behind declared live capabilities.\n\n\`\`\`sh\npnpm install\npnpm theme:check\npnpm dev\npnpm build\n\`\`\`\n`,
    "package.json": `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        type: "module",
        engines: { node: ">=22.12.0" },
        scripts: {
          dev: "voyant theme dev",
          "theme:check": "voyant theme check",
          build: "voyant theme build",
        },
        dependencies: {
          "@astrojs/cloudflare": ASTRO_CLOUDFLARE_SCAFFOLD_VERSION,
          "@voyant-travel/astro": THEME_ASTRO_SCAFFOLD_VERSION,
          "@voyant-travel/theme": THEME_SDK_SCAFFOLD_VERSION,
          astro: ASTRO_SCAFFOLD_VERSION,
        },
        devDependencies: {
          "@voyant-travel/cli": CLI_SCAFFOLD_VERSION_RANGE,
        },
      },
      null,
      2,
    )}\n`,
    "astro.config.mjs": `import cloudflare from "@astrojs/cloudflare"\nimport { voyantTheme } from "@voyant-travel/astro"\nimport { defineConfig, sessionDrivers } from "astro/config"\nimport theme from "./theme.config.ts"\n\nexport default defineConfig({\n  adapter: cloudflare({ imageService: "passthrough" }),\n  output: "server",\n  session: { driver: sessionDrivers.lruCache() },\n  build: { format: "directory" },\n  integrations: [voyantTheme({ theme })],\n})\n`,
    "src/env.d.ts": `/// <reference types="astro/client" />\n/// <reference types="@voyant-travel/astro/virtual" />\n`,
    "src/pages/[...path].astro": `---\nimport { resolveThemeContext } from "virtual:voyant-theme"\n\nconst context = await resolveThemeContext(Astro.url)\nif (context.kind === "notFound") Astro.response.status = 404\n---\n\n<!doctype html>\n<html lang={context.locale}>\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width" />\n    <title>{context.seo.title} · {context.site.name}</title>\n    {context.seo.description && <meta name="description" content={context.seo.description} />}\n    {context.seo.noIndex && <meta name="robots" content="noindex" />}\n    {context.openGraph?.title && <meta property="og:title" content={context.openGraph.title} />}\n    {context.openGraph?.description && <meta property="og:description" content={context.openGraph.description} />}\n    {context.openGraph?.image && <meta property="og:image" content={context.openGraph.image.src} />}\n    {context.codeInjection?.head && <Fragment set:html={context.codeInjection.head} />}\n  </head>\n  <body>\n    {context.codeInjection?.bodyStart && <Fragment set:html={context.codeInjection.bodyStart} />}\n    <header>\n      <a href="/">{context.site.name}</a>\n      <nav>{context.navigation.map((item) => <a href={item.href}>{item.label}</a>)}</nav>\n    </header>\n    <main>\n      <h1>{context.title}</h1>\n      {context.kind === "home" && <p>Your Voyant theme is ready.</p>}\n      {context.kind === "content" && <><p>{context.summary}</p><article>{context.body}</article></>}\n      {context.kind === "tourIndex" && (\n        <ul>{context.products.map((product) => <li><a href={\`/tours/\${product.slug}\`}>{product.name}</a></li>)}</ul>\n      )}\n      {context.kind === "tourDetail" && (\n        <>\n          <p>{context.product.shortDescription}</p>\n          {context.product.descriptionHtml && <article set:html={context.product.descriptionHtml} />}\n          <p>Live selling is available through the capabilities declared by this theme.</p>\n        </>\n      )}\n      {context.kind === "notFound" && <p>{context.message}</p>}\n    </main>\n    {context.codeInjection?.bodyEnd && <Fragment set:html={context.codeInjection.bodyEnd} />}\n  </body>\n</html>\n`,
    "theme.config.ts": `import { defineTheme } from "@voyant-travel/theme"\n\nconst product = {\n  id: "danube-delta",\n  slug: "danube-delta",\n  name: "The Danube delta",\n  shortDescription: "Reed beds, quiet channels, and village guesthouses.",\n  descriptionHtml: "<p>Explore Europe's largest wetland by small boat.</p>",\n  bookingMode: "itinerary" as const,\n  capacityMode: "limited" as const,\n  categories: [{ id: "nature", name: "Nature", slug: "nature" }],\n  tags: [{ id: "small-group", name: "Small group" }],\n  destinations: [{ id: "tulcea", slug: "tulcea", name: "Tulcea" }],\n  locations: [],\n  media: [],\n  features: [],\n  faqs: [],\n}\n\nexport default defineTheme({\n  contractVersion: "v1",\n  manifest: {\n    id: "${name}",\n    name: "${name}",\n    version: "0.1.0",\n    routes: [\n      { id: "home", pattern: "/", context: "home" },\n      { id: "content", pattern: "/journal/[...path]", context: "content" },\n      { id: "tours", pattern: "/tours", context: "tourIndex" },\n      { id: "tour-detail", pattern: "/tours/[slug]", context: "tourDetail" },\n      { id: "not-found", pattern: "/404", context: "notFound" },\n    ],\n    capabilities: [\n      { id: "catalog.search.v1" },\n      { id: "catalog.product-detail.v1" },\n      { id: "catalog.pricing.v1" },\n      { id: "catalog.availability.v1" },\n      { id: "catalog.requirements.v1" },\n      { id: "catalog.markets.v1" },\n      { id: "booking.session.v1" },\n      { id: "checkout.v1" },\n    ],\n    settings: [],\n    sections: [],\n  },\n  fixtures: {\n    home: {\n      kind: "home",\n      path: "/",\n      locale: "en",\n      site: { name: "${name}" },\n      navigation: [{ label: "Tours", href: "/tours" }],\n      menus: {},\n      seo: { title: "${name}" },\n      settings: {},\n      title: "${name}",\n      sections: [],\n    },\n    content: [{\n      kind: "content",\n      path: "/journal/welcome",\n      slug: "welcome",\n      locale: "en",\n      site: { name: "${name}" },\n      navigation: [{ label: "Home", href: "/" }],\n      menus: {},\n      seo: { title: "Welcome" },\n      settings: {},\n      title: "Welcome",\n      summary: "A fixture-backed content page.",\n      body: "Build your first Voyant theme here.",\n    }],\n    tourIndex: {\n      kind: "tourIndex",\n      path: "/tours",\n      locale: "en",\n      site: { name: "${name}" },\n      navigation: [{ label: "Home", href: "/" }],\n      menus: {},\n      seo: { title: "Tours" },\n      settings: {},\n      title: "Tours",\n      products: [product],\n    },\n    tourDetail: [{\n      kind: "tourDetail",\n      path: "/tours/danube-delta",\n      slug: "danube-delta",\n      locale: "en",\n      site: { name: "${name}" },\n      navigation: [{ label: "Tours", href: "/tours" }],\n      menus: {},\n      seo: { title: "The Danube delta" },\n      settings: {},\n      title: "The Danube delta",\n      product,\n    }],\n    notFound: {\n      kind: "notFound",\n      path: "/404",\n      locale: "en",\n      site: { name: "${name}" },\n      navigation: [{ label: "Home", href: "/" }],\n      menus: {},\n      seo: { title: "Page not found", noIndex: true },\n      settings: {},\n      title: "Page not found",\n      message: "The requested page does not exist.",\n    },\n  },\n})\n`,
    "wrangler.jsonc": `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": "@astrojs/cloudflare/entrypoints/server",
  "compatibility_date": "2026-08-02",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS"
  },
  "observability": {
    "enabled": true
  }
}\n`,
    "tsconfig.json": `{\n  "extends": "astro/tsconfigs/strict"\n}\n`,
  }
}

const THEME_USAGE = `voyant theme - develop themes with the project's installed SDK

usage:
  voyant theme init [directory] [--json]
  voyant theme check [--config <path>] [--json]
  voyant theme build [--config <path>] [--json]
  voyant theme dev [--local] [--config <path>] [--host <host>] [--port <n>]
  voyant theme link --theme <id|slug> --site <id|slug> --installation <id> [--json]
  voyant theme unlink [--json]
  voyant theme status [--local] [--json]

commands:
  init    Scaffold a tour-capable Astro theme
  check   Validate the theme and print deterministic diagnostics
  build   Validate and build the theme
  dev     Start connected development (use --local for fixture-only mode)
  link    Link this project to a canonical remote Theme target
  unlink  Remove only the local Theme Project Link
  status  Validate the local Theme and linked remote target

notes:
  An unlinked project keeps the existing fixture-backed dev behavior.
  Linking records only canonical Voyant identities; externally hosted Sites are not registered.
`
