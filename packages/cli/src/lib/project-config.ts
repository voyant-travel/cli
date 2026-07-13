export type ProjectSelection = string | { resolve: string; config?: Record<string, unknown> }

export interface AuthoringProjectConfig {
  schemaVersion?: "voyant.project.v1"
  presetLineage?: string
  modules: ProjectSelection[]
  plugins: ProjectSelection[]
  meta?: Record<string, unknown>
}

const CONFIG_PREFIX = `import { defineProject } from "@voyant-travel/framework/project"

// Kept JSON-compatible so Voyant CLI authoring commands can update selections safely.
export default defineProject(
`

const CONFIG_SUFFIX = `)
`

export function renderProjectConfig(config: AuthoringProjectConfig): string {
  return `${CONFIG_PREFIX}${JSON.stringify(config, null, 2)}\n${CONFIG_SUFFIX}`
}

export function writeProjectConfig(path: string, source: string): void {
  parseProjectConfig(source)
  const temporaryPath = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporaryPath, source, { mode: statSync(path).mode })
    renameSync(temporaryPath, path)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

export function parseProjectConfig(source: string): AuthoringProjectConfig {
  if (!source.startsWith(CONFIG_PREFIX) || !source.endsWith(CONFIG_SUFFIX)) {
    throw new Error(
      "config is not in the CLI-managed defineProject format; edit its modules/plugins explicitly",
    )
  }

  const json = source.slice(CONFIG_PREFIX.length, -CONFIG_SUFFIX.length).trim()
  const value: unknown = JSON.parse(json)
  if (!isRecord(value) || !Array.isArray(value.modules) || !Array.isArray(value.plugins)) {
    throw new Error("config must contain modules and plugins arrays")
  }
  if (!value.modules.every(isProjectSelection) || !value.plugins.every(isProjectSelection)) {
    throw new Error("modules and plugins must contain strings or { resolve, config } selections")
  }

  return value as unknown as AuthoringProjectConfig
}

export function selectionResolve(selection: ProjectSelection): string {
  return typeof selection === "string" ? selection : selection.resolve
}

export function cloneProjectConfig(config: AuthoringProjectConfig): AuthoringProjectConfig {
  return structuredClone(config)
}

export function addProjectSelection(
  config: AuthoringProjectConfig,
  kind: "module" | "plugin",
  selection: ProjectSelection,
): boolean {
  const selections = kind === "module" ? config.modules : config.plugins
  const resolve = selectionResolve(selection)
  if (selections.some((entry) => selectionResolve(entry) === resolve)) return false
  selections.push(selection)
  return true
}

export function removeProjectSelection(
  config: AuthoringProjectConfig,
  kind: "module" | "plugin",
  resolve: string,
): boolean {
  const selections = kind === "module" ? config.modules : config.plugins
  const index = selections.findIndex((entry) => selectionResolve(entry) === resolve)
  if (index === -1) return false
  selections.splice(index, 1)
  return true
}

function isProjectSelection(value: unknown): value is ProjectSelection {
  if (typeof value === "string") return value.length > 0
  if (!isRecord(value) || typeof value.resolve !== "string" || value.resolve.length === 0) {
    return false
  }
  return value.config === undefined || isRecord(value.config)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

import { existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
