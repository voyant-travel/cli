import { join } from "node:path"

import { parseArgs } from "../lib/args.js"
import { pathExists, writeTextFile } from "../lib/fs.js"
import { toCamelCase, toKebabCase, toPascalCase } from "../lib/strings.js"
import {
  type ExtensionNames,
  indexTs,
  routesTs,
  schemaTs,
  validationTs,
} from "../templates/extension-files.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant generate extension <name> --module <target>`
 *   `[--dir <path>] [--public] [--with-schema] [--force]`
 *
 * Scaffolds a deployment-local `HonoExtension` at `<dir>/<kebab-name>/` that
 * attaches to an existing module's surface (`extension.module`). Unlike a
 * module, an extension is not an npm package — it has no `package.json` or
 * `tsconfig.json`; it is discovered from `src/extensions/*` and mounted under
 * the target module's path.
 *
 * Defaults: `dir` is `src/extensions`, the surface is `admin` (pass `--public`
 * to mount on the public surface), and no table is emitted unless
 * `--with-schema` is given. Pass `--force` to overwrite existing files.
 */
export async function generateExtensionCommand(ctx: CommandContext): Promise<CommandResult> {
  const { positionals, flags } = parseArgs(ctx.argv)
  const rawName = positionals[0]
  if (!rawName) {
    ctx.stderr(
      "Usage: voyant generate extension <name> --module <target> [--dir <path>] [--public] [--with-schema] [--force]\n",
    )
    return 1
  }

  const kebab = toKebabCase(rawName)
  if (!kebab) {
    ctx.stderr(`Invalid extension name: "${rawName}"\n`)
    return 1
  }

  const moduleFlag = flags.module
  if (typeof moduleFlag !== "string" || moduleFlag.length === 0) {
    ctx.stderr(
      "Missing target module. Pass --module <name> (the existing module this extension attaches to, e.g. --module bookings).\n",
    )
    return 1
  }
  const moduleKebab = toKebabCase(moduleFlag)
  if (!moduleKebab) {
    ctx.stderr(`Invalid target module: "${moduleFlag}"\n`)
    return 1
  }

  const names: ExtensionNames = {
    kebab,
    camel: toCamelCase(rawName),
    pascal: toPascalCase(rawName),
    module: moduleKebab,
    moduleCamel: toCamelCase(moduleKebab),
    surface: flags.public === true ? "public" : "admin",
  }

  const dirFlag = flags.dir
  const baseDir = typeof dirFlag === "string" ? dirFlag : join(ctx.cwd, "src", "extensions")
  const extensionDir = join(baseDir, kebab)
  const force = flags.force === true
  const withSchema = flags["with-schema"] === true

  const files: Array<[string, string]> = [
    ["index.ts", indexTs(names)],
    ["routes.ts", routesTs(names)],
    ["validation.ts", validationTs(names)],
  ]
  if (withSchema) {
    files.push(["schema.ts", schemaTs(names)])
  }

  if (!force) {
    for (const [relPath] of files) {
      const target = join(extensionDir, relPath)
      if (pathExists(target)) {
        ctx.stderr(`File already exists: ${target}\nPass --force to overwrite.\n`)
        return 1
      }
    }
  }

  for (const [relPath, content] of files) {
    writeTextFile(join(extensionDir, relPath), content)
  }

  const mountPath = `/v1/${names.surface}/${moduleKebab}`
  ctx.stdout(
    `Created extension "${kebab}" (attaches to ${moduleKebab}) at ${extensionDir}\n` +
      `Mounts under ${mountPath}/*\n` +
      `Next steps:\n` +
      `  1. Implement routes.ts (discovery via extensionsFromGlob over src/extensions/* is automatic)\n` +
      (withSchema
        ? "  2. Define your table in schema.ts, then pnpm db:generate:deployment && pnpm db:migrate\n"
        : "  2. Re-run with --with-schema if the extension needs its own table\n"),
  )
  return 0
}
