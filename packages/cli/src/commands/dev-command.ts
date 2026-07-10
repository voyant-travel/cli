import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
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
  waitForShutdown?: (cleanup: () => Promise<void>) => Promise<void>
}

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
  try {
    handle = await runDev(
      { entryFile: entry.file, outDir, options: parsed.options, contentHash: entry.contentHash },
      deps.devDeps ?? (await defaultDevDeps()),
    )
  } catch (err) {
    ctx.stderr(`voyant dev: failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  ctx.stderr(`voyant dev: listening at ${handle.url}\n`)
  ctx.stderr(`  watching ${entry.file}\n`)
  if (entry.manifest) ctx.stderr(`  graph     ${entry.manifest}\n`)
  if (entry.contentHash) ctx.stderr(`  hash      ${entry.contentHash}\n`)
  ctx.stderr(`  output   ${outDir}\n`)
  ctx.stderr("Press Ctrl+C to stop.\n")

  try {
    await (deps.waitForShutdown ?? waitForShutdownSignal)(async () => {
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
