import { existsSync, readFileSync } from "node:fs"
import { join, parse as parsePath, resolve } from "node:path"

import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import { pathExists, writeTextFile } from "../lib/fs.js"
import { toCamelCase, toKebabCase, toPascalCase } from "../lib/strings.js"
import { VOYANT_FRAMEWORK_VERSION } from "../lib/voyant-version.js"
import {
  adminTs,
  indexTs,
  type ModuleNames,
  packageJson,
  schemaTs,
  tsconfigJson,
  voyantTs,
  workflowsTs,
} from "../templates/module-files.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant generate module <name> [--schema] [--admin] [--workflow]`
 *
 * Scaffolds an explicitly selectable local package under `src/modules/`.
 * Optional facets are package exports referenced from an import-cheap
 * `src/voyant.ts` deployment manifest.
 *
 * By default `dir` defaults to `src/modules/`. Pass `--force` to overwrite
 * existing files.
 */
export async function generateModuleCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const { positionals } = args
  const rawName = positionals[0]
  if (!rawName) {
    ctx.stderr(
      "Usage: voyant generate module <name> [--schema] [--admin] [--workflow] [--dir <path>] [--package-name <name>] [--force]\n",
    )
    return 1
  }

  const kebab = toKebabCase(rawName)
  if (!kebab) {
    ctx.stderr(`Invalid module name: "${rawName}"\n`)
    return 1
  }

  const packageNameFlag = getStringFlag(args, "package-name")
  const packageName = packageNameFlag ?? inferPackageName(ctx.cwd, kebab)
  if (!isValidPackageName(packageName)) {
    ctx.stderr(`Invalid package name: "${packageName}"\n`)
    return 1
  }

  const names: ModuleNames = {
    kebab,
    camel: toCamelCase(rawName),
    pascal: toPascalCase(rawName),
    packageName,
  }
  const dirFlag = getStringFlag(args, "dir")
  const baseDir = dirFlag ? resolve(ctx.cwd, dirFlag) : join(ctx.cwd, "src", "modules")
  const moduleDir = join(baseDir, kebab)
  const force = getBooleanFlag(args, "force")
  const version = resolveVoyantVersion()
  const facets = {
    schema: getBooleanFlag(args, "schema"),
    admin: getBooleanFlag(args, "admin"),
    workflow: getBooleanFlag(args, "workflow"),
  }

  const files: Array<[string, string]> = [
    ["package.json", packageJson(names, version, facets)],
    ["tsconfig.json", tsconfigJson()],
    ["src/voyant.ts", voyantTs(names, facets)],
    ["src/index.ts", indexTs(names, facets)],
  ]
  if (facets.schema) files.push(["src/schema.ts", schemaTs(names)])
  if (facets.admin) files.push(["src/admin.ts", adminTs(names)])
  if (facets.workflow) files.push(["src/workflows.ts", workflowsTs(names)])

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
    `Created module ${packageName} at ${moduleDir}\n` +
      `Next steps:\n` +
      `  voyant add ./${relativeFromProject(ctx.cwd, moduleDir)}\n`,
  )
  return 0
}

function resolveVoyantVersion(): string {
  return VOYANT_FRAMEWORK_VERSION
}

function inferPackageName(cwd: string, moduleName: string): string {
  const rootName = findNearestPackageName(cwd)
  if (!rootName) return `@local/${moduleName}`
  if (rootName.startsWith("@")) return `${rootName.split("/")[0]}/${moduleName}`
  return `@${toKebabCase(rootName) || "local"}/${moduleName}`
}

function findNearestPackageName(cwd: string): string | null {
  let current = resolve(cwd)
  for (;;) {
    const packagePath = join(current, "package.json")
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown }
        if (typeof pkg.name === "string" && pkg.name.length > 0) return pkg.name
      } catch {
        return null
      }
    }
    const parent = parsePath(current).dir
    if (!parent || parent === current) return null
    current = parent
  }
}

function isValidPackageName(name: string): boolean {
  return /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)
}

function relativeFromProject(projectRoot: string, moduleDir: string): string {
  const prefix = `${resolve(projectRoot)}/`
  return resolve(moduleDir).replace(prefix, "").replaceAll("\\", "/")
}
