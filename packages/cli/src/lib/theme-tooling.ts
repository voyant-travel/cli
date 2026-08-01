import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { loadProjectModule } from "./project-module-loader.js"

const THEME_PACKAGE = "@voyant-travel/theme"
const TOOLING_PACKAGE = "@voyant-travel/theme/tooling"

export interface ThemeDiagnostic {
  code: string
  message: string
  severity: "error" | "warning" | "info"
  path?: string
  hint?: string
  source?: {
    file: string
    path: readonly (string | number)[]
  }
  [key: string]: unknown
}

export interface ThemeToolingReport {
  schemaVersion: "voyant.theme.tooling.v1"
  ok: boolean
  diagnostics: readonly ThemeDiagnostic[]
  [key: string]: unknown
}

export interface ThemeDevelopmentHandle {
  url: string
  close(): Promise<void>
}

export interface ThemeToolingOptions {
  projectRoot: string
  configFile?: string
}

export interface ThemeToolingModule {
  validateTheme?: (options: ThemeToolingOptions) => Promise<ThemeToolingReport>
  buildTheme?: (
    options: ThemeToolingOptions & { output?: "inherit" | "silent" },
  ) => Promise<ThemeToolingReport>
  developTheme?: (
    options: ThemeToolingOptions & {
      host: string
      port: number
    },
  ) => Promise<ThemeDevelopmentHandle>
}

/** Resolve theme tooling from the theme project so its pinned SDK controls behavior. */
export async function loadThemeTooling(projectRoot: string): Promise<ThemeToolingModule> {
  const projectRequire = createRequire(resolve(projectRoot, "package.json"))
  try {
    projectRequire.resolve(THEME_PACKAGE)
  } catch {
    throw new Error(
      `${THEME_PACKAGE} is not installed in the current theme project. Install the project's dependencies before running theme commands.`,
    )
  }

  let toolingEntry: string
  try {
    toolingEntry = projectRequire.resolve(TOOLING_PACKAGE)
  } catch {
    throw new Error(
      `The project-installed ${THEME_PACKAGE} does not provide its tooling export. Upgrade it before running theme commands.`,
    )
  }

  if (/\.[cm]?tsx?$/.test(toolingEntry)) {
    return loadProjectModule<ThemeToolingModule>(toolingEntry)
  }

  return import(pathToFileURL(toolingEntry).href) as Promise<ThemeToolingModule>
}

export function requireThemeToolingFunction<K extends keyof ThemeToolingModule>(
  tooling: ThemeToolingModule,
  name: K,
  command: string,
): NonNullable<ThemeToolingModule[K]> {
  const candidate = tooling[name]
  if (typeof candidate !== "function") {
    throw new Error(
      `The project-installed ${TOOLING_PACKAGE} does not export ${String(name)}(). Upgrade ${THEME_PACKAGE} before running \`voyant theme ${command}\`.`,
    )
  }
  return candidate as NonNullable<ThemeToolingModule[K]>
}

export function assertThemeToolingReport(value: unknown, command: string): ThemeToolingReport {
  if (!isRecord(value)) throw invalidReport(command)
  if (value.schemaVersion !== "voyant.theme.tooling.v1" || typeof value.ok !== "boolean") {
    throw invalidReport(command)
  }
  if (!Array.isArray(value.diagnostics) || !value.diagnostics.every(isThemeDiagnostic)) {
    throw invalidReport(command)
  }
  return value as ThemeToolingReport
}

export function assertThemeDevelopmentHandle(value: unknown): ThemeDevelopmentHandle {
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.close !== "function") {
    throw new Error(
      `The project-installed ${TOOLING_PACKAGE} returned an invalid development handle. Upgrade ${THEME_PACKAGE} before running \`voyant theme dev\`.`,
    )
  }
  return value as unknown as ThemeDevelopmentHandle
}

/** Read structured diagnostics from a project-tooling error without sharing its class identity. */
export function themeDiagnosticsFromError(value: unknown): readonly ThemeDiagnostic[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.diagnostics)) return undefined
  return value.diagnostics.every(isThemeDiagnostic) ? value.diagnostics : undefined
}

function isThemeDiagnostic(value: unknown): value is ThemeDiagnostic {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.severity === "error" || value.severity === "warning" || value.severity === "info") &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.hint === undefined || typeof value.hint === "string") &&
    (value.source === undefined || isDiagnosticSource(value.source))
  )
}

function isDiagnosticSource(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.file === "string" &&
    Array.isArray(value.path) &&
    value.path.every((part) => typeof part === "string" || typeof part === "number")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function invalidReport(command: string): Error {
  return new Error(
    `The project-installed ${TOOLING_PACKAGE} returned an invalid ${command} report. Upgrade ${THEME_PACKAGE} before running \`voyant theme ${command}\`.`,
  )
}
