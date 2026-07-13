import { generateLinkTableSql, type LinkDefinition } from "@voyant-travel/core/links"

import { loadProjectModule } from "./project-module-loader.js"

interface ProjectLinksModule {
  projectLinks?: unknown
}

interface SqlClient {
  connect(): Promise<void>
  end(): Promise<void>
  query(sql: string): Promise<unknown>
}

interface PgModule {
  Client: new (options: { connectionString: string }) => SqlClient
}

export interface ProjectLinkMigrationReport {
  discovered: number
  materialized: number
  readOnly: number
}

export async function loadProjectLinksArtifact(path: string): Promise<readonly LinkDefinition[]> {
  const module = await loadProjectModule<ProjectLinksModule>(path)
  if (!Array.isArray(module.projectLinks)) {
    throw new ProjectLinkMigrationError(
      "link_artifact_invalid",
      `${path} must export a projectLinks array`,
    )
  }
  for (const [index, value] of module.projectLinks.entries()) {
    if (!isLinkDefinition(value)) {
      throw new ProjectLinkMigrationError(
        "link_artifact_invalid",
        `${path} projectLinks[${index}] is not a LinkDefinition`,
      )
    }
  }
  return module.projectLinks
}

/** Materialize generated link pivots after graph schema migrations have succeeded. */
export async function materializeProjectLinks(
  definitions: readonly LinkDefinition[],
  databaseUrl = resolveDatabaseUrl(),
): Promise<ProjectLinkMigrationReport> {
  const materialized = definitions.filter((definition) => !definition.readOnly)
  const report = {
    discovered: definitions.length,
    materialized: materialized.length,
    readOnly: definitions.length - materialized.length,
  }
  if (materialized.length === 0) return report
  if (!databaseUrl) {
    throw new ProjectLinkMigrationError(
      "link_sync_failed",
      "DATABASE_URL or DATABASE_URL_DIRECT is required to materialize project links",
    )
  }

  const { Client } = (await import("pg")) as unknown as PgModule
  const client = new Client({ connectionString: databaseUrl })
  let connected = false
  let transactionStarted = false
  try {
    await client.connect()
    connected = true
    await client.query("BEGIN")
    transactionStarted = true
    for (const definition of materialized) {
      const sql = generateLinkTableSql(definition)
      await client.query(sql.createTable)
      for (const index of sql.indexes) await client.query(index)
    }
    await client.query("COMMIT")
  } catch (error) {
    let rollbackDetail = ""
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK")
      } catch (rollbackError) {
        rollbackDetail = `; rollback failed: ${errorMessage(rollbackError)}`
      }
    }
    throw new ProjectLinkMigrationError(
      "link_sync_failed",
      `Could not materialize project links: ${errorMessage(error)}${rollbackDetail}`,
    )
  } finally {
    if (connected) await client.end()
  }
  return report
}

export class ProjectLinkMigrationError extends Error {
  constructor(
    readonly code: "link_artifact_invalid" | "link_sync_failed",
    message: string,
  ) {
    super(message)
    this.name = "ProjectLinkMigrationError"
  }
}

function resolveDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL_DIRECT?.trim() || process.env.DATABASE_URL?.trim() || undefined
}

function isLinkDefinition(value: unknown): value is LinkDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const definition = value as Partial<LinkDefinition>
  return Boolean(
    definition.left &&
      definition.right &&
      definition.tableName &&
      definition.leftColumn &&
      definition.rightColumn &&
      definition.cardinality,
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
