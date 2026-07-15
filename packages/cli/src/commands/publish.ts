import { lstat, readdir, readFile } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"
import { gzipSync } from "node:zlib"

import { VoyantApiError, type VoyantCloudClient } from "@voyant-travel/cloud-sdk"
import { z } from "zod"

import { getStringFlag, parseArgs } from "../lib/args.js"
import {
  clientFromFlags,
  confirmDestructive,
  fail,
  out,
  printJson,
  runCloud,
  wantsJson,
} from "../lib/output.js"
import type { CommandContext, CommandResult } from "../types.js"

export const EXTENSION_MANIFEST_FILENAME = "voyant-extension.json"
const EXTENSION_MANIFEST_SCHEMA_VERSION = "voyant.extension-manifest.v1"
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024

export const EXTENSION_TARGET_SLOTS = [
  "dashboard.header",
  "dashboard.after-kpis",
  "dashboard.footer",
  "booking.details.header",
  "booking.details.after-summary",
  "invoice.details.header",
  "invoice.details.after-summary",
  "workspace.header.actions",
] as const

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SEMVER_RANGE_RE = /^[0-9A-Za-z.*~^<>=|&! -]+$/

const extensionManifestSchema = z
  .object({
    schemaVersion: z.literal(EXTENSION_MANIFEST_SCHEMA_VERSION),
    key: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
        "must use lowercase letters, numbers, ., _, or -",
      ),
    displayName: z.string().min(1),
    description: z.string().min(1).optional(),
    version: z.string().regex(SEMVER_RE, "must be a semantic version like 1.2.3"),
    extensionApi: z.string().min(1).regex(SEMVER_RANGE_RE, "must be a semver range like ^1.0.0"),
    entry: z.string().min(1),
    targets: z
      .array(
        z.object({
          slot: z.enum(EXTENSION_TARGET_SLOTS),
        }),
      )
      .min(1)
      .max(4),
    configSchema: z.unknown().optional(),
  })
  .strict()

export type CloudExtensionManifest = z.infer<typeof extensionManifestSchema>

export interface ExtensionSummary {
  key: string
  displayName?: string
  latestVersion?: string
  visibility?: string
  status?: string
  installedAt?: string
  appSlug?: string
  environment?: string
}

export interface ExtensionSdk {
  create(
    input: Pick<CloudExtensionManifest, "key" | "displayName" | "description">,
  ): Promise<unknown>
  publishVersion(input: { manifest: CloudExtensionManifest; bundle: Uint8Array }): Promise<unknown>
  list(filter?: { filter?: string }): Promise<ExtensionSummary[]>
  get(key: string): Promise<unknown>
  update(key: string, input: Record<string, unknown>): Promise<unknown>
  install(input: Record<string, unknown>): Promise<unknown>
  updateInstall(id: string, input: Record<string, unknown>): Promise<unknown>
  uninstall(id: string): Promise<unknown>
  listInstalls(): Promise<ExtensionSummary[]>
}

const USAGE = `Usage: voyant publish [--dir <dist>] [--yes] [--json]

Publish the admin UI extension in the current directory.

Options:
  --dir <path>       Bundle directory (default: dist)
  --yes, -y          Create a new extension key when it does not exist
  --org <slug|id>    Target organization
  --token <token>    Voyant Cloud API token
  --api-url <url>    Voyant Cloud API base URL
  --json             Machine-readable output

Examples:
  voyant publish --dir dist --yes
  voyant publish --json
`

export async function publishCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  if (args.positionals[0] === "help") {
    ctx.stdout(USAGE)
    return 0
  }

  let manifest: CloudExtensionManifest
  let bundle: Uint8Array
  try {
    manifest = await readExtensionManifest(ctx.cwd)
    const bundleDir = resolve(ctx.cwd, getStringFlag(args, "dir") ?? "dist")
    bundle = await createExtensionBundleArchive(bundleDir, manifest.entry)
  } catch (err) {
    return fail(ctx, args, err instanceof Error ? err.message : String(err), "validation_failed")
  }

  const client = clientFromFlags(ctx, args)
  if (!client) return 1
  const extensions = extensionSdk(client)

  return runCloud(ctx, args, async () => {
    const exists = await extensionExists(extensions, manifest.key)
    if (!exists) {
      if (!confirmDestructive(ctx, args, `create extension key ${manifest.key}`)) return 1
      await extensions.create({
        key: manifest.key,
        displayName: manifest.displayName,
        description: manifest.description,
      })
    }

    const published = await extensions.publishVersion({ manifest, bundle })
    if (wantsJson(args)) {
      return printJson(ctx, {
        key: manifest.key,
        version: manifest.version,
        created: !exists,
        published,
      })
    }

    return out(
      ctx,
      `Published ${manifest.key}@${manifest.version}.\nNew extensions start private and are managed from the Voyant Cloud console.\n`,
    )
  })
}

export async function readExtensionManifest(cwd: string): Promise<CloudExtensionManifest> {
  const path = join(cwd, EXTENSION_MANIFEST_FILENAME)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    throw new Error(`${EXTENSION_MANIFEST_FILENAME} not found in ${cwd}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `${EXTENSION_MANIFEST_FILENAME} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  return validateExtensionManifest(parsed)
}

export function validateExtensionManifest(value: unknown): CloudExtensionManifest {
  const result = extensionManifestSchema.safeParse(value)
  if (result.success) return result.data
  throw new Error(`Extension manifest validation failed:\n${formatZodIssues(result.error.issues)}`)
}

export async function createExtensionBundleArchive(
  bundleDir: string,
  entry: string,
): Promise<Uint8Array> {
  const root = resolve(bundleDir)
  const entryPath = resolve(root, entry)
  if (!entryPath.startsWith(`${root}${sep}`) && entryPath !== root) {
    throw new Error(`Bundle entry escapes the bundle directory: ${entry}`)
  }

  try {
    const stat = await lstat(entryPath)
    if (!stat.isFile()) throw new Error()
  } catch {
    throw new Error(`Bundle entry not found: ${entry}`)
  }

  const entries = await collectBundleEntries(root)
  const archive = gzipSync(
    Buffer.concat([...entries.map((entry) => entryToTarBlocks(entry)), Buffer.alloc(1024)]),
  )
  if (archive.byteLength > MAX_BUNDLE_BYTES) {
    throw new Error(
      `Extension bundle is ${formatBytes(archive.byteLength)} gzipped; maximum is ${formatBytes(
        MAX_BUNDLE_BYTES,
      )}`,
    )
  }
  return archive
}

async function extensionExists(extensions: ExtensionSdk, key: string): Promise<boolean> {
  try {
    await extensions.get(key)
    return true
  } catch (err) {
    if (err instanceof VoyantApiError && err.status === 404) return false
    throw err
  }
}

export function extensionSdk(client: VoyantCloudClient): ExtensionSdk {
  const maybe = client as VoyantCloudClient & { extensions?: ExtensionSdk }
  if (maybe.extensions) return maybe.extensions

  return {
    create: (input) =>
      client.transport.request("/cloud/v1/extensions", {
        body: input,
        method: "POST",
      }),
    publishVersion: ({ manifest, bundle }) => {
      const form = new FormData()
      form.append("manifest", new Blob([JSON.stringify(manifest)], { type: "application/json" }))
      form.append(
        "bundle",
        new Blob([Buffer.from(bundle)], { type: "application/gzip" }),
        "bundle.tar.gz",
      )
      return client.transport.request(
        `/cloud/v1/extensions/${encodeURIComponent(manifest.key)}/versions`,
        {
          body: form,
          method: "POST",
        },
      )
    },
    list: (filter) =>
      client.transport.request("/cloud/v1/extensions", {
        query: filter?.filter ? { filter: filter.filter } : undefined,
      }),
    get: (key) => client.transport.request(`/cloud/v1/extensions/${encodeURIComponent(key)}`),
    update: (key, input) =>
      client.transport.request(`/cloud/v1/extensions/${encodeURIComponent(key)}`, {
        body: input,
        method: "PATCH",
      }),
    install: (input) =>
      client.transport.request("/cloud/v1/extensions/installs", {
        body: input,
        method: "POST",
      }),
    updateInstall: (id, input) =>
      client.transport.request(`/cloud/v1/extensions/installs/${encodeURIComponent(id)}`, {
        body: input,
        method: "PATCH",
      }),
    uninstall: (id) =>
      client.transport.request(`/cloud/v1/extensions/installs/${encodeURIComponent(id)}`, {
        method: "DELETE",
        responseType: "text",
      }),
    listInstalls: () => client.transport.request("/cloud/v1/extensions/installs"),
  }
}

interface BundleEntry {
  path: string
  data: Buffer
  mode: number
  mtime: Date
}

async function collectBundleEntries(root: string): Promise<BundleEntry[]> {
  const entries: BundleEntry[] = []
  await walk(root, root, entries)
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return entries
}

async function walk(root: string, current: string, entries: BundleEntry[]): Promise<void> {
  const items = await readdir(current, { withFileTypes: true })
  for (const item of items) {
    const abs = join(current, item.name)
    const stat = await lstat(abs)
    if (stat.isDirectory()) {
      await walk(root, abs, entries)
      continue
    }
    if (!stat.isFile()) {
      throw new Error(`Bundle contains unsupported non-file entry: ${normalizeTarPath(root, abs)}`)
    }
    entries.push({
      path: normalizeTarPath(root, abs),
      data: await readFile(abs),
      mode: stat.mode & 0o777,
      mtime: stat.mtime,
    })
  }
}

function normalizeTarPath(root: string, abs: string): string {
  const rel = relative(root, abs).split(sep).join("/")
  if (!rel || rel.startsWith("../") || rel === ".." || rel.includes("/../")) {
    throw new Error(`Bundle path escapes the bundle directory: ${rel}`)
  }
  return rel
}

function entryToTarBlocks(entry: BundleEntry): Buffer {
  const header = Buffer.alloc(512, 0)
  writeTarName(header, entry.path)
  writeOctal(header, 100, 8, entry.mode || 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, entry.data.byteLength)
  writeOctal(header, 136, 12, Math.floor(entry.mtime.getTime() / 1000))
  header.fill(0x20, 148, 156)
  header[156] = "0".charCodeAt(0)
  header.write("ustar", 257, "ascii")
  header.write("00", 263, "ascii")
  header.write("voyant", 265, "ascii")
  header.write("voyant", 297, "ascii")

  let checksum = 0
  for (const byte of header) checksum += byte
  writeOctal(header, 148, 8, checksum)

  const padding = Buffer.alloc((512 - (entry.data.byteLength % 512)) % 512, 0)
  return Buffer.concat([header, entry.data, padding])
}

function writeTarName(header: Buffer, path: string): void {
  const nameBytes = Buffer.byteLength(path)
  if (nameBytes <= 100) {
    header.write(path, 0, 100, "utf8")
    return
  }

  const dir = path.slice(0, -basename(path).length - 1)
  const file = basename(path)
  if (Buffer.byteLength(file) > 100 || Buffer.byteLength(dir) > 155) {
    throw new Error(`Bundle path is too long for ustar: ${path}`)
  }
  header.write(file, 0, 100, "utf8")
  header.write(dir, 345, 155, "utf8")
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const str = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(0, length - 1)
  header.write(str, offset, length - 1, "ascii")
  header[offset + length - 1] = 0
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map(
      (issue) => `- ${issue.path.length > 0 ? issue.path.join(".") : "manifest"}: ${issue.message}`,
    )
    .join("\n")
}

function formatBytes(value: number): string {
  return `${(value / (1024 * 1024)).toFixed(2)}MB`
}
