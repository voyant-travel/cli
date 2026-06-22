export interface ExtensionNames {
  /** Kebab-case name (e.g. "booking-notes"). Used for directory + extension name. */
  kebab: string
  /** camelCase name (e.g. "bookingNotes"). Used for variable names. */
  camel: string
  /** PascalCase name (e.g. "BookingNotes"). Used for type names. */
  pascal: string
  /** Kebab-case name of the existing module this extension attaches to (e.g. "bookings"). */
  module: string
  /** camelCase form of the target module (e.g. "bookings"). Used for the FK column. */
  moduleCamel: string
  /** Surface the routes mount on. */
  surface: "admin" | "public"
}

/** Build the `index.ts` that default-exports the extension via `defineDeploymentExtension`. */
export function indexTs(names: ExtensionNames): string {
  const routesField = `${names.surface}Routes`
  return `import { defineDeploymentExtension } from "@voyant-travel/framework"

import { ${names.camel}Routes } from "./routes.js"

/**
 * \`${names.kebab}\` extension — attaches to the \`${names.module}\` module.
 *
 * Discovered from \`src/extensions/${names.kebab}/\` at build time and mounted
 * onto the \`${names.module}\` surface at \`/v1/${names.surface}/${names.module}/*\`.
 * It is deployment-owned and survives \`voyant upgrade\`.
 */
export default defineDeploymentExtension({
  extension: { name: "${names.kebab}", module: "${names.module}" },
  ${routesField}: ${names.camel}Routes, // → /v1/${names.surface}/${names.module}/*
})
`
}

/** Build the `routes.ts` Hono router the extension contributes to the module surface. */
export function routesTs(names: ExtensionNames): string {
  return `import { Hono } from "hono"

import { parseJsonBody, requireActor } from "@voyant-travel/hono"

import { create${names.pascal}Schema } from "./validation.js"

/**
 * Routes contributed by the \`${names.kebab}\` extension. They are mounted under
 * the \`${names.module}\` module's surface, so these paths are relative to
 * \`/v1/${names.surface}/${names.module}\`. Keep them on their own sub-path so they
 * sit alongside the module's own routes instead of colliding with them.
 */
export const ${names.camel}Routes = new Hono()
  // GET /v1/${names.surface}/${names.module}/${names.kebab}
  .get("/${names.kebab}", (c) => {
    requireActor(c)
    return c.json({ data: [] })
  })
  // POST /v1/${names.surface}/${names.module}/${names.kebab}
  .post("/${names.kebab}", async (c) => {
    requireActor(c)
    const body = await parseJsonBody(c, create${names.pascal}Schema)
    return c.json({ data: body }, 201)
  })

export type ${names.pascal}Routes = typeof ${names.camel}Routes
`
}

/** Build the `validation.ts` zod schema for the extension's write routes. */
export function validationTs(names: ExtensionNames): string {
  return `import { z } from "zod"

/** Request body accepted by the \`${names.kebab}\` extension's write routes. */
export const create${names.pascal}Schema = z.object({
  name: z.string().min(1),
})

export type Create${names.pascal}Input = z.infer<typeof create${names.pascal}Schema>
`
}

/**
 * Build the optional `schema.ts` extension table.
 *
 * Emitted only with `--with-schema`. Follows the 1:1 detail-table convention:
 * keyed to the target module's record by a plain text column, never a
 * cross-module foreign key.
 */
export function schemaTs(names: ExtensionNames): string {
  const table = names.kebab.replace(/-/g, "_")
  const moduleColumnCamel = `${names.moduleCamel}Id`
  const moduleColumnSnake = `${names.module.replace(/-/g, "_")}_id`
  return `import { typeId } from "@voyant-travel/db/lib/typeid-column"
import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

/**
 * Detail table for the \`${names.kebab}\` extension.
 *
 * Keyed to the target \`${names.module}\` record by a plain text column — do NOT
 * add a cross-module foreign key (\`.references()\`); pair it with a
 * \`defineLink\` if you need the association resolved in the query graph. Prefix
 * the table name with your deployment slug (e.g. \`acme_${table}\`) so it stays
 * clear of the framework's global table namespace, then run
 * \`pnpm db:generate:deployment\`.
 */
export const ${names.camel} = pgTable("${table}", {
  id: typeId("${names.camel}"),
  ${moduleColumnCamel}: text("${moduleColumnSnake}").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
})

export type ${names.pascal}Row = typeof ${names.camel}.$inferSelect
export type New${names.pascal}Row = typeof ${names.camel}.$inferInsert
`
}
