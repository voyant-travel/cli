import { randomBytes } from "node:crypto"
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { z } from "zod"

export const THEME_PROJECT_LINK_SCHEMA_VERSION = "voyant.theme-project-link.v1" as const
export const THEME_PROJECT_LINK_RELATIVE_PATH = ".voyant/theme-project-link.json" as const

const THEME_CONFIG_FILENAMES = [
  "theme.config.ts",
  "theme.config.mts",
  "theme.config.mjs",
  "theme.config.js",
  "theme.config.cjs",
] as const

const themeProjectLinkSchema = z
  .object({
    schemaVersion: z.literal(THEME_PROJECT_LINK_SCHEMA_VERSION),
    apiUrl: z.string().url(),
    organizationId: z.string().trim().min(1),
    themeId: z.string().trim().min(1),
    siteId: z.string().trim().min(1).optional(),
    installationId: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.installationId && !value.siteId) {
      context.addIssue({
        code: "custom",
        message: "installationId requires siteId",
        path: ["installationId"],
      })
    }
  })

export type ThemeProjectLink = z.infer<typeof themeProjectLinkSchema>

export type ThemeProjectLinkErrorCode =
  | "theme_project_not_found"
  | "theme_project_path_unsafe"
  | "theme_project_link_invalid"
  | "theme_project_link_io_failed"

export class ThemeProjectLinkError extends Error {
  readonly code: ThemeProjectLinkErrorCode

  constructor(code: ThemeProjectLinkErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ThemeProjectLinkError"
    this.code = code
  }
}

export interface ResolvedThemeProject {
  projectRoot: string
  configPath: string
  linkPath: string
}

export interface ResolveThemeProjectOptions {
  cwd: string
  configFile?: string
}

/** Locate a theme config and return canonical paths that cannot escape its project root. */
export async function resolveThemeProject(
  options: ResolveThemeProjectOptions,
): Promise<ResolvedThemeProject> {
  const cwd = await canonicalDirectory(options.cwd)
  const configPath = options.configFile
    ? await resolveExplicitConfig(cwd, options.configFile)
    : await findThemeConfig(cwd)
  if (!configPath) {
    throw new ThemeProjectLinkError(
      "theme_project_not_found",
      "No theme.config.* was found. Run this command inside a Voyant Theme Project or pass --config.",
    )
  }

  const canonicalConfig = await canonicalRegularFile(configPath, "Theme config")
  const projectRoot = dirname(canonicalConfig)
  const linkPath = resolve(projectRoot, THEME_PROJECT_LINK_RELATIVE_PATH)
  assertContained(projectRoot, linkPath, "Theme Project Link")
  return { projectRoot, configPath: canonicalConfig, linkPath }
}

/** Parse unknown data as the complete, non-secret v1 link contract. */
export function parseThemeProjectLink(value: unknown): ThemeProjectLink {
  const parsed = themeProjectLinkSchema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
      .join("; ")
    throw new ThemeProjectLinkError(
      "theme_project_link_invalid",
      `Theme Project Link is invalid (${detail}). Run \`voyant theme unlink\` and link it again.`,
    )
  }
  return parsed.data
}

/** Read and validate link state. A missing link is represented by null. */
export async function readThemeProjectLink(
  project: ResolvedThemeProject,
): Promise<ThemeProjectLink | null> {
  assertContained(project.projectRoot, project.linkPath, "Theme Project Link")
  try {
    const info = await lstat(project.linkPath)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ThemeProjectLinkError(
        "theme_project_path_unsafe",
        `Theme Project Link must be a regular file: ${project.linkPath}`,
      )
    }
    const raw = await readFile(project.linkPath, "utf8")
    return parseThemeProjectLink(JSON.parse(raw) as unknown)
  } catch (error) {
    if (isMissing(error)) return null
    if (error instanceof ThemeProjectLinkError) throw error
    if (error instanceof SyntaxError) {
      throw new ThemeProjectLinkError(
        "theme_project_link_invalid",
        `Theme Project Link contains invalid JSON: ${project.linkPath}. Run \`voyant theme unlink\` and link it again.`,
        { cause: error },
      )
    }
    throw ioError("read", project.linkPath, error)
  }
}

/** Atomically replace link state without ever persisting credentials or caller-specific extras. */
export async function writeThemeProjectLink(
  project: ResolvedThemeProject,
  input: ThemeProjectLink,
): Promise<ThemeProjectLink> {
  const link = parseThemeProjectLink(input)
  assertContained(project.projectRoot, project.linkPath, "Theme Project Link")
  const directory = dirname(project.linkPath)
  const temporary = join(
    directory,
    `.theme-project-link.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  )

  try {
    await ensureSafeLinkDirectory(project.projectRoot, directory)
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(link, null, 2)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, project.linkPath)
    return link
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    if (error instanceof ThemeProjectLinkError) throw error
    throw ioError("write", project.linkPath, error)
  }
}

/** Remove only local link state. Returns false when no link existed. */
export async function removeThemeProjectLink(project: ResolvedThemeProject): Promise<boolean> {
  assertContained(project.projectRoot, project.linkPath, "Theme Project Link")
  try {
    const info = await lstat(project.linkPath)
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new ThemeProjectLinkError(
        "theme_project_path_unsafe",
        `Theme Project Link must be a regular file: ${project.linkPath}`,
      )
    }
    await unlink(project.linkPath)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    if (error instanceof ThemeProjectLinkError) throw error
    throw ioError("remove", project.linkPath, error)
  }
}

export interface ThemeTargetSelectors {
  theme?: string
  site?: string
  installation?: string
  apiUrl?: string
  organization?: string
}

export interface ResolvedThemeTargetSelectors {
  theme?: string
  site?: string
  installation?: string
  apiUrl?: string
  organization?: string
  sources: {
    theme?: "explicit" | "link"
    site?: "explicit" | "link"
    installation?: "explicit" | "link"
    apiUrl?: "explicit" | "link"
    organization?: "explicit" | "link"
  }
}

/** Resolve field-level precedence: explicit command flags always beat local link defaults. */
export function resolveThemeTargetSelectors(
  explicit: ThemeTargetSelectors,
  link: ThemeProjectLink | null,
): ResolvedThemeTargetSelectors {
  const pick = (explicitValue: string | undefined, linkedValue: string | undefined) => ({
    value: explicitValue ?? linkedValue,
    source:
      explicitValue !== undefined
        ? ("explicit" as const)
        : linkedValue !== undefined
          ? ("link" as const)
          : undefined,
  })
  const theme = pick(explicit.theme, link?.themeId)
  const site = pick(explicit.site, link?.siteId)
  const installation = pick(explicit.installation, link?.installationId)
  const apiUrl = pick(explicit.apiUrl, link?.apiUrl)
  const organization = pick(explicit.organization, link?.organizationId)
  return {
    theme: theme.value,
    site: site.value,
    installation: installation.value,
    apiUrl: apiUrl.value,
    organization: organization.value,
    sources: {
      theme: theme.source,
      site: site.source,
      installation: installation.source,
      apiUrl: apiUrl.source,
      organization: organization.source,
    },
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    const canonical = await realpath(resolve(path))
    const info = await lstat(canonical)
    if (!info.isDirectory()) throw new Error("not a directory")
    return canonical
  } catch (error) {
    throw new ThemeProjectLinkError(
      "theme_project_not_found",
      `Theme project directory does not exist: ${path}`,
      { cause: error },
    )
  }
}

async function resolveExplicitConfig(cwd: string, requested: string): Promise<string> {
  const candidate = isAbsolute(requested) ? requested : resolve(cwd, requested)
  try {
    return await realpath(candidate)
  } catch (error) {
    throw new ThemeProjectLinkError(
      "theme_project_not_found",
      `Theme config was not found: ${requested}`,
      { cause: error },
    )
  }
}

async function findThemeConfig(start: string): Promise<string | null> {
  let current = start
  while (true) {
    for (const filename of THEME_CONFIG_FILENAMES) {
      const candidate = join(current, filename)
      try {
        return await realpath(candidate)
      } catch (error) {
        if (!isMissing(error)) throw ioError("inspect", candidate, error)
      }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function canonicalRegularFile(path: string, label: string): Promise<string> {
  const canonical = await realpath(path)
  const info = await lstat(canonical)
  if (!info.isFile()) {
    throw new ThemeProjectLinkError("theme_project_path_unsafe", `${label} is not a file: ${path}`)
  }
  return canonical
}

async function ensureSafeLinkDirectory(projectRoot: string, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  const canonical = await realpath(directory)
  assertContained(projectRoot, canonical, "Theme Project Link directory")
}

function assertContained(root: string, target: string, label: string): void {
  const path = relative(root, target)
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) return
  throw new ThemeProjectLinkError(
    "theme_project_path_unsafe",
    `${label} must stay inside the Theme Project root.`,
  )
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}

function ioError(operation: string, path: string, cause: unknown): ThemeProjectLinkError {
  return new ThemeProjectLinkError(
    "theme_project_link_io_failed",
    `Could not ${operation} Theme Project Link at ${path}.`,
    { cause },
  )
}
