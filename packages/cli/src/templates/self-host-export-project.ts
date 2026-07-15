import { readFileSync } from "node:fs"

type JsonPrimitive = boolean | null | number | string
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface SelfHostExportValidationIssue {
  code: string
  path: string
  message: string
}

export type SelfHostExportValidationResult =
  | { ok: true; value: unknown; issues: readonly [] }
  | { ok: false; issues: readonly SelfHostExportValidationIssue[] }

export interface SelfHostExportApi {
  validateVoyantSelfHostExportBundle(input: unknown): Promise<SelfHostExportValidationResult>
  projectVoyantSelfHostExport(
    input: unknown,
    options?: { providerOverrides?: Readonly<Record<string, string>> },
  ): Promise<SelfHostProjection>
}

interface SelfHostProjectSelection {
  id: string
  resolve: string
  packageName: string
  version?: string
  config?: Record<string, JsonValue>
}

interface SelfHostPackageRecord {
  packageName: string
  version?: string
  source: {
    kind: string
    reference?: string
    integrity?: string
  }
}

interface SelfHostEnvRequirement {
  name: string
  aliases?: readonly string[]
  format?: string
  kind: "binding" | "secret" | "variable"
  required: boolean
  description: string
}

interface SelfHostResourceRequirement {
  resourceKey: string
  roles: readonly string[]
  provider: string
  required: boolean
  env: readonly SelfHostEnvRequirement[]
  notes?: string
}

interface SelfHostStarter {
  schemaVersion: string
  rootFiles: readonly string[]
  optionalDirectories: readonly string[]
  seedEntry: string
  deploymentTarget: string
  databaseProvider: string
  defaultPlugins: readonly unknown[]
  packageScripts: Readonly<Record<string, string>>
  runtimeDependencies: readonly string[]
  developmentDependencies: readonly string[]
  gitignoreEntries: readonly string[]
}

export interface SelfHostProjectionDiagnostic {
  code: string
  severity: "error"
  path: string
  message: string
  hint: string
}

export interface SelfHostProjection {
  schemaVersion: string
  ready: boolean
  frameworkVersion: string
  sourceGraphHash: string
  projectedGraphHash: string
  starter: SelfHostStarter
  project: {
    productBom: Record<string, JsonValue>
    modules: readonly SelfHostProjectSelection[]
    extensions: readonly SelfHostProjectSelection[]
    plugins: readonly SelfHostProjectSelection[]
    deployment: {
      target: "node"
      mode: "self-hosted"
      providers: Readonly<Record<string, string>>
      migrations?: readonly Record<string, JsonValue>[]
    }
  }
  graph: {
    packageRecords: readonly SelfHostPackageRecord[]
  }
  providerRemaps: readonly {
    role: string
    from: string
    to: string
    reason: "explicit-override" | "self-host-default"
  }[]
  provisioning: {
    resources: readonly SelfHostResourceRequirement[]
    database: {
      engine: string
      format: string
      dump: { path: string; byteLength: number; contentHash: string }
    }
    objectStorage: {
      objects: readonly {
        logicalStore: string
        key: string
        path: string
        byteLength: number
        contentHash: string
      }[]
    }
  }
  diagnostics: readonly SelfHostProjectionDiagnostic[]
}

export interface GeneratedSelfHostProject {
  files: ReadonlyMap<string, string>
  directories: readonly string[]
}

const REQUIRED_ROOT_FILES = [".env.example", ".gitignore", "package.json", "voyant.config.ts"]

export function selfHostExportProjectFiles(
  name: string,
  projection: SelfHostProjection,
): GeneratedSelfHostProject {
  validateStarter(projection.starter)

  const files = new Map<string, string>([
    ["package.json", projectPackageJson(name, projection)],
    ["voyant.config.ts", projectConfig(projection)],
    [".gitignore", `${projection.starter.gitignoreEntries.join("\n")}\n`],
    [".env.example", environmentExample(projection)],
    [projection.starter.seedEntry, 'console.info("Add project seed data here.")\n'],
    ["SELF_HOST_PROVISIONING.md", provisioningChecklist(projection)],
  ])

  for (const path of [...files.keys(), ...projection.starter.optionalDirectories]) {
    assertPortableRelativePath(path)
  }

  return {
    files,
    directories: [...projection.starter.optionalDirectories],
  }
}

function validateStarter(starter: SelfHostStarter): void {
  if (starter.schemaVersion !== "voyant.node-starter.v2") {
    throw new Error(
      `Unsupported starter schema ${JSON.stringify(starter.schemaVersion)}. Expected voyant.node-starter.v2.`,
    )
  }

  const rootFiles = [...starter.rootFiles].sort()
  if (JSON.stringify(rootFiles) !== JSON.stringify([...REQUIRED_ROOT_FILES].sort())) {
    throw new Error("The self-host projection contains an unsupported standard starter root shape.")
  }
}

function projectPackageJson(name: string, projection: SelfHostProjection): string {
  const coordinates = packageCoordinates(projection)
  const developmentNames = new Set(projection.starter.developmentDependencies)
  const dependencies = new Map<string, string>()
  const devDependencies = new Map<string, string>()

  for (const [packageName, coordinate] of coordinates) {
    const target = developmentNames.has(packageName) ? devDependencies : dependencies
    target.set(packageName, coordinate)
  }

  for (const packageName of projection.starter.runtimeDependencies) {
    if (dependencies.has(packageName)) continue
    dependencies.set(
      packageName,
      packageName === "@voyant-travel/framework" ? projection.frameworkVersion : "latest",
    )
  }
  for (const packageName of projection.starter.developmentDependencies) {
    if (devDependencies.has(packageName)) continue
    devDependencies.set(
      packageName,
      packageName === "@voyant-travel/cli" ? readCliPackageVersion() : "latest",
    )
  }

  return `${JSON.stringify(
    {
      name,
      version: "0.0.1",
      private: true,
      license: "Apache-2.0",
      type: "module",
      scripts: sortedRecord(projection.starter.packageScripts),
      dependencies: Object.fromEntries(sortedEntries(dependencies)),
      devDependencies: Object.fromEntries(sortedEntries(devDependencies)),
      packageManager: "pnpm@9.0.0",
    },
    null,
    2,
  )}\n`
}

function packageCoordinates(projection: SelfHostProjection): Map<string, string> {
  const coordinates = new Map<string, string>()
  const records = [...projection.graph.packageRecords].sort((left, right) =>
    left.packageName.localeCompare(right.packageName),
  )

  for (const record of records) {
    const coordinate = packageCoordinate(record)
    const previous = coordinates.get(record.packageName)
    if (previous && previous !== coordinate) {
      throw new Error(
        `Package ${record.packageName} has conflicting admitted coordinates ${previous} and ${coordinate}.`,
      )
    }
    coordinates.set(record.packageName, coordinate)
  }

  if (!coordinates.has("@voyant-travel/framework")) {
    coordinates.set("@voyant-travel/framework", projection.frameworkVersion)
  }
  return coordinates
}

function packageCoordinate(record: SelfHostPackageRecord): string {
  if (record.source.kind === "registry" && record.version) return record.version
  if (record.source.kind === "git" && record.source.reference) return record.source.reference
  throw new Error(
    `Package ${record.packageName} has no exact installable ${record.source.kind} coordinate.`,
  )
}

function projectConfig(projection: SelfHostProjection): string {
  const project = projection.project
  const deployment = {
    target: project.deployment.target,
    mode: project.deployment.mode,
    providers: sortedRecord(project.deployment.providers),
    ...(project.deployment.migrations
      ? { migrations: normalizeJson(project.deployment.migrations) }
      : {}),
  }
  const config = {
    productBom: normalizeJson(project.productBom),
    modules: projectSelections(project.modules),
    extensions: projectSelections(project.extensions),
    plugins: projectSelections(project.plugins),
    deployment,
  }

  return `import { defineProject } from "@voyant-travel/framework/project"

export default defineProject(${JSON.stringify(config, null, 2)})
`
}

function projectSelections(
  selections: readonly SelfHostProjectSelection[],
): Array<{ resolve: string; config?: JsonValue }> {
  return selections.map((selection) => ({
    resolve: selection.resolve,
    ...(selection.config === undefined ? {} : { config: normalizeJson(selection.config) }),
  }))
}

function environmentExample(projection: SelfHostProjection): string {
  const names = new Set<string>(["PORT"])
  for (const resource of projection.provisioning.resources) {
    for (const requirement of resource.env) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(requirement.name)) {
        throw new Error(`Invalid environment requirement name: ${requirement.name}`)
      }
      names.add(requirement.name)
    }
  }

  return `${[...names]
    .sort()
    .map((name) => `${name}=${name === "PORT" ? "8080" : ""}`)
    .join("\n")}\n`
}

function provisioningChecklist(projection: SelfHostProjection): string {
  const lines = [
    "# Self-host Provisioning",
    "",
    `Source graph: \`${projection.sourceGraphHash}\``,
    `Projected graph: \`${projection.projectedGraphHash}\``,
    "",
    "## Provider Remaps",
    "",
  ]

  const remaps = [...projection.providerRemaps].sort((left, right) =>
    left.role.localeCompare(right.role),
  )
  if (remaps.length === 0) {
    lines.push("- [ ] No provider remaps were required.")
  } else {
    for (const remap of remaps) {
      lines.push(`- [ ] \`${remap.role}\`: \`${remap.from}\` to \`${remap.to}\` (${remap.reason}).`)
    }
  }

  lines.push("", "## Resources", "")
  for (const resource of [...projection.provisioning.resources].sort((left, right) =>
    left.resourceKey.localeCompare(right.resourceKey),
  )) {
    const requirement = resource.required ? "required" : "optional"
    lines.push(
      `### \`${resource.resourceKey}\``,
      "",
      `- [ ] Provision the ${requirement} \`${resource.provider}\` resource for ${resource.roles.map((role) => `\`${role}\``).join(", ")}.`,
    )
    for (const env of [...resource.env].sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      lines.push(
        `- [ ] Set ${env.required ? "required" : "optional"} ${env.kind} \`${env.name}\`: ${env.description}`,
      )
    }
    if (resource.notes) lines.push(`- [ ] Review provider note: ${resource.notes}`)
    lines.push("")
  }

  const database = projection.provisioning.database
  lines.push(
    "## Restore Data",
    "",
    `- [ ] Verify and restore the ${database.engine} ${database.format} dump at \`${database.dump.path}\` (${database.dump.byteLength} bytes, \`${database.dump.contentHash}\`).`,
  )
  const objects = [...projection.provisioning.objectStorage.objects].sort((left, right) =>
    `${left.logicalStore}\0${left.key}`.localeCompare(`${right.logicalStore}\0${right.key}`),
  )
  for (const object of objects) {
    lines.push(
      `- [ ] Restore \`${object.path}\` to \`${object.logicalStore}/${object.key}\` (${object.byteLength} bytes, \`${object.contentHash}\`).`,
    )
  }
  lines.push(
    "",
    "## Verify",
    "",
    "- [ ] Install dependencies and resolve a clean project graph.",
    "- [ ] Restore the database and object storage before applying new migrations.",
    "- [ ] Run `pnpm exec voyant doctor`, then build and boot the Node application before cutover.",
    "",
    "Supply all secret values through the deployment secret manager. No secret values are stored in this project.",
    "",
  )
  return lines.join("\n")
}

function normalizeJson(value: JsonValue | readonly Record<string, JsonValue>[]): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry as JsonValue))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeJson(entry)]),
    )
  }
  return value as JsonPrimitive
}

function sortedRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function sortedEntries(map: ReadonlyMap<string, string>): Array<[string, string]> {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right))
}

function assertPortableRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.split(/[\\/]/).some((part) => part === "..")
  ) {
    throw new Error(`Starter path must be project-relative: ${path}`)
  }
}

function readCliPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown }
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Could not read the @voyant-travel/cli package version")
  }
  return packageJson.version
}
