export interface ModuleNames {
  /** Kebab-case name (e.g. "invoices"). Used for directory + package slug. */
  kebab: string
  /** camelCase name (e.g. "invoices"). Used for variable names. */
  camel: string
  /** PascalCase name (e.g. "Invoices"). Used for type names + exports. */
  pascal: string
}

export function packageJson(names: ModuleNames, version: string): string {
  const body = {
    name: `@voyant-travel/${names.kebab}`,
    version,
    type: "module",
    exports: {
      ".": "./src/index.ts",
      "./schema": "./src/schema.ts",
      "./validation": "./src/validation.ts",
      "./routes": "./src/routes.ts",
    },
    scripts: {
      build: "tsc -p tsconfig.json",
      clean: "rm -rf dist",
      prepack: "pnpm run build",
      typecheck: "tsc --noEmit",
      lint: "biome check src/",
      test: "vitest run",
    },
    dependencies: {
      "@voyant-travel/core": `^${version}`,
      "@voyant-travel/db": `^${version}`,
      "@voyant-travel/hono": `^${version}`,
      "drizzle-orm": "^0.45.2",
      hono: "^4.12.10",
      zod: "^4.3.6",
    },
    devDependencies: {
      typescript: "^5.9.2",
    },
    files: ["dist"],
    publishConfig: {
      access: "public",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
        "./schema": {
          types: "./dist/schema.d.ts",
          import: "./dist/schema.js",
        },
        "./validation": {
          types: "./dist/validation.d.ts",
          import: "./dist/validation.js",
        },
        "./routes": {
          types: "./dist/routes.d.ts",
          import: "./dist/routes.js",
        },
      },
    },
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

export function tsconfigJson(): string {
  const body = {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      moduleDetection: "force",
      esModuleInterop: true,
      isolatedModules: true,
      declaration: true,
      declarationMap: true,
      strict: true,
      noUncheckedIndexedAccess: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      outDir: "dist",
      rootDir: "src",
    },
    include: ["src/**/*"],
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

export function schemaTs(names: ModuleNames): string {
  return `import { typeId } from "@voyant-travel/db/lib/typeid-column"
import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const ${names.camel} = pgTable("${names.kebab}", {
  id: typeId("${names.camel}"),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

export type ${names.pascal} = typeof ${names.camel}.$inferSelect
export type New${names.pascal} = typeof ${names.camel}.$inferInsert
`
}

export function validationTs(names: ModuleNames): string {
  return `import { z } from "zod"

export const insert${names.pascal}Schema = z.object({
  name: z.string().min(1),
})

export const update${names.pascal}Schema = insert${names.pascal}Schema.partial()

export const list${names.pascal}QuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
})

export type Insert${names.pascal}Input = z.infer<typeof insert${names.pascal}Schema>
export type Update${names.pascal}Input = z.infer<typeof update${names.pascal}Schema>
`
}

export function serviceTs(names: ModuleNames): string {
  return `/**
 * Thin service scaffold for the ${names.kebab} module.
 *
 * Replace this with \`createCrudService\` from \`@voyant-travel/db/crud\`
 * once your table is finalized, or expand to capture multi-step workflows
 * and cross-module calls.
 */
export const ${names.camel}Service = {
  name: "${names.camel}",
}
`
}

export function routesTs(names: ModuleNames): string {
  return `import { Hono } from "hono"

/**
 * Admin routes for the ${names.kebab} module. Mounted at
 * \`/v1/admin/${names.kebab}\` by \`createApp\`.
 */
export const ${names.camel}Routes = new Hono()

${names.camel}Routes.get("/", (c) => c.json({ data: [] }))

export type ${names.pascal}Routes = typeof ${names.camel}Routes
`
}

export function indexTs(names: ModuleNames): string {
  return `import type { Module } from "@voyant-travel/core"
import type { HonoModule } from "@voyant-travel/hono/module"

import { ${names.camel}Routes } from "./routes.js"

export const ${names.camel}Module: Module = {
  name: "${names.kebab}",
}

export const ${names.camel}HonoModule: HonoModule = {
  module: ${names.camel}Module,
  adminRoutes: ${names.camel}Routes,
}

export type { ${names.pascal}, New${names.pascal} } from "./schema.js"
export { ${names.camel} } from "./schema.js"
export {
  insert${names.pascal}Schema,
  list${names.pascal}QuerySchema,
  update${names.pascal}Schema,
} from "./validation.js"
`
}
