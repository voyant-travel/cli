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
  const helpers = deploymentHelperNames(sourceFile)
  const bindings = topLevelBindings(sourceFile)
  return sourceFile.statements.some(
    (statement) =>
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      exportedDeploymentDeclaresWebhookRoutes(statement.expression, helpers, bindings, new Set()),
  )
}

interface TopLevelBindings {
  values: ReadonlyMap<string, ts.Expression>
  functions: ReadonlyMap<string, ts.FunctionDeclaration>
}

function deploymentHelperNames(sourceFile: ts.SourceFile): Set<string> {
  const helpers = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@voyant-travel/framework" ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue
    }
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      if (imported === "defineDeploymentModule" || imported === "defineDeploymentExtension") {
        helpers.add(element.name.text)
      }
    }
  }
  return helpers
}

function topLevelBindings(sourceFile: ts.SourceFile): TopLevelBindings {
  const values = new Map<string, ts.Expression>()
  const functions = new Map<string, ts.FunctionDeclaration>()
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          values.set(declaration.name.text, declaration.initializer)
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement)
    }
  }
  return { values, functions }
}

function exportedDeploymentDeclaresWebhookRoutes(
  expression: ts.Expression,
  helpers: ReadonlySet<string>,
  bindings: TopLevelBindings,
  visited: Set<string>,
): boolean {
  const value = unwrapExpression(expression)
  if (ts.isIdentifier(value)) {
    if (visited.has(value.text)) return false
    const bound = bindings.values.get(value.text)
    if (!bound) return false
    visited.add(value.text)
    return exportedDeploymentDeclaresWebhookRoutes(bound, helpers, bindings, visited)
  }
  if (
    !ts.isCallExpression(value) ||
    !ts.isIdentifier(value.expression) ||
    !helpers.has(value.expression.text)
  ) {
    return false
  }
  const declaration = value.arguments[0]
  return Boolean(
    declaration && declarationReturnsWebhookRoutes(declaration, bindings, new Set(visited)),
  )
}

function declarationReturnsWebhookRoutes(
  expression: ts.Expression,
  bindings: TopLevelBindings,
  visited: Set<string>,
): boolean {
  const value = unwrapExpression(expression)
  if (ts.isObjectLiteralExpression(value)) return objectDeclaresWebhookRoutes(value)
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return functionBodyReturnsWebhookRoutes(value.body, bindings, visited)
  }
  if (!ts.isIdentifier(value) || visited.has(value.text)) return false
  visited.add(value.text)
  const bound = bindings.values.get(value.text)
  if (bound) return declarationReturnsWebhookRoutes(bound, bindings, visited)
  const declaration = bindings.functions.get(value.text)
  return declaration?.body
    ? functionBodyReturnsWebhookRoutes(declaration.body, bindings, visited)
    : false
}

function functionBodyReturnsWebhookRoutes(
  body: ts.ConciseBody,
  bindings: TopLevelBindings,
  visited: Set<string>,
): boolean {
  if (!ts.isBlock(body)) return declarationReturnsWebhookRoutes(body, bindings, visited)
  return body.statements.some(
    (statement) =>
      ts.isReturnStatement(statement) &&
      Boolean(
        statement.expression &&
          declarationReturnsWebhookRoutes(statement.expression, bindings, new Set(visited)),
      ),
  )
}

function objectDeclaresWebhookRoutes(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property) ||
        ts.isMethodDeclaration(property)) &&
      propertyName(property.name) === "webhookRoutes",
  )
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
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
