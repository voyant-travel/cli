import {
  type ConfigValidationResult,
  resolveEntry,
  type VoyantConfig,
  validateVoyantConfig,
} from "@voyant-travel/core/config"

import { parseArgs } from "../lib/args.js"
import { loadVoyantConfigFile, resolveConfigPath } from "../lib/config-loader.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant config <show|validate|path>`
 *
 * Inspects the voyant.config.* manifest discovered by walking parent
 * directories from the current working directory. Used by other CLI
 * commands and by users verifying their configuration shape.
 */
export async function configCommand(ctx: CommandContext): Promise<CommandResult> {
  const { positionals, flags } = parseArgs(ctx.argv)
  const sub = positionals[0] ?? "show"
  const pathFlag = typeof flags.path === "string" ? flags.path : undefined

  const resolved = resolveConfigPath({ path: pathFlag, cwd: ctx.cwd })
  if (!resolved) {
    ctx.stderr(
      pathFlag
        ? `No voyant config found at ${pathFlag}\n`
        : `No voyant.config.* found in ${ctx.cwd} or any parent directory.\n`,
    )
    return 1
  }

  if (sub === "path") {
    ctx.stdout(`${resolved}\n`)
    return 0
  }

  let loaded: { path: string; config: unknown }
  try {
    loaded = await loadVoyantConfigFile(resolved)
  } catch (err) {
    ctx.stderr(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const result = validateVoyantConfig(loaded.config)

  if (sub === "validate") {
    return emitValidation(ctx, loaded.path, result)
  }

  if (sub === "show") {
    return emitShow(ctx, loaded.path, loaded.config, result)
  }

  ctx.stderr(`Unknown config subcommand: ${sub}. Expected "show", "validate", or "path".\n`)
  return 1
}

function emitValidation(
  ctx: CommandContext,
  path: string,
  result: ConfigValidationResult,
): CommandResult {
  if (result.ok) {
    ctx.stdout(`voyant config ok: ${path}\n`)
    return 0
  }
  ctx.stderr(`voyant config invalid: ${path}\n`)
  for (const issue of result.issues) {
    ctx.stderr(`  - ${issue.path || "(root)"}: ${issue.message}\n`)
  }
  return 1
}

function emitShow(
  ctx: CommandContext,
  path: string,
  config: unknown,
  validation: ConfigValidationResult,
): CommandResult {
  ctx.stdout(`voyant config: ${path}\n`)
  if (!validation.ok) {
    ctx.stderr(`\nManifest has ${validation.issues.length} issue(s):\n`)
    for (const issue of validation.issues) {
      ctx.stderr(`  - ${issue.path || "(root)"}: ${issue.message}\n`)
    }
    return 1
  }

  const cfg = config as VoyantConfig
  ctx.stdout(`\nDeployment: ${cfg.deployment ?? "(unset)"}\n`)

  const modules = cfg.modules ?? []
  ctx.stdout(`Modules (${modules.length}):\n`)
  for (const entry of modules) {
    const { resolve, options } = resolveEntry(entry)
    const opts = Object.keys(options).length > 0 ? ` [${Object.keys(options).join(", ")}]` : ""
    ctx.stdout(`  - ${resolve}${opts}\n`)
  }

  const plugins = cfg.plugins ?? []
  ctx.stdout(`Plugins (${plugins.length}):\n`)
  for (const entry of plugins) {
    const { resolve, options } = resolveEntry(entry)
    const opts = Object.keys(options).length > 0 ? ` [${Object.keys(options).join(", ")}]` : ""
    ctx.stdout(`  - ${resolve}${opts}\n`)
  }

  if (cfg.admin) {
    ctx.stdout(`Admin: enabled=${cfg.admin.enabled ?? false} path=${cfg.admin.path ?? "(unset)"}\n`)
  }

  if (cfg.featureFlags && Object.keys(cfg.featureFlags).length > 0) {
    ctx.stdout("Feature flags:\n")
    for (const [key, value] of Object.entries(cfg.featureFlags)) {
      ctx.stdout(`  - ${key}: ${value}\n`)
    }
  }

  return 0
}
