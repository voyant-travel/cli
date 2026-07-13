import { join } from "node:path"

import { checkProjectArtifacts } from "./project-artifacts.js"
import type { ResolvedProjectGraph } from "./project-resolution.js"

const PROJECT_SCHEMA_VERSION = "voyant.project.v1"
const PROJECT_LINKS_ARTIFACT = "runtime/project-links.generated.ts"
export const GENERATED_PROJECT_LINK_SCHEMA = "./drizzle.links.generated.ts"

export interface ProjectDatabaseArtifacts {
  projectRoot: string
  graph: ResolvedProjectGraph
  packageNames: readonly string[]
  schemaSources: readonly string[]
  projectLinkCount: number
  projectLinksPath?: string
}

export async function resolveProjectDatabaseArtifacts(
  cwd: string,
  config: unknown,
  configPath?: string,
): Promise<ProjectDatabaseArtifacts | null> {
  if (!isRecord(config) || config.schemaVersion !== PROJECT_SCHEMA_VERSION) return null

  const checked = await checkProjectArtifacts(cwd, { configPath })
  const graph = checked.graph
  const units = collectGraphUnits(graph)
  const schemaSources = uniqueStrings(
    units.flatMap((unit, unitIndex) =>
      recordArray(unit.schema, `resolved graph unit[${unitIndex}].schema`).map((schema, index) =>
        requireString(schema.source, `resolved graph unit[${unitIndex}].schema[${index}].source`),
      ),
    ),
  )
  const packageNames = uniqueStrings(
    recordArray(graph.packageRecords, "resolved graph packageRecords").map((record, index) =>
      requireString(record.packageName, `resolved graph packageRecords[${index}].packageName`),
    ),
  )
  const projectLinkCount = units.reduce(
    (count, unit, unitIndex) =>
      count +
      recordArray(unit.links, `resolved graph unit[${unitIndex}].links`).filter(
        (link) => typeof link.export === "string" && link.export.length > 0,
      ).length,
    0,
  )
  if (projectLinkCount === 0) {
    return {
      projectRoot: checked.projectRoot,
      graph,
      packageNames,
      schemaSources,
      projectLinkCount,
    }
  }
  if (!checked.manifest.files.includes(PROJECT_LINKS_ARTIFACT)) {
    throw new Error(
      `Resolved graph selects ${projectLinkCount} project link definition(s), but ${PROJECT_LINKS_ARTIFACT} is absent from project artifacts`,
    )
  }
  return {
    projectRoot: checked.projectRoot,
    graph,
    packageNames,
    schemaSources,
    projectLinkCount,
    projectLinksPath: join(checked.artifactRoot, PROJECT_LINKS_ARTIFACT),
  }
}

function collectGraphUnits(graph: ResolvedProjectGraph): Record<string, unknown>[] {
  return [
    ...recordArray(graph.modules, "resolved graph modules"),
    ...recordArray(graph.extensions, "resolved graph extensions"),
    ...recordArray(graph.plugins, "resolved graph plugins"),
  ]
}

function recordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${label}[${index}] must be an object`)
    return entry
  })
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
