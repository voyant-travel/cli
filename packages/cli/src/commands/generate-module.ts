import { join, resolve } from "node:path"

import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import { pathExists, writeTextFile } from "../lib/fs.js"
import { toKebabCase } from "../lib/strings.js"
import { moduleIndexTs } from "../templates/module-files.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant generate module <name> [--dir <path>] [--force]`
 *
 * Scaffolds a convention-discovered local module under `src/modules/`.
 */
export async function generateModuleCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const { positionals } = args
  const rawName = positionals[0]
  if (!rawName) {
    ctx.stderr("Usage: voyant generate module <name> [--dir <path>] [--force]\n")
    return 1
  }

  const kebab = toKebabCase(rawName)
  if (!kebab) {
    ctx.stderr(`Invalid module name: "${rawName}"\n`)
    return 1
  }

  const dirFlag = getStringFlag(args, "dir")
  const baseDir = dirFlag ? resolve(ctx.cwd, dirFlag) : join(ctx.cwd, "src", "modules")
  const moduleDir = join(baseDir, kebab)
  const force = getBooleanFlag(args, "force")
  const target = join(moduleDir, "index.ts")

  if (!force && pathExists(target)) {
    ctx.stderr(`File already exists: ${target}\nPass --force to overwrite.\n`)
    return 1
  }

  writeTextFile(target, moduleIndexTs(kebab))

  ctx.stdout(`Created module ${kebab} at ${moduleDir}\n`)
  return 0
}
