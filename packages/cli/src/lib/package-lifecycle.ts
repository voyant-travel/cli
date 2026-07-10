import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun"

export interface ProjectManifest {
  packageManager?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export interface ManifestDependency {
  section: "dependencies" | "devDependencies"
  version: string
}

export interface PackageSelectionTarget {
  selection: string
  installSpecifier: string
  packageName: string
  metadataPath: string
  plannedVersion: string
  versionExplicit: boolean
  local: boolean
}

export interface ProjectFileSnapshot {
  path: string
  contents: Buffer | null
}

export function readProjectManifest(packagePath: string): ProjectManifest {
  const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${packagePath} must contain a JSON object`)
  }
  return parsed as ProjectManifest
}

export function findManifestDependency(
  manifest: ProjectManifest,
  packageName: string,
): ManifestDependency | null {
  const dependency = manifest.dependencies?.[packageName]
  if (dependency !== undefined) return { section: "dependencies", version: dependency }
  const devDependency = manifest.devDependencies?.[packageName]
  if (devDependency !== undefined) {
    return { section: "devDependencies", version: devDependency }
  }
  return null
}

export function detectPackageManager(root: string, manifest: ProjectManifest): PackageManager {
  if (typeof manifest.packageManager === "string") {
    const manager = manifest.packageManager.split("@")[0]
    if (manager === "pnpm" || manager === "npm" || manager === "yarn" || manager === "bun") {
      return manager
    }
  }
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(root, "yarn.lock"))) return "yarn"
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun"
  return "npm"
}

export function resolvePackageSelectionTarget(
  projectRoot: string,
  requested: string,
): PackageSelectionTarget {
  const { base, fragment } = splitSelectionFragment(requested)
  if (isLocalSpecifier(base)) {
    const withoutFilePrefix = base.startsWith("file:") ? base.slice(5) : base
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
      selection: `./${relativePath}${fragment}`,
      installSpecifier: `./${relativePath}`,
      packageName,
      metadataPath,
      plannedVersion: `file:${relativePath}`,
      versionExplicit: true,
      local: true,
    }
  }

  const parsed = parseRegistrySpecifier(base)
  return {
    selection: `${parsed.selection}${fragment}`,
    installSpecifier: parsed.installSpecifier,
    packageName: parsed.packageName,
    metadataPath: join(
      projectRoot,
      "node_modules",
      ...parsed.packageName.split("/"),
      "package.json",
    ),
    plannedVersion: parsed.version ?? "latest",
    versionExplicit: parsed.version !== undefined,
    local: false,
  }
}

export function packageNameForSelection(projectRoot: string, selection: string): string | null {
  try {
    return resolvePackageSelectionTarget(projectRoot, selection).packageName
  } catch {
    return null
  }
}

export function snapshotPackageManagerFiles(root: string): ProjectFileSnapshot[] {
  return [
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
  ]
    .map((name) => join(root, name))
    .map((path) => ({ path, contents: existsSync(path) ? readFileSync(path) : null }))
}

function splitSelectionFragment(requested: string): { base: string; fragment: string } {
  const parts = requested.split("#")
  if (parts.length > 2) throw new Error(`invalid package specifier ${requested}`)
  const [base, unit] = parts
  if (!base) throw new Error(`invalid package specifier ${requested}`)
  if (unit === undefined) return { base, fragment: "" }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit)) {
    throw new Error(`invalid package unit fragment ${requested}`)
  }
  return { base, fragment: `#${unit}` }
}

export function restoreProjectFiles(snapshots: readonly ProjectFileSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.contents === null) {
      if (existsSync(snapshot.path)) unlinkSync(snapshot.path)
    } else {
      writeFileSync(snapshot.path, snapshot.contents)
    }
  }
}

function parseRegistrySpecifier(requested: string): {
  selection: string
  installSpecifier: string
  packageName: string
  version?: string
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
  const version = versionAt === -1 ? undefined : packageAndVersion.slice(versionAt + 1)
  if (
    !/^@[a-z0-9][a-z0-9._-]*$/.test(scope) ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(packagePart) ||
    (versionAt !== -1 && !version)
  ) {
    throw new Error(`invalid package specifier ${requested}`)
  }
  if (version && parts.length > 2) {
    throw new Error("versioned package selections cannot include a unit subpath")
  }

  const packageName = `${scope}/${packagePart}`
  return {
    packageName,
    installSpecifier: version ? `${packageName}@${version}` : packageName,
    selection: parts.length > 2 ? `${packageName}/${parts.slice(2).join("/")}` : packageName,
    ...(version ? { version } : {}),
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

function isLocalSpecifier(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("file:") ||
    isAbsolute(value)
  )
}
