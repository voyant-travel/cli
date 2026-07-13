import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export function defineProject(project) {
  return project
}

export async function resolveProject({ project }) {
  const testDatabaseGraph = project.meta?.testDatabaseGraph === true
  const modules = normalizeUnits(project.modules ?? [], "module", testDatabaseGraph)
  if (project.meta?.testWebhookConvention === true) {
    modules.push({
      id: "fixture-project#qa-probe",
      kind: "module",
      packageName: "fixture-project",
      order: modules.length,
      provides: { capabilities: [], ports: [] },
      requires: { capabilities: [], ports: [] },
      api: [],
      schema: [],
      migrations: [],
      links: [],
      subscribers: [],
      events: [],
      workflows: [],
      meta: {
        source: "project-convention",
        sourcePath: "src/modules/qa-probe/index.ts",
      },
    })
  }
  const plugins = normalizeUnits(project.plugins ?? [], "plugin", false)
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
        ...(testDatabaseGraph
          ? [
              {
                path: "runtime/project-links.generated.ts",
                contents: `export const projectLinks = [{ left: { linkable: { module: "alpha", entity: "record", table: "alpha" }, isList: false }, right: { linkable: { module: "zeta", entity: "record", table: "zeta" }, isList: true }, tableName: "alpha_records_zeta_record", leftColumn: "alpha_record_id", rightColumn: "zeta_record_id", cardinality: "one-to-many", deleteCascade: false }]\n`,
              },
            ]
          : []),
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

export async function writeProjectArtifacts({ projectRoot, artifacts, mode = "write" }) {
  const files = [...artifacts.files].sort((left, right) => left.path.localeCompare(right.path))
  globalThis.__voyantFrameworkArtifactWrites?.push({ projectRoot, artifacts, mode })
  const results = []
  for (const file of files) {
    const target = join(projectRoot, ".voyant", file.path)
    let actual
    try {
      actual = await readFile(target, "utf8")
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    if (actual === file.contents) {
      results.push({ path: file.path, status: "unchanged" })
    } else if (mode === "check") {
      results.push({ path: file.path, status: actual === undefined ? "missing" : "stale" })
    } else {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.contents, "utf8")
      results.push({ path: file.path, status: "written" })
    }
  }
  return {
    mode,
    outputRoot: join(projectRoot, ".voyant"),
    ok: mode === "write" || results.every((file) => file.status === "unchanged"),
    files: results,
  }
}

function normalizeUnits(selections, kind, testDatabaseGraph) {
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
        schema: testDatabaseGraph
          ? [{ id: `${specifier}#schema`, source: `${specifier}/schema` }]
          : [],
        migrations: [],
        links: testDatabaseGraph
          ? [{ id: `${specifier}#link.standard`, source: `${specifier}/links`, export: "link" }]
          : [],
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
