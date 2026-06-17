/**
 * `voyant upgrade [--to <version>] [--dry-run] [--package <name>]`
 *
 * Bumps the deployment's framework BOM — `@voyant-travel/framework` — to one
 * version, then installs. The BOM's pinned `dependencies` transitively resolve
 * the whole tested runtime set, so a deployment tracks a single version instead
 * of a per-package matrix (consolidated-deployments RFC, Workstream A). This is
 * the first step of the upgrade path: `voyant upgrade && voyant db migrate &&
 * voyant doctor`.
 *
 * It edits the nearest `package.json`, replacing the BOM's version range, and
 * runs the detected package manager's install. `--to` pins an explicit version
 * (default: the latest published); `--dry-run` reports without writing.
 */
import { execFileSync, spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, parse as parsePath } from "node:path"

import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import type { CommandContext, CommandResult } from "../types.js"

const BOM_PACKAGE = "@voyant-travel/framework"

/** Injectable side effects (network/install) so the command is unit-testable. */
export interface UpgradeDeps {
  /** Resolve a package's latest published version; `null` if unavailable. */
  resolveLatestVersion?: (pkg: string) => string | null
  /** Run the package manager's install in `cwd`; resolves to its exit code. */
  runInstall?: (cwd: string, manager: string) => Promise<number>
}

export async function upgradeCommand(
  ctx: CommandContext,
  deps: UpgradeDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const pkgName = getStringFlag(args, "package") ?? BOM_PACKAGE
  const explicit = getStringFlag(args, "to")
  const dryRun = getBooleanFlag(args, "dry-run")

  const pkgPath = findNearestPackageJson(ctx.cwd)
  if (!pkgPath) {
    ctx.stderr("voyant upgrade: no package.json found from the current directory.\n")
    return 1
  }

  const manifest = JSON.parse(readFileSync(pkgPath, "utf8")) as Manifest
  const targetDeps =
    (manifest.dependencies?.[pkgName] && manifest.dependencies) ||
    (manifest.devDependencies?.[pkgName] && manifest.devDependencies) ||
    null
  if (!targetDeps) {
    ctx.stderr(`voyant upgrade: ${pkgName} is not a dependency in ${pkgPath}.\n`)
    return 1
  }

  const current = targetDeps[pkgName] as string
  if (current.startsWith("workspace:")) {
    ctx.stdout(
      `voyant upgrade: ${pkgName} is a workspace dependency (${current}) — ` +
        "nothing to bump inside the monorepo.\n",
    )
    return 0
  }

  const resolveLatest = deps.resolveLatestVersion ?? defaultResolveLatestVersion
  const target = explicit ?? resolveLatest(pkgName)
  if (!target) {
    ctx.stderr(
      `voyant upgrade: could not resolve the latest ${pkgName} version ` +
        "(is npm reachable? pass --to <version>).\n",
    )
    return 1
  }

  const nextRange = normalizeRange(target)
  if (current === nextRange) {
    ctx.stdout(`Already on ${pkgName}@${current}.\n`)
    return 0
  }

  if (dryRun) {
    ctx.stdout(`Would update ${pkgName}: ${current} → ${nextRange} in ${pkgPath}\n`)
    return 0
  }

  targetDeps[pkgName] = nextRange
  writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`)
  ctx.stdout(`Updated ${pkgName}: ${current} → ${nextRange}\n`)

  const dir = dirname(pkgPath)
  const manager = detectPackageManager(dir)
  const runInstall = deps.runInstall ?? defaultRunInstall
  ctx.stdout(`Installing with ${manager}…\n`)
  const code = await runInstall(dir, manager)
  if (code !== 0) {
    ctx.stderr(`voyant upgrade: ${manager} install failed (exit ${code}).\n`)
    return code
  }

  ctx.stdout(
    "\nUpgraded. Next steps:\n" +
      "  voyant db migrate   # apply any new framework migrations\n" +
      "  voyant doctor       # verify env, schema, and admin composition\n",
  )
  return 0
}

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** Walk up from `cwd` to the nearest `package.json`. */
function findNearestPackageJson(cwd: string): string | null {
  let dir = cwd
  for (;;) {
    const candidate = join(dir, "package.json")
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = parsePath(dir).dir
    if (!parent || parent === dir) {
      return null
    }
    dir = parent
  }
}

/** Pin a resolved version as a caret range; pass through an explicit range. */
function normalizeRange(version: string): string {
  return /^[\^~><=*]|\s|x/.test(version) ? version : `^${version}`
}

/** pnpm-lock.yaml → pnpm, yarn.lock → yarn, bun.lockb → bun, else npm. */
function detectPackageManager(dir: string): string {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(dir, "yarn.lock"))) return "yarn"
  if (existsSync(join(dir, "bun.lockb"))) return "bun"
  return "npm"
}

function defaultResolveLatestVersion(pkg: string): string | null {
  try {
    return execFileSync("npm", ["view", pkg, "version"], { encoding: "utf8" }).trim() || null
  } catch {
    return null
  }
}

function defaultRunInstall(cwd: string, manager: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(manager, ["install"], { cwd, stdio: "inherit", shell: false })
    child.on("exit", (code) => resolve(code ?? 0))
    child.on("error", () => resolve(1))
  })
}
