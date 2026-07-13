import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { parseArgs } from "../lib/args.js"
import { renderLinkDrizzleSchema } from "../lib/link-schema.js"
import {
  type ProjectDatabaseArtifacts,
  resolveProjectDatabaseArtifacts,
} from "../lib/project-database.js"
import type { SchemaResolutionStyle } from "../lib/resolve-schemas.js"
import {
  type GeneratedSchemaManifest,
  resolveSchemaManifest,
  writeSchemaManifest,
} from "../lib/schema-manifest.js"
import { loadVoyantConfig, type SchemaManifestConfig } from "../lib/voyant-config.js"
import type { CommandContext, CommandResult } from "../types.js"
import { loadLinks } from "./db-sync-links.js"

/**
 * `voyant db schemas [--style=specifier|file] [--config <path>] [--emit [--out <file>]]`
 *
 * Print schema entrypoints from checked resolved graph artifacts for current
 * projects, preserving selected graph order and generated project links.
 * Legacy configs retain config-based dependency closure derivation. Defaults
 * to "specifier" output; pass `--style=file` for absolute paths.
 *
 * Pass `--emit` to also write the committed `drizzle.schemas.generated.ts`
 * (optionally to `--out <file>`) that a template's `drizzle.config.ts` can
 * import instead of hand-listing schema paths. Current projects also refresh
 * `drizzle.links.generated.ts` from their generated `projectLinks` artifact.
 */
export async function dbSchemasCommand(ctx: CommandContext): Promise<CommandResult> {
  const { flags } = parseArgs(ctx.argv)

  const configPath = typeof flags.config === "string" ? flags.config : null
  const style = (
    typeof flags.style === "string" ? flags.style : "specifier"
  ) as SchemaResolutionStyle

  if (style !== "specifier" && style !== "file") {
    ctx.stderr(`Invalid --style: ${style}. Expected "specifier" or "file".\n`)
    return 1
  }

  const config = await loadVoyantConfig(ctx.cwd, configPath)
  if (!config) {
    ctx.stderr(
      "Could not locate a voyant.config.ts. Run from a directory containing one or pass --config <path>.\n",
    )
    return 1
  }

  let project: Awaited<ReturnType<typeof resolveProjectDatabaseArtifacts>>
  try {
    project = await resolveProjectDatabaseArtifacts(ctx.cwd, config, configPath ?? undefined)
  } catch (error) {
    ctx.stderr(`Could not derive database inputs from project artifacts: ${reason(error)}\n`)
    return 1
  }
  const cwd = project?.projectRoot ?? ctx.cwd
  const projectOptions = project
    ? {
        schemaSources: project.schemaSources,
        includeGeneratedLinks: project.projectLinkCount > 0,
      }
    : undefined

  if (flags.emit === true) {
    const out = typeof flags.out === "string" ? flags.out : undefined
    let generated: GeneratedSchemaManifest
    try {
      generated = await writeDatabaseSchemaArtifacts(config, {
        cwd,
        outPath: out,
        project,
      })
    } catch (error) {
      ctx.stderr(`Could not emit database schema artifacts: ${reason(error)}\n`)
      return 1
    }
    ctx.stdout(`Wrote ${generated.entries.length} schema entrypoint(s) to ${generated.path}\n`)
  }

  const schemas = resolveSchemaManifest(config, { cwd, style, project: projectOptions })
  for (const entry of schemas) {
    ctx.stdout(`${entry}\n`)
  }
  return 0
}

export async function writeDatabaseSchemaArtifacts(
  config: SchemaManifestConfig,
  options: {
    cwd: string
    outPath?: string
    project: ProjectDatabaseArtifacts | null
  },
): Promise<GeneratedSchemaManifest> {
  if (options.project?.projectLinksPath) {
    const links = await loadLinks(options.project.projectLinksPath)
    writeFileSync(
      join(options.project.projectRoot, "drizzle.links.generated.ts"),
      renderLinkDrizzleSchema(links),
    )
  }
  return writeSchemaManifest(config, {
    cwd: options.cwd,
    outPath: options.outPath,
    project: options.project
      ? {
          schemaSources: options.project.schemaSources,
          includeGeneratedLinks: options.project.projectLinkCount > 0,
        }
      : undefined,
  })
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
