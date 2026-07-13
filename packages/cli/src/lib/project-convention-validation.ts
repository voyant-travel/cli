import { readFile } from "node:fs/promises"
import path from "node:path"

import ts from "typescript"

import type { ResolvedProjectGraph } from "./project-resolution.js"

const PROJECT_CONVENTION_SOURCE = "project-convention"

export class ProjectConventionValidationError extends Error {
  readonly code = "project_convention_invalid"

  constructor(message: string) {
    super(message)
    this.name = "ProjectConventionValidationError"
  }
}

/** Validate runtime-only module conventions against graph-governed route posture. */
export async function validateProjectRuntimeConventions(
  projectRoot: string,
  graph: ResolvedProjectGraph,
): Promise<void> {
  const inboundUnitIds = inboundWebhookUnitIds(graph)
  const diagnostics: string[] = []

  for (const unit of graphUnits(graph)) {
    const sourcePath = projectConventionSourcePath(unit)
    if (!sourcePath || inboundUnitIds.has(requireString(unit.id))) continue

    const absolutePath = path.resolve(projectRoot, sourcePath)
    const relativePath = path.relative(projectRoot, absolutePath)
    if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) continue

    const source = await readFile(absolutePath, "utf8")
    if (!declaresWebhookRoutes(source, absolutePath)) continue

    diagnostics.push(webhookDeclarationDiagnostic(requireString(unit.id), sourcePath))
  }

  if (diagnostics.length > 0) {
    throw new ProjectConventionValidationError(diagnostics.join("\n\n"))
  }
}

function declaresWebhookRoutes(source: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node)) &&
      propertyName(node.name) === "webhookRoutes"
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return undefined
}

function inboundWebhookUnitIds(graph: ResolvedProjectGraph): Set<string> {
  const webhookPlan = record(graph.webhookPlan)
  const inbound = Array.isArray(webhookPlan?.inbound) ? webhookPlan.inbound : []
  return new Set(
    inbound.flatMap((entry) => {
      const unitId = record(entry)?.apiUnitId
      return typeof unitId === "string" && unitId.length > 0 ? [unitId] : []
    }),
  )
}

function graphUnits(graph: ResolvedProjectGraph): Record<string, unknown>[] {
  return [graph.modules, graph.extensions, graph.plugins].flatMap((units) =>
    Array.isArray(units) ? units.flatMap((unit) => (record(unit) ? [unit] : [])) : [],
  ) as Record<string, unknown>[]
}

function projectConventionSourcePath(unit: Record<string, unknown>): string | undefined {
  const meta = record(unit.meta)
  if (meta?.source !== PROJECT_CONVENTION_SOURCE) return undefined
  return typeof meta.sourcePath === "string" && meta.sourcePath.length > 0
    ? meta.sourcePath
    : undefined
}

function webhookDeclarationDiagnostic(unitId: string, sourcePath: string): string {
  return [
    `PROJECT_WEBHOOK_DECLARATION_REQUIRED: "${sourcePath}" returns webhookRoutes, but graph unit "${unitId}" has no inbound webhook declaration.`,
    "Direct src/modules and src/extensions conventions are runtime-only and cannot declare graph webhook facets.",
    "Move the runtime to a project-owned workspace package, select it in voyant.config.ts, and declare both facets in that package's voyant.ts:",
    '  api: [{ id: "@acme/qa-probe#api.webhook", surface: "webhook", mount: "qa-probe", runtime: { entry: "@acme/qa-probe", export: "default" } }],',
    '  webhooks: [{ id: "@acme/qa-probe#webhook.inbound", direction: "inbound", apiId: "@acme/qa-probe#api.webhook" }]',
  ].join("\n")
}

function requireString(value: unknown): string {
  return typeof value === "string" ? value : "(unknown)"
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
