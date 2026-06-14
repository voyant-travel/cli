import { join } from "node:path"

import { parseArgs } from "../lib/args.js"
import { pathExists, writeTextFile } from "../lib/fs.js"
import { toCamelCase, toKebabCase, toPascalCase } from "../lib/strings.js"
import { VOYANT_FRAMEWORK_VERSION } from "../lib/voyant-version.js"
import {
  indexTs,
  type ModuleNames,
  packageJson,
  routesTs,
  schemaTs,
  serviceTs,
  tsconfigJson,
  validationTs,
} from "../templates/module-files.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant generate module <name> [--dir <path>] [--force]`
 *
 * Scaffolds a new module package at `<dir>/<kebab-name>/` with the canonical
 * 4-file module shape (schema, validation, routes, service, index) + a
 * `package.json` and `tsconfig.json`.
 *
 * By default `dir` defaults to `packages/`. Pass `--force` to overwrite
 * existing files.
 */
export async function generateModuleCommand(ctx: CommandContext): Promise<CommandResult> {
  const { positionals, flags } = parseArgs(ctx.argv)
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

  const names: ModuleNames = {
    kebab,
    camel: toCamelCase(rawName),
    pascal: toPascalCase(rawName),
  }
  const dirFlag = flags.dir
  const baseDir = typeof dirFlag === "string" ? dirFlag : join(ctx.cwd, "packages")
  const moduleDir = join(baseDir, kebab)
  const force = flags.force === true
  const version = resolveVoyantVersion()

  const files: Array<[string, string]> = [
    ["package.json", packageJson(names, version)],
    ["tsconfig.json", tsconfigJson()],
    ["src/schema.ts", schemaTs(names)],
    ["src/validation.ts", validationTs(names)],
    ["src/service.ts", serviceTs(names)],
    ["src/routes.ts", routesTs(names)],
    ["src/index.ts", indexTs(names)],
  ]

  if (!force) {
    for (const [relPath] of files) {
      const target = join(moduleDir, relPath)
      if (pathExists(target)) {
        ctx.stderr(`File already exists: ${target}\nPass --force to overwrite.\n`)
        return 1
      }
    }
  }

  for (const [relPath, content] of files) {
    writeTextFile(join(moduleDir, relPath), content)
  }

  ctx.stdout(
    `Created module @voyant-travel/${kebab} at ${moduleDir}\n` +
      `Next steps:\n` +
      `  1. Add the package to pnpm-workspace.yaml (already covered by packages/*)\n` +
      `  2. pnpm install\n` +
      `  3. Implement schema.ts, then pnpm db:generate\n`,
  )
  return 0
}

function resolveVoyantVersion(): string {
  return VOYANT_FRAMEWORK_VERSION
}
