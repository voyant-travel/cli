import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, parse as parsePath, relative, resolve } from "node:path"

import { getBooleanFlag, parseArgs } from "../lib/args.js"
import {
  type AuthoringProjectConfig,
  parseProjectConfig,
  renderProjectConfig,
  selectionResolve,
} from "../lib/project-config.js"
import type { CommandContext, CommandResult } from "../types.js"

type UnitKind = "module" | "plugin"

export interface AddCommandDeps {
  runAdd?: (cwd: string, manager: PackageManager, specifier: string) => Promise<number>
}

type PackageManager = "pnpm" | "npm" | "yarn" | "bun"

export async function addCommand(
  ctx: CommandContext,
  deps: AddCommandDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const requested = args.positionals[0]
  if (!requested) {
    ctx.stderr("Usage: voyant add <package|path> [--module | --plugin]\n")
    return 1
  }

  const forceModule = getBooleanFlag(args, "module")
  const forcePlugin = getBooleanFlag(args, "plugin")
  if (forceModule && forcePlugin) {
    ctx.stderr("voyant add: --module and --plugin cannot be used together.\n")
    return 1
  }

  const configPath = findNearestProjectConfig(ctx.cwd)
  if (!configPath) {
    ctx.stderr("voyant add: no voyant.config.ts found from the current directory.\n")
    return 1
  }
  const projectRoot = parsePath(configPath).dir

  let config: AuthoringProjectConfig
  try {
    config = parseProjectConfig(readFileSync(configPath, "utf8"))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant add: cannot update ${configPath}: ${reason}.\n`)
    return 1
  }

  let target: AddTarget
  try {
    target = resolveAddTarget(projectRoot, requested)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant add: ${reason}.\n`)
    return 1
  }

  const existingKind = selectedKind(config, target.selection)
  if (existingKind) {
    ctx.stdout(`Already selected ${target.selection} as a ${existingKind}.\n`)
    return 0
  }

  const requestedKind: UnitKind | undefined = forceModule
    ? "module"
    : forcePlugin
      ? "plugin"
      : undefined
  let kind = requestedKind ?? readVoyantKind(target.metadataPath)

  const packagePath = join(projectRoot, "package.json")
  if (!existsSync(packagePath)) {
    ctx.stderr(`voyant add: no package.json found beside ${configPath}.\n`)
    return 1
  }

  const manager = detectPackageManager(projectRoot, packagePath)
  const runAdd = deps.runAdd ?? defaultRunAdd
  ctx.stdout(`Installing ${target.installSpecifier} with ${manager}...\n`)
  const installCode = await runAdd(projectRoot, manager, target.installSpecifier)
  if (installCode !== 0) {
    ctx.stderr(`voyant add: ${manager} install failed (exit ${installCode}).\n`)
    return installCode
  }

  kind ??= readVoyantKind(target.metadataPath)
  if (!kind) {
    ctx.stderr(
      `voyant add: ${target.packageName} does not declare voyant.kind; pass --module or --plugin.\n`,
    )
    return 1
  }

  const selections = kind === "module" ? config.modules : config.plugins
  selections.push(target.selection)
  writeFileSync(configPath, renderProjectConfig(config))
  ctx.stdout(`Selected ${target.selection} in ${kind === "module" ? "modules" : "plugins"}.\n`)
  return 0
}

interface AddTarget {
  selection: string
  installSpecifier: string
  packageName: string
  metadataPath: string
}

function resolveAddTarget(projectRoot: string, requested: string): AddTarget {
  if (isLocalSpecifier(requested)) {
    const withoutFilePrefix = requested.startsWith("file:") ? requested.slice(5) : requested
    const absolute = isAbsolute(withoutFilePrefix)
      ? resolve(withoutFilePrefix)
      : resolve(projectRoot, withoutFilePrefix)
    const relativePath = relative(projectRoot, absolute).replaceAll("\\", "/")
    if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
      throw new Error("local paths must identify a package inside the project")
    }
    const metadataPath = join(absolute, "package.json")
    const packageName = readPackageName(metadataPath)
    if (!packageName) throw new Error(`local package metadata not found at ${metadataPath}`)
    return {
      selection: `./${relativePath}`,
      installSpecifier: `./${relativePath}`,
      packageName,
      metadataPath,
    }
  }

  const parsed = parseRegistrySpecifier(requested)
  return {
    selection: parsed.selection,
    installSpecifier: parsed.installSpecifier,
    packageName: parsed.packageName,
    metadataPath: join(
      projectRoot,
      "node_modules",
      ...parsed.packageName.split("/"),
      "package.json",
    ),
  }
}

function parseRegistrySpecifier(requested: string): {
  selection: string
  installSpecifier: string
  packageName: string
} {
  if (!requested.startsWith("@")) {
    throw new Error("registry selections must use a scoped package name or a local path")
  }
  const parts = requested.split("/")
  const scope = parts[0]
  const packageAndVersion = parts[1]
  if (!scope || !packageAndVersion) throw new Error(`invalid package specifier ${requested}`)
  const versionAt = packageAndVersion.indexOf("@")
  const packagePart = versionAt === -1 ? packageAndVersion : packageAndVersion.slice(0, versionAt)
  const version = versionAt === -1 ? "" : packageAndVersion.slice(versionAt)
  if (
    !/^@[a-z0-9][a-z0-9._-]*$/.test(scope) ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(packagePart) ||
    (versionAt !== -1 && version.length < 2)
  ) {
    throw new Error(`invalid package specifier ${requested}`)
  }
  if (version && parts.length > 2) {
    throw new Error("versioned package selections cannot include a unit subpath")
  }

  const packageName = `${scope}/${packagePart}`
  return {
    packageName,
    installSpecifier: `${packageName}${version}`,
    selection: parts.length > 2 ? `${packageName}/${parts.slice(2).join("/")}` : packageName,
  }
}

function selectedKind(config: AuthoringProjectConfig, selection: string): UnitKind | null {
  if (config.modules.some((entry) => selectionResolve(entry) === selection)) return "module"
  if (config.plugins.some((entry) => selectionResolve(entry) === selection)) return "plugin"
  return null
}

function readVoyantKind(packagePath: string): UnitKind | undefined {
  if (!existsSync(packagePath)) return undefined
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
      voyant?: { schemaVersion?: unknown; kind?: unknown }
    }
    if (pkg.voyant?.schemaVersion !== "voyant.package.v1") return undefined
    return pkg.voyant.kind === "module" || pkg.voyant.kind === "plugin"
      ? pkg.voyant.kind
      : undefined
  } catch {
    return undefined
  }
}

function readPackageName(packagePath: string): string | null {
  if (!existsSync(packagePath)) return null
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown }
    return typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : null
  } catch {
    return null
  }
}

function findNearestProjectConfig(cwd: string): string | null {
  let current = resolve(cwd)
  for (;;) {
    const candidate = join(current, "voyant.config.ts")
    if (existsSync(candidate)) return candidate
    const parent = parsePath(current).dir
    if (!parent || parent === current) return null
    current = parent
  }
}

function detectPackageManager(root: string, packagePath: string): PackageManager {
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { packageManager?: unknown }
    if (typeof pkg.packageManager === "string") {
      const manager = pkg.packageManager.split("@")[0]
      if (manager === "pnpm" || manager === "npm" || manager === "yarn" || manager === "bun") {
        return manager
      }
    }
  } catch {
    // Lockfile fallback below.
  }
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(root, "yarn.lock"))) return "yarn"
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun"
  return "npm"
}

function defaultRunAdd(cwd: string, manager: PackageManager, specifier: string): Promise<number> {
  const args = manager === "npm" ? ["install", specifier] : ["add", specifier]
  return new Promise((done) => {
    const child = spawn(manager, args, { cwd, stdio: "inherit", shell: false })
    child.on("exit", (code) => done(code ?? 0))
    child.on("error", () => done(1))
  })
}

function isLocalSpecifier(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("file:") ||
    isAbsolute(value)
  )
}
