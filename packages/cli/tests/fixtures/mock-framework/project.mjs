import { createHash } from "node:crypto"

export function defineProject(project) {
  return project
}

export async function resolveProject({ project }) {
  const modules = normalizeUnits(project.modules ?? [], "module")
  const plugins = normalizeUnits(project.plugins ?? [], "plugin")
  const graphWithoutHash = {
    schemaVersion: "voyant.resolved-graph.v1",
    project: project.presetLineage ? { presetLineage: project.presetLineage } : {},
    deployment: { providers: {} },
    requirements: { resources: [] },
    modules,
    plugins,
    capabilities: { provided: [], required: [] },
    packageRecords: [...modules, ...plugins].map((unit) => ({
      packageName: unit.packageName,
      version: "0.0.0-test",
      source: { kind: unit.packageName.startsWith("./") ? "file" : "registry" },
    })),
    provisioning: { scheduledJobs: [] },
    diagnostics: [],
  }
  const contentHash = `sha256:${createHash("sha256")
    .update(canonicalJson(graphWithoutHash))
    .digest("hex")}`
  const graph = { ...graphWithoutHash, contentHash }

  return {
    graph,
    artifacts: {
      runtimeEntry: "runtime/project-runtime.generated.ts",
      migrationRunner: "runtime/project-migrations.generated.mjs",
      files: [
        {
          path: "runtime/project-migrations.generated.mjs",
          contents: `export const schemaVersion = "voyant.node-migration-runner.v1"\nexport const contentHash = ${JSON.stringify(contentHash)}\nexport async function runVoyantMigrations(options = {}) { return globalThis.__runVoyantMigrations?.(options) ?? { schemaVersion: "voyant.migration-result.v1", contentHash, applied: [], skipped: [], failed: [] } }\n`,
        },
        {
          path: "runtime/project-runtime.generated.ts",
          contents: `// GENERATED test runtime for ${contentHash}\nexport const contentHash = ${JSON.stringify(contentHash)}\n`,
        },
      ],
      migrationPlan: {
        schemaVersion: "voyant.migration-plan.v1",
        contentHash,
        migrations: modules.map((unit, order) => ({
          id: `${unit.id}#migration.initial`,
          migrationKind: "schema",
          order,
          idempotencyKey: `schema:${unit.id}#migration.initial`,
          owner: unit.id,
          packageName: unit.packageName,
          source: { kind: "package", packageName: unit.packageName, path: "./migrations" },
        })),
      },
    },
  }
}

function normalizeUnits(selections, kind) {
  return selections
    .map((selection) => {
      const specifier = typeof selection === "string" ? selection : selection.resolve
      return {
        id: specifier,
        kind,
        packageName: specifier,
        order: 0,
        provides: { capabilities: [], ports: [] },
        requires: { capabilities: [], ports: [] },
        api: [],
        schema: [],
        migrations: [],
        links: [],
        subscribers: [],
        events: [],
        workflows: [],
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((unit, order) => ({ ...unit, order }))
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value) {
  if (value === undefined) return null
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}
