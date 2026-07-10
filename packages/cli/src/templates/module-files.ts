export interface ModuleNames {
  kebab: string
  camel: string
  pascal: string
  packageName: string
}

export interface ModuleFacets {
  schema: boolean
  admin: boolean
  workflow: boolean
}

export function packageJson(names: ModuleNames, version: string, facets: ModuleFacets): string {
  const exports: Record<string, string> = {
    ".": "./src/index.ts",
    "./voyant": "./src/voyant.ts",
  }
  if (facets.schema) exports["./schema"] = "./src/schema.ts"
  if (facets.admin) exports["./admin"] = "./src/admin.ts"
  if (facets.workflow) exports["./workflows"] = "./src/workflows.ts"

  const dependencies: Record<string, string> = {
    "@voyant-travel/framework": `^${version}`,
  }
  if (facets.schema) dependencies["drizzle-orm"] = "^0.45.2"
  if (facets.admin) dependencies.hono = "^4.12.10"

  const voyant: Record<string, unknown> = {
    schemaVersion: "voyant.package.v1",
    kind: "module",
    manifest: "./voyant",
    compatibleWith: {
      framework: `>=${version}`,
      targets: ["node", "voyant-cloud"],
      modes: ["local", "managed-cloud", "self-hosted"],
    },
  }
  if (facets.schema) voyant.schema = "./schema"

  return `${JSON.stringify(
    {
      name: names.packageName,
      version: "0.0.1",
      private: true,
      type: "module",
      exports,
      voyant,
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "tsc --noEmit",
      },
      dependencies,
      devDependencies: {
        typescript: "^5.9.2",
      },
    },
    null,
    2,
  )}\n`
}

export function tsconfigJson(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        declaration: true,
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        outDir: "dist",
        rootDir: "src",
      },
      include: ["src/**/*.ts"],
    },
    null,
    2,
  )}\n`
}

export function voyantTs(names: ModuleNames, facets: ModuleFacets): string {
  const manifestLines = [
    `  id: "${names.packageName}",`,
    `  packageName: "${names.packageName}",`,
    `  localId: "${names.kebab}",`,
  ]
  if (facets.schema) {
    manifestLines.push(
      `  schema: [{ id: "${names.packageName}#schema", source: "${names.packageName}/schema" }],`,
    )
  }
  if (facets.admin) {
    manifestLines.push(`  api: [
    {
      id: "${names.packageName}#api.admin",
      surface: "admin",
      mount: "${names.kebab}",
      runtime: { entry: "${names.packageName}/admin", export: "${names.camel}AdminRoutes" },
    },
  ],`)
  }
  if (facets.workflow) {
    manifestLines.push(
      `  workflows: [{ id: "${names.packageName}#workflow.${names.kebab}", source: "${names.packageName}/workflows" }],`,
    )
  }

  return `import { defineModule } from "@voyant-travel/framework/project"

/** Import-cheap deployment declaration for the ${names.kebab} module. */
export const ${names.camel}VoyantModule = defineModule({
${manifestLines.join("\n")}
})

export default ${names.camel}VoyantModule
`
}

export function indexTs(names: ModuleNames, facets: ModuleFacets): string {
  const exports = [`export const ${names.camel}ModuleName = "${names.kebab}"`]
  if (facets.schema) exports.push(`export * from "./schema.js"`)
  if (facets.admin) exports.push(`export * from "./admin.js"`)
  if (facets.workflow) exports.push(`export * from "./workflows.js"`)
  return `${exports.join("\n")}\n`
}

export function schemaTs(names: ModuleNames): string {
  return `import { text } from "drizzle-orm/pg-core"
import { pgTable } from "drizzle-orm/pg-core"

export const ${names.camel} = pgTable("${names.kebab}", {
  id: text("id").primaryKey(),
})

export type ${names.pascal} = typeof ${names.camel}.$inferSelect
`
}

export function adminTs(names: ModuleNames): string {
  return `import { Hono } from "hono"

export const ${names.camel}AdminRoutes = new Hono()

${names.camel}AdminRoutes.get("/", (c) => c.json({ data: [] }))
`
}

export function workflowsTs(names: ModuleNames): string {
  return `export interface ${names.pascal}WorkflowInput {
  id: string
}

export async function run${names.pascal}Workflow(
  input: ${names.pascal}WorkflowInput,
): Promise<${names.pascal}WorkflowInput> {
  return input
}
`
}
