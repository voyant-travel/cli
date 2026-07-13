export interface DeploymentGraphDiagnostic {
  code: string
  severity: "info" | "warning" | "error"
  source?: string
  facet?: string
  location?: string
  message: string
  hint?: string
}

export interface DeploymentGraphDoctorReport {
  schemaVersion: "voyant.graph-doctor-report.v1"
  ok: boolean
  graph: {
    schemaVersion: string
    contentHash: string
    target?: string
    mode?: string
    modules: { count: number; ids: readonly string[] }
    plugins: { count: number; ids: readonly string[] }
    packageRecords: { count: number; packageNames: readonly string[] }
  }
  diagnostics: readonly DeploymentGraphDiagnostic[]
}

const GRAPH_DOCTOR_REPORT_SCHEMA_VERSION = "voyant.graph-doctor-report.v1"
const SHA256_CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

export function parseDeploymentGraphDoctorReport(source: string): DeploymentGraphDoctorReport {
  const value = JSON.parse(source) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("deployment graph doctor report must be an object")
  }
  const report = value as Record<string, unknown>
  if (report.schemaVersion !== GRAPH_DOCTOR_REPORT_SCHEMA_VERSION) {
    throw new Error(
      `deployment graph doctor report schema must be ${GRAPH_DOCTOR_REPORT_SCHEMA_VERSION}, got ${String(
        report.schemaVersion,
      )}`,
    )
  }
  if (typeof report.ok !== "boolean") {
    throw new Error("deployment graph doctor report ok must be a boolean")
  }
  const graph = report.graph
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new Error("deployment graph doctor report graph must be an object")
  }
  const graphRecord = graph as Record<string, unknown>
  requireString(graphRecord.schemaVersion, "deployment graph doctor report graph.schemaVersion")
  requireSha256ContentHash(
    graphRecord.contentHash,
    "deployment graph doctor report graph.contentHash",
  )
  parseGraphDoctorCountList(graphRecord.modules, "modules", "ids")
  parseGraphDoctorCountList(graphRecord.plugins, "plugins", "ids")
  parseGraphDoctorCountList(graphRecord.packageRecords, "packageRecords", "packageNames")

  const diagnostics = arrayOfRecords(
    report.diagnostics,
    "deployment graph doctor report diagnostics",
  ).map((diagnostic, index) => parseDeploymentGraphDiagnostic(diagnostic, index))

  return {
    schemaVersion: GRAPH_DOCTOR_REPORT_SCHEMA_VERSION,
    ok: report.ok,
    graph: graphRecord as DeploymentGraphDoctorReport["graph"],
    diagnostics,
  }
}

export function formatDeploymentGraphDiagnostic(diagnostic: DeploymentGraphDiagnostic): string {
  const suffix = [
    diagnostic.source ? `source=${diagnostic.source}` : undefined,
    diagnostic.facet ? `facet=${diagnostic.facet}` : undefined,
    diagnostic.location ? `location=${diagnostic.location}` : undefined,
  ]
    .filter(Boolean)
    .join(", ")
  return `${diagnostic.code}: ${diagnostic.message}${suffix ? ` (${suffix})` : ""}${
    diagnostic.hint ? ` Hint: ${diagnostic.hint}` : ""
  }`
}

function parseGraphDoctorCountList(
  value: unknown,
  label: string,
  listField: "ids" | "packageNames",
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`deployment graph doctor report graph.${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.count !== "number") {
    throw new Error(`deployment graph doctor report graph.${label}.count must be a number`)
  }
  collectStringArray(
    record[listField],
    `deployment graph doctor report graph.${label}.${listField}`,
  )
}

function parseDeploymentGraphDiagnostic(
  value: Record<string, unknown>,
  index: number,
): DeploymentGraphDiagnostic {
  const severity = requireString(
    value.severity,
    `deployment graph doctor report diagnostics[${index}].severity`,
  )
  if (severity !== "info" && severity !== "warning" && severity !== "error") {
    throw new Error(
      `deployment graph doctor report diagnostics[${index}].severity must be info, warning, or error`,
    )
  }
  const diagnostic: DeploymentGraphDiagnostic = {
    code: requireString(value.code, `deployment graph doctor report diagnostics[${index}].code`),
    severity,
    message: requireString(
      value.message,
      `deployment graph doctor report diagnostics[${index}].message`,
    ),
  }
  const source = stringField(value, "source")
  const facet = stringField(value, "facet")
  const location = stringField(value, "location")
  const hint = stringField(value, "hint")
  if (source) diagnostic.source = source
  if (facet) diagnostic.facet = facet
  if (location) diagnostic.location = location
  if (hint) diagnostic.hint = hint
  return diagnostic
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`${label} must be a non-empty string`)
}

function requireSha256ContentHash(value: unknown, label: string): string {
  const hash = requireString(value, label)
  if (SHA256_CONTENT_HASH_PATTERN.test(hash)) return hash
  throw new Error(`${label} must match sha256:<64 lowercase hex chars>, got ${hash}`)
}

function arrayOfRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((entry, index) => {
    if (entry && typeof entry === "object") return entry as Record<string, unknown>
    throw new Error(`${label}[${index}] must be an object`)
  })
}

function collectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`))
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === "string" ? value : undefined
}
