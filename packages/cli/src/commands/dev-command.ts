import { existsSync, readFileSync, watch as watchFs } from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { parseArgs } from "../lib/args.js"
import { resolveConfigPath } from "../lib/config-loader.js"
import {
  PROJECT_ARTIFACT_DIRECTORY,
  PROJECT_ARTIFACT_MANIFEST,
  prepareProjectArtifacts,
} from "../lib/project-artifacts.js"
import { waitForShutdownSignal } from "../lib/shutdown.js"
import type { CommandContext, CommandResult } from "../types.js"
import { type DevDeps, defaultDevDeps, parseServeOptions, runDev } from "./dev.js"

export interface DevCommandDeps {
  devDeps?: DevDeps
  prepareArtifacts?: typeof prepareProjectArtifacts
  watchProjectInputs?: ProjectInputWatcherFactory
  waitForShutdown?: (cleanup: () => Promise<void>) => Promise<void>
}

interface ProjectWatchInput {
  projectRoot: string
  configPath: string
  graph: Record<string, unknown>
}

type ProjectInputWatcherFactory = (
  input: ProjectWatchInput,
  onChange: () => Promise<void>,
) => { close: () => void }

export async function devCommand(
  ctx: CommandContext,
  deps: DevCommandDeps = {},
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  if (args.flags.help === true || args.flags.h === true) {
    ctx.stdout(`${DEV_USAGE}\n`)
    return 0
  }

  const parsed = parseServeOptions(args)
  if (!parsed.ok) {
    ctx.stderr(`${parsed.message}\n`)
    return parsed.exitCode
  }

  const entry = await resolveDevEntryFile(ctx.cwd, args.flags, deps.prepareArtifacts)
  if (!entry.ok) {
    ctx.stderr(`${entry.message}\n`)
    return 2
  }

  const outDir = typeof args.flags.out === "string" ? args.flags.out : ".voyant/dev"

  let handle: { close: () => Promise<void>; url: string } | undefined
  let projectWatcher: { close: () => void } | undefined
  let refreshQueue = Promise.resolve()
  try {
    const devDeps = deps.devDeps ?? (await defaultDevDeps())
    handle = await runDev(
      { entryFile: entry.file, outDir, options: parsed.options, contentHash: entry.contentHash },
      devDeps,
    )
    if (entry.project) {
      const prepareArtifacts = deps.prepareArtifacts ?? prepareProjectArtifacts
      const watchInputs = deps.watchProjectInputs ?? watchProjectInputs
      let project = entry.project
      const refresh = (): Promise<void> => {
        const next = refreshQueue.then(async () => {
          try {
            const prepared = await prepareArtifacts(ctx.cwd, {
              configPath: project.configPath,
            })
            if (handle) await handle.close()
            handle = await runDev(
              {
                entryFile: prepared.runtimeEntryPath,
                outDir,
                options: parsed.options,
                contentHash: prepared.manifest.graphHash,
              },
              devDeps,
            )
            project = {
              projectRoot: prepared.projectRoot,
              configPath: prepared.resolution.configPath,
              graph: prepared.graph,
            }
            const nextWatcher = watchInputs(project, refresh)
            projectWatcher?.close()
            projectWatcher = nextWatcher
            ctx.stderr(`voyant dev: project graph refreshed ${prepared.manifest.graphHash}\n`)
          } catch (error) {
            ctx.stderr(
              `voyant dev: project refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
            )
          }
        })
        refreshQueue = next
        return next
      }
      projectWatcher = watchInputs(project, refresh)
    }
  } catch (err) {
    projectWatcher?.close()
    if (handle) await handle.close()
    ctx.stderr(`voyant dev: failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  ctx.stderr(`voyant dev: listening at ${handle.url}\n`)
  ctx.stderr(`  watching ${entry.file}\n`)
  if (entry.manifest) ctx.stderr(`  graph     ${entry.manifest}\n`)
  if (entry.contentHash) ctx.stderr(`  hash      ${entry.contentHash}\n`)
  ctx.stderr(`  output   ${outDir}\n`)
  ctx.stderr("Press Ctrl+C to stop.\n")

  const closeProjectWatcher = (): void => {
    projectWatcher?.close()
    projectWatcher = undefined
  }
  try {
    await (deps.waitForShutdown ?? waitForShutdownSignal)(async () => {
      closeProjectWatcher()
      await refreshQueue
      closeProjectWatcher()
      if (handle) await handle.close()
    })
  } catch (err) {
    ctx.stderr(`voyant dev: failed to stop: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  return 0
}

const DEV_USAGE = `voyant dev - watch and serve workflows locally

usage:
  voyant dev [--file <path>] [--config <path>] [--deployment-artifacts <path>] [--port <n>] [--host <h>] [--out <dir>] [--dashboard <path>]
`

const DEFAULT_DEPLOYMENT_ARTIFACTS = "deployment-artifacts.generated.json"
const MANAGED_NODE_RUNTIME_KIND = "managed-profile-node"

interface DeploymentArtifactManifest {
  schemaVersion?: unknown
  graphHash?: unknown
  runtimeEntries?: unknown
}

interface RuntimeEntryArtifact {
  target?: unknown
  file?: unknown
  kind?: unknown
}

type DevEntryResult =
  | {
      ok: true
      file: string
      manifest?: string
      contentHash?: string
      project?: ProjectWatchInput
    }
  | {
      ok: false
      message: string
    }

async function resolveDevEntryFile(
  cwd: string,
  flags: Record<string, string | boolean>,
  prepareArtifacts: typeof prepareProjectArtifacts = prepareProjectArtifacts,
): Promise<DevEntryResult> {
  if (typeof flags.file === "string") {
    return { ok: true, file: flags.file }
  }

  const configFlag = typeof flags.config === "string" ? flags.config : undefined
  const projectConfig = resolveConfigPath({ cwd, path: configFlag })
  if (projectConfig && flags["deployment-artifacts"] === undefined) {
    try {
      const prepared = await prepareArtifacts(cwd, { configPath: projectConfig })
      return {
        ok: true,
        file: prepared.runtimeEntryPath,
        manifest: join(PROJECT_ARTIFACT_DIRECTORY, PROJECT_ARTIFACT_MANIFEST),
        contentHash: prepared.manifest.graphHash,
        project: {
          projectRoot: prepared.projectRoot,
          configPath: prepared.resolution.configPath,
          graph: prepared.graph,
        },
      }
    } catch (error) {
      return {
        ok: false,
        message: `voyant dev: project preparation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }
  if (configFlag && !projectConfig) {
    return { ok: false, message: `voyant dev: project config was not found: ${configFlag}` }
  }

  const manifestPath =
    typeof flags["deployment-artifacts"] === "string"
      ? flags["deployment-artifacts"]
      : DEFAULT_DEPLOYMENT_ARTIFACTS
  const resolvedManifestPath = resolve(cwd, manifestPath)
  if (!existsSync(resolvedManifestPath)) {
    return {
      ok: false,
      message:
        "voyant dev: missing --file <path> and no deployment-artifacts.generated.json was found",
    }
  }

  let manifest: DeploymentArtifactManifest
  try {
    manifest = JSON.parse(readFileSync(resolvedManifestPath, "utf8")) as DeploymentArtifactManifest
  } catch (err) {
    return {
      ok: false,
      message: `voyant dev: could not read deployment artifacts: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }

  if (manifest.schemaVersion !== "voyant.deployment-artifacts.v1") {
    return {
      ok: false,
      message: `voyant dev: deployment artifacts schema must be voyant.deployment-artifacts.v1, got ${String(
        manifest.schemaVersion,
      )}`,
    }
  }

  if (!Array.isArray(manifest.runtimeEntries)) {
    return {
      ok: false,
      message: "voyant dev: deployment artifacts runtimeEntries must be an array",
    }
  }

  const runtimeEntry = manifest.runtimeEntries.find(isManagedNodeRuntimeEntry)
  if (!runtimeEntry) {
    return {
      ok: false,
      message: "voyant dev: deployment artifacts do not declare a managed Node runtime entry",
    }
  }

  return {
    ok: true,
    file: resolveArtifactPath(String(runtimeEntry.file), resolvedManifestPath),
    manifest: manifestPath,
    contentHash: typeof manifest.graphHash === "string" ? manifest.graphHash : undefined,
  }
}

function isManagedNodeRuntimeEntry(value: unknown): value is RuntimeEntryArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as RuntimeEntryArtifact
  return (
    entry.target === "node" &&
    entry.kind === MANAGED_NODE_RUNTIME_KIND &&
    typeof entry.file === "string" &&
    entry.file.length > 0
  )
}

function resolveArtifactPath(file: string, manifestPath: string): string {
  if (isAbsolute(file)) return file
  return join(dirname(manifestPath), file)
}

function watchProjectInputs(
  input: ProjectWatchInput,
  onChange: () => Promise<void>,
): { close: () => void } {
  const watchedFiles = collectProjectInputFiles(input)
  const filesByDirectory = new Map<string, Set<string>>()
  for (const file of watchedFiles) {
    const directory = dirname(file)
    if (!existsSync(directory)) continue
    const names = filesByDirectory.get(directory) ?? new Set<string>()
    names.add(basename(file))
    filesByDirectory.set(directory, names)
  }

  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleRefresh = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void onChange()
    }, 75)
  }
  const watchers = [...filesByDirectory].map(([directory, names]) =>
    watchFs(directory, (_event, filename) => {
      if (!filename || names.has(filename.toString())) scheduleRefresh()
    }),
  )

  return {
    close: () => {
      closed = true
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
  }
}

function collectProjectInputFiles(input: ProjectWatchInput): string[] {
  const files = new Set<string>([
    input.configPath,
    join(input.projectRoot, "package.json"),
    join(input.projectRoot, "pnpm-lock.yaml"),
    join(input.projectRoot, "package-lock.json"),
    join(input.projectRoot, "yarn.lock"),
    join(input.projectRoot, "bun.lock"),
    join(input.projectRoot, "bun.lockb"),
  ])
  const projectRequire = createRequire(join(input.projectRoot, "package.json"))

  for (const record of recordArray(input.graph.packageRecords)) {
    const packageName = stringValue(record.packageName)
    const metadata = recordValue(record.metadata)
    const manifest = stringValue(metadata?.manifest)
    const source = recordValue(record.source)
    if (source?.kind === "file") {
      const reference = stringValue(source.reference)
      if (reference) {
        const packageRoot = resolve(input.projectRoot, reference.replace(/^file:/, ""))
        for (const candidate of [
          "package.json",
          "voyant.ts",
          "src/voyant.ts",
          "dist/voyant.js",
          "dist/voyant.mjs",
        ]) {
          files.add(join(packageRoot, candidate))
        }
      }
    }
    if (!packageName || !manifest) continue
    const specifier =
      manifest === "." ? packageName : `${packageName}/${manifest.replace(/^\.\//, "")}`
    try {
      files.add(projectRequire.resolve(specifier))
    } catch {
      // Resolution will produce the actionable diagnostic during the next refresh.
    }
  }
  return [...files]
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : []
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
