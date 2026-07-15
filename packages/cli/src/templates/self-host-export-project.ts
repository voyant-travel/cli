import { readFileSync } from "node:fs"

import type {
  VoyantSelfHostExportValidationIssue,
  VoyantSelfHostProjection,
} from "@voyant-travel/framework/self-host-export"

import { renderProjectConfig } from "../lib/project-config.js"
import { compareCodeUnits } from "../lib/strings.js"

type JsonPrimitive = boolean | null | number | string
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type SelfHostExportValidationIssue = VoyantSelfHostExportValidationIssue
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

type SelfHostProjectSelection = VoyantSelfHostProjection["project"]["modules"][number]
type SelfHostPackageRecord = VoyantSelfHostProjection["graph"]["packageRecords"][number]
type SelfHostStarter = VoyantSelfHostProjection["starter"]

export type SelfHostProjection = Pick<
  VoyantSelfHostProjection,
  | "schemaVersion"
  | "ready"
  | "frameworkVersion"
  | "sourceGraphHash"
  | "projectedGraphHash"
  | "starter"
  | "project"
  | "providerRemaps"
  | "provisioning"
  | "migrationJournal"
  | "diagnostics"
> & {
  graph: Pick<VoyantSelfHostProjection["graph"], "packageRecords">
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
  assertNoSerializedSecrets(projection)

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

  const rootFiles = [...starter.rootFiles].sort(compareCodeUnits)
  if (
    JSON.stringify(rootFiles) !== JSON.stringify([...REQUIRED_ROOT_FILES].sort(compareCodeUnits))
  ) {
    throw new Error("The self-host projection contains an unsupported standard starter root shape.")
  }
}

function projectPackageJson(name: string, projection: SelfHostProjection): string {
  const coordinates = packageCoordinates(projection)
  const developmentNames = new Set<string>(projection.starter.developmentDependencies)
  const dependencies = new Map<string, string>()
  const devDependencies = new Map<string, string>()

  for (const [packageName, coordinate] of coordinates) {
    const target = developmentNames.has(packageName) ? devDependencies : dependencies
    target.set(packageName, coordinate)
  }

  for (const packageName of projection.starter.runtimeDependencies) {
    if (dependencies.has(packageName)) continue
    const coordinate =
      packageName === "@voyant-travel/framework"
        ? exactRegistryVersion(packageName, projection.frameworkVersion)
        : coordinates.get(packageName)
    if (!coordinate) throw missingStarterCoordinate(packageName)
    dependencies.set(packageName, coordinate)
  }
  for (const packageName of projection.starter.developmentDependencies) {
    if (devDependencies.has(packageName)) continue
    const coordinate =
      packageName === "@voyant-travel/cli"
        ? exactRegistryVersion(packageName, readCliPackageVersion())
        : coordinates.get(packageName)
    if (!coordinate) throw missingStarterCoordinate(packageName)
    devDependencies.set(packageName, coordinate)
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
    compareCodeUnits(left.packageName, right.packageName),
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
    coordinates.set(
      "@voyant-travel/framework",
      exactRegistryVersion("@voyant-travel/framework", projection.frameworkVersion),
    )
  }
  return coordinates
}

function packageCoordinate(record: SelfHostPackageRecord): string {
  if (record.source.kind === "registry" && record.version) {
    return exactRegistryVersion(record.packageName, record.version)
  }
  if (
    record.source.kind === "git" &&
    record.source.reference &&
    /#[0-9a-f]{7,64}$/i.test(record.source.reference)
  ) {
    return record.source.reference
  }
  throw new Error(
    `Package ${record.packageName} has no exact installable ${record.source.kind} coordinate.`,
  )
}

function exactRegistryVersion(packageName: string, version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(
      `Package ${packageName} has non-exact registry coordinate ${JSON.stringify(version)}.`,
    )
  }
  return version
}

function missingStarterCoordinate(packageName: string): Error {
  return new Error(
    `Starter dependency ${packageName} has no exact coordinate in the self-host projection graph.`,
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

  return renderProjectConfig(config)
}

function projectSelections(
  selections: readonly SelfHostProjectSelection[],
): Array<{ resolve: string; config?: Record<string, JsonValue> }> {
  return selections.map((selection) => ({
    resolve: selection.resolve,
    ...(selection.config === undefined ? {} : { config: normalizeJsonRecord(selection.config) }),
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
    .sort(compareCodeUnits)
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
    compareCodeUnits(left.role, right.role),
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
    compareCodeUnits(left.resourceKey, right.resourceKey),
  )) {
    const requirement = resource.required ? "required" : "optional"
    lines.push(
      `### \`${resource.resourceKey}\``,
      "",
      `- [ ] Provision the ${requirement} \`${resource.provider}\` resource for ${[
        ...resource.roles,
      ]
        .sort(compareCodeUnits)
        .map((role) => `\`${role}\``)
        .join(", ")}.`,
    )
    for (const env of [...resource.env].sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    )) {
      lines.push(
        `- [ ] Set ${env.required ? "required" : "optional"} ${env.kind} \`${env.name}\`: ${env.description}`,
      )
    }
    if (resource.notes) lines.push(`- [ ] Review provider note: ${resource.notes}`)
    lines.push("")
  }

  const database = projection.provisioning.database
  const journal = projection.migrationJournal
  lines.push(
    "## Migration Journal Lineage",
    "",
    `Schema: \`${journal.schemaVersion}\``,
    `Ledger: \`${journal.ledgerSchema}.${journal.ledgerTable}\``,
    `Identity columns: ${journal.identityColumns.map((column) => `\`${column}\``).join(", ")}`,
    `Content hash column: \`${journal.contentHashColumn}\``,
    "",
    "## Restore Data",
    "",
    `- [ ] Verify and restore the ${database.engine} ${database.format} dump at \`${database.dump.path}\` (${database.dump.byteLength} bytes, \`${database.dump.contentHash}\`).`,
  )
  const objects = [...projection.provisioning.objectStorage.objects].sort((left, right) =>
    compareCodeUnits(`${left.logicalStore}\0${left.key}`, `${right.logicalStore}\0${right.key}`),
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
    `- [ ] Confirm the restored database retains the \`${journal.ledgerSchema}.${journal.ledgerTable}\` journal and its source/tag/content-hash lineage.`,
    "- [ ] Do not replay migrations already represented in the restored journal; restore first, then let the normal migration command apply only later migrations.",
    "- [ ] Stop on missing journal rows, content-hash mismatches, or schema drift. Re-export or reconcile the source database instead of baselining over unexplained drift.",
    "- [ ] Run `pnpm exec voyant doctor`, then build and boot the Node application before cutover.",
    "",
    "Supply all secret values through the deployment secret manager. No secret values are stored in this project.",
    "",
  )
  return lines.join("\n")
}

function normalizeJson(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, entry]) => [key, normalizeJson(entry)]),
    )
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value
  }
  throw new Error(`Projected config contains a non-JSON value of type ${typeof value}.`)
}

function normalizeJsonRecord(value: Readonly<Record<string, unknown>>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [key, normalizeJson(entry)]),
  )
}

function sortedRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => compareCodeUnits(left, right)),
  )
}

function sortedEntries(map: ReadonlyMap<string, string>): Array<[string, string]> {
  return [...map.entries()].sort(([left], [right]) => compareCodeUnits(left, right))
}

const SECRET_CONFIG_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "connectionstring",
  "credentials",
  "databaseurl",
  "dsn",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "signingkey",
  "token",
])

function assertNoSerializedSecrets(projection: SelfHostProjection): void {
  for (const collection of ["modules", "extensions", "plugins"] as const) {
    for (const [index, selection] of projection.project[collection].entries()) {
      if (selection.config !== undefined) {
        assertNoSecretValue(selection.config, `$.project.${collection}[${index}].config`)
      }
    }
  }
  if (projection.project.deployment.migrations) {
    assertNoSecretValue(projection.project.deployment.migrations, "$.project.deployment.migrations")
  }
}

function assertNoSecretValue(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertNoSecretValue(entry, `${path}[${index}]`)
    }
    return
  }
  if (!value || typeof value !== "object") return

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase()
    if (SECRET_CONFIG_KEYS.has(normalizedKey) && entry !== "" && entry !== null) {
      throw new Error(
        `Refusing to serialize secret-bearing config at ${entryPath}. Supply secrets through deployment environment requirements instead.`,
      )
    }
    assertNoSecretValue(entry, entryPath)
  }
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
