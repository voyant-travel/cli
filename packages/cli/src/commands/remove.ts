import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, parse as parsePath, resolve } from "node:path"

import { getBooleanFlag, parseArgs } from "../lib/args.js"
import { authoringGraphSelections, diffGraphSelections } from "../lib/graph-diff.js"
import {
  detectPackageManager,
  findManifestDependency,
  type PackageManager,
  type PackageSelectionTarget,
  type ProjectManifest,
  packageNameForSelection,
  readProjectManifest,
  resolvePackageSelectionTarget,
  restoreProjectFiles,
  snapshotPackageManagerFiles,
} from "../lib/package-lifecycle.js"
import {
  createPackageLifecyclePlan,
  renderPackageLifecyclePlan,
} from "../lib/package-lifecycle-plan.js"
import {
  type AuthoringProjectConfig,
  cloneProjectConfig,
  parseProjectConfig,
  removeProjectSelection,
  renderProjectConfig,
  selectionResolve,
  writeProjectConfig,
} from "../lib/project-config.js"
import type { CommandContext, CommandResult } from "../types.js"

type UnitKind = "module" | "plugin"

export interface RemoveCommandDeps {
  runRemove?: (cwd: string, manager: PackageManager, packageName: string) => Promise<number>
}

export async function removeCommand(
  ctx: CommandContext,
  deps: RemoveCommandDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, {
    booleanFlags: ["module", "plugin", "dry-run", "plan"],
  })
  const requested = args.positionals[0]
  if (!requested) {
    ctx.stderr("Usage: voyant remove <package|path> [--module | --plugin] [--dry-run]\n")
    return 1
  }

  const forceModule = getBooleanFlag(args, "module")
  const forcePlugin = getBooleanFlag(args, "plugin")
  const planOnly = getBooleanFlag(args, "dry-run", "plan")
  if (forceModule && forcePlugin) {
    ctx.stderr("voyant remove: --module and --plugin cannot be used together.\n")
    return 1
  }

  const configPath = findNearestProjectConfig(ctx.cwd)
  if (!configPath) {
    ctx.stderr("voyant remove: no voyant.config.ts found from the current directory.\n")
    return 1
  }
  const projectRoot = parsePath(configPath).dir
  const originalSource = readFileSync(configPath, "utf8")

  let config: AuthoringProjectConfig
  try {
    config = parseProjectConfig(originalSource)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant remove: cannot update ${configPath}: ${reason}.\n`)
    return 1
  }

  let target: PackageSelectionTarget
  try {
    target = resolvePackageSelectionTarget(projectRoot, requested)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant remove: ${reason}.\n`)
    return 1
  }

  let kind: UnitKind | null
  try {
    kind = selectedKind(config, target.selection, forceModule, forcePlugin)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant remove: ${reason}.\n`)
    return 1
  }

  const packagePath = join(projectRoot, "package.json")
  if (!kind) {
    if (planOnly) {
      const manager = readManagerOrDefault(projectRoot, packagePath)
      ctx.stdout(
        renderPackageLifecyclePlan(
          createPackageLifecyclePlan({ operation: "remove", packageManager: manager }),
        ),
      )
    } else {
      ctx.stdout(`Already absent from modules/plugins: ${target.selection}.\n`)
    }
    return 0
  }

  if (!existsSync(packagePath)) {
    ctx.stderr(`voyant remove: no package.json found beside ${configPath}.\n`)
    return 1
  }

  let manifest: ProjectManifest
  try {
    manifest = readProjectManifest(packagePath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant remove: cannot read ${packagePath}: ${reason}.\n`)
    return 1
  }
  const manager = detectPackageManager(projectRoot, manifest)
  const nextConfig = cloneProjectConfig(config)
  removeProjectSelection(nextConfig, kind, target.selection)
  const nextSource = renderProjectConfig(nextConfig)
  try {
    parseProjectConfig(nextSource)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant remove: cannot safely update ${configPath}: ${reason}.\n`)
    return 1
  }

  const dependency = findManifestDependency(manifest, target.packageName)
  const keepDependency = hasSelectionFromPackage(nextConfig, projectRoot, target.packageName)
  const dependencyChanges =
    dependency && !keepDependency
      ? [
          {
            packageName: target.packageName,
            section: dependency.section,
            before: dependency.version,
            after: null,
          },
        ]
      : []
  const plan = createPackageLifecyclePlan({
    operation: "remove",
    packageManager: manager,
    dependencyChanges,
    selections: diffGraphSelections(
      authoringGraphSelections(config),
      authoringGraphSelections(nextConfig),
    ),
  })

  if (planOnly) {
    ctx.stdout(renderPackageLifecyclePlan(plan))
    return 0
  }

  const snapshots = snapshotPackageManagerFiles(projectRoot)
  try {
    writeProjectConfig(configPath, nextSource)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant remove: could not update ${configPath}: ${reason}.\n`)
    return 1
  }

  if (dependencyChanges.length > 0) {
    const runRemove = deps.runRemove ?? defaultRunRemove
    ctx.stdout(`Removing ${target.packageName} with ${manager}...\n`)
    let removeCode: number
    try {
      removeCode = await runRemove(projectRoot, manager, target.packageName)
    } catch {
      removeCode = 1
    }
    if (removeCode !== 0) {
      restoreProjectFiles(snapshots)
      writeProjectConfig(configPath, originalSource)
      ctx.stderr(
        `voyant remove: ${manager} remove failed (exit ${removeCode}); restored project files.\n`,
      )
      return removeCode
    }
  }

  ctx.stdout(
    `Removed ${target.selection} from ${kind === "module" ? "modules" : "plugins"}` +
      `${keepDependency ? "; kept shared dependency" : ""}.\n`,
  )
  return 0
}

function selectedKind(
  config: AuthoringProjectConfig,
  selection: string,
  forceModule: boolean,
  forcePlugin: boolean,
): UnitKind | null {
  const inModules = config.modules.some((entry) => selectionResolve(entry) === selection)
  const inPlugins = config.plugins.some((entry) => selectionResolve(entry) === selection)
  if (forceModule) {
    if (inPlugins && !inModules)
      throw new Error(`${selection} is selected as a plugin, not a module`)
    return inModules ? "module" : null
  }
  if (forcePlugin) {
    if (inModules && !inPlugins)
      throw new Error(`${selection} is selected as a module, not a plugin`)
    return inPlugins ? "plugin" : null
  }
  if (inModules && inPlugins) {
    throw new Error(
      `${selection} is selected as both a module and plugin; pass --module or --plugin`,
    )
  }
  return inModules ? "module" : inPlugins ? "plugin" : null
}

function hasSelectionFromPackage(
  config: AuthoringProjectConfig,
  projectRoot: string,
  packageName: string,
): boolean {
  return [...config.modules, ...config.plugins].some(
    (selection) =>
      packageNameForSelection(projectRoot, selectionResolve(selection)) === packageName,
  )
}

function readManagerOrDefault(root: string, packagePath: string): PackageManager {
  try {
    return detectPackageManager(root, readProjectManifest(packagePath))
  } catch {
    return "npm"
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

function defaultRunRemove(
  cwd: string,
  manager: PackageManager,
  packageName: string,
): Promise<number> {
  const command = manager === "npm" ? "uninstall" : "remove"
  return new Promise((done) => {
    const child = spawn(manager, [command, packageName], {
      cwd,
      stdio: "inherit",
      shell: false,
    })
    child.on("exit", (code) => done(code ?? 0))
    child.on("error", () => done(1))
  })
}
