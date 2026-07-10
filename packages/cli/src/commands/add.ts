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
  addProjectSelection,
  cloneProjectConfig,
  parseProjectConfig,
  renderProjectConfig,
  selectionResolve,
  writeProjectConfig,
} from "../lib/project-config.js"
import type { CommandContext, CommandResult } from "../types.js"

type UnitKind = "module" | "plugin"

export interface AddCommandDeps {
  runAdd?: (cwd: string, manager: PackageManager, specifier: string) => Promise<number>
}

export async function addCommand(
  ctx: CommandContext,
  deps: AddCommandDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv, {
    booleanFlags: ["module", "plugin", "dry-run", "plan"],
  })
  const requested = args.positionals[0]
  if (!requested) {
    ctx.stderr("Usage: voyant add <package|path> [--module | --plugin]\n")
    return 1
  }

  const forceModule = getBooleanFlag(args, "module")
  const forcePlugin = getBooleanFlag(args, "plugin")
  const planOnly = getBooleanFlag(args, "dry-run", "plan")
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

  let originalSource: string
  let config: AuthoringProjectConfig
  try {
    originalSource = readFileSync(configPath, "utf8")
    config = parseProjectConfig(originalSource)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant add: cannot update ${configPath}: ${reason}.\n`)
    return 1
  }

  let target: PackageSelectionTarget
  try {
    target = resolvePackageSelectionTarget(projectRoot, requested)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant add: ${reason}.\n`)
    return 1
  }

  const existingKind = selectedKind(config, target.selection)
  if (existingKind) {
    if (planOnly) {
      const packagePath = join(projectRoot, "package.json")
      const manager = readManagerOrDefault(projectRoot, packagePath)
      ctx.stdout(
        renderPackageLifecyclePlan(
          createPackageLifecyclePlan({ operation: "add", packageManager: manager }),
        ),
      )
      return 0
    }
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

  let manifest: ProjectManifest
  try {
    manifest = readProjectManifest(packagePath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant add: cannot read ${packagePath}: ${reason}.\n`)
    return 1
  }
  const manager = detectPackageManager(projectRoot, manifest)

  if (planOnly) {
    const currentDependency = findManifestDependency(manifest, target.packageName)
    const nextConfig = cloneProjectConfig(config)
    if (kind) addProjectSelection(nextConfig, kind, target.selection)
    const plan = createPackageLifecyclePlan({
      operation: "add",
      packageManager: manager,
      dependencyChanges: [
        {
          packageName: target.packageName,
          section: currentDependency?.section ?? "dependencies",
          before: currentDependency?.version ?? null,
          after:
            target.versionExplicit || !currentDependency
              ? target.plannedVersion
              : currentDependency.version,
        },
      ],
      selections: diffGraphSelections(
        authoringGraphSelections(config),
        authoringGraphSelections(nextConfig),
      ),
      ...(!kind
        ? {
            blockedBy: {
              code: "unit_kind_unknown",
              message: `${target.packageName} is not installed with voyant.package.v1 metadata; pass --module or --plugin`,
            },
          }
        : {}),
    })
    ctx.stdout(renderPackageLifecyclePlan(plan))
    return plan.status === "blocked" ? 1 : 0
  }

  const snapshots = snapshotPackageManagerFiles(projectRoot)
  const runAdd = deps.runAdd ?? defaultRunAdd
  ctx.stdout(`Installing ${target.installSpecifier} with ${manager}...\n`)
  let installCode: number
  try {
    installCode = await runAdd(projectRoot, manager, target.installSpecifier)
  } catch {
    installCode = 1
  }
  if (installCode !== 0) {
    restoreProjectFiles(snapshots)
    ctx.stderr(`voyant add: ${manager} install failed (exit ${installCode}).\n`)
    return installCode
  }

  kind ??= readVoyantKind(target.metadataPath)
  if (!kind) {
    restoreProjectFiles(snapshots)
    ctx.stderr(
      `voyant add: ${target.packageName} does not declare voyant.kind; pass --module or --plugin.\n`,
    )
    return 1
  }

  const nextConfig = cloneProjectConfig(config)
  addProjectSelection(nextConfig, kind, target.selection)
  const nextSource = renderProjectConfig(nextConfig)
  try {
    writeProjectConfig(configPath, nextSource)
  } catch (error) {
    restoreProjectFiles(snapshots)
    writeProjectConfig(configPath, originalSource)
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr(`voyant add: could not safely update ${configPath}: ${reason}.\n`)
    return 1
  }
  ctx.stdout(`Selected ${target.selection} in ${kind === "module" ? "modules" : "plugins"}.\n`)
  return 0
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

function readManagerOrDefault(root: string, packagePath: string): PackageManager {
  try {
    return detectPackageManager(root, readProjectManifest(packagePath))
  } catch {
    return "npm"
  }
}

function defaultRunAdd(cwd: string, manager: PackageManager, specifier: string): Promise<number> {
  const args = manager === "npm" ? ["install", specifier] : ["add", specifier]
  return new Promise((done) => {
    const child = spawn(manager, args, { cwd, stdio: "inherit", shell: false })
    child.on("exit", (code) => done(code ?? 0))
    child.on("error", () => done(1))
  })
}
