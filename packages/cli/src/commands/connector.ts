import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { VoyantApiError } from "@voyant-travel/cloud-sdk"
import { z } from "zod"

import { parseArgs } from "../lib/args.js"
import { clientFromFlags, fail, printJson, runCloud, wantsJson } from "../lib/output.js"
import type { CommandContext, CommandResult } from "../types.js"

const REQUIRED_PROVIDER_SCOPE = "connect:providers:write"

const USAGE = `Usage: voyant connector <command> <manifest.json>

Validate or register a private connector manifest.

Commands:
  validate <manifest.json> [--probe]  Validate a connector manifest
  register <manifest.json>            Register a connector provider

Options:
  --probe                             Fetch .well-known manifest from externalAdapter.baseUrl
  --org <slug|id>                     Target organization
  --token <token>                     Voyant Cloud API token
  --api-url <url>                     Voyant Cloud API base URL
  --json                              Machine-readable output

Examples:
  voyant connector validate ./connector.json --probe
  voyant connector register ./connector.json --json
`

const connectorManifestSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .regex(
        /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
        "must use lowercase letters, numbers, and hyphens; start and end with a letter or number; max 64 characters",
      ),
    displayName: z.string().min(1),
    authModel: z.enum(["platform_managed", "bring_your_own_credentials", "hybrid"]),
    accessModel: z.enum(["open", "credential_scoped", "approval_required"]),
    capabilities: z.array(z.string().min(1)).min(1),
    categoryCoverage: z.array(z.string().min(1)).min(1),
    supportedDirections: z.array(z.string().min(1)).min(1),
    metadata: z
      .object({
        externalAdapter: z
          .object({
            type: z.literal("external_adapter"),
            baseUrl: z.string().superRefine((value, ctx) => {
              const parsed = parseUrl(value)
              if (!parsed || parsed.protocol !== "https:") {
                ctx.addIssue({ code: "custom", message: "must be an https URL" })
                return
              }
              if (parsed.username || parsed.password || parsed.search || parsed.hash) {
                ctx.addIssue({
                  code: "custom",
                  message: "must not include credentials, query, or fragment",
                })
              }
            }),
            protocolVersion: z.string().min(1).optional(),
          })
          .optional(),
        hostedWorker: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((manifest, ctx) => {
    if (!manifest.metadata.externalAdapter) {
      ctx.addIssue({
        code: "custom",
        path: ["metadata", "externalAdapter"],
        message: "is required for private connector manifests",
      })
    }
    if (manifest.metadata.externalAdapter && manifest.metadata.hostedWorker !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["metadata", "hostedWorker"],
        message: "is mutually exclusive with metadata.externalAdapter",
      })
    }
  })

export type ConnectorManifest = z.infer<typeof connectorManifestSchema>

interface ProbeResult {
  ok: boolean
  url: string
  status?: number
  key?: string
  message: string
}

interface ConnectorRegistrationResponse {
  key: string
  signingSecret?: string
  [key: string]: unknown
}

export async function connectorCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [sub, manifestPath] = args.positionals

  if (!sub || sub === "help") {
    ctx.stdout(USAGE)
    return sub ? 0 : 1
  }

  switch (sub) {
    case "validate":
      if (!manifestPath) {
        return fail(
          ctx,
          args,
          "Usage: voyant connector validate <manifest.json> [--probe]",
          "usage",
        )
      }
      return validateConnectorCommand(ctx, args, manifestPath)
    case "register":
      if (!manifestPath) {
        return fail(ctx, args, "Usage: voyant connector register <manifest.json>", "usage")
      }
      return registerConnectorCommand(ctx, args, manifestPath)
    default:
      return fail(ctx, args, `Unknown connector subcommand: ${sub}`, "usage")
  }
}

async function validateConnectorCommand(
  ctx: CommandContext,
  args: ReturnType<typeof parseArgs>,
  manifestPath: string,
): Promise<CommandResult> {
  let manifest: ConnectorManifest
  try {
    manifest = await readConnectorManifest(ctx.cwd, manifestPath)
  } catch (err) {
    return fail(ctx, args, err instanceof Error ? err.message : String(err), "validation_failed")
  }

  let probe: ProbeResult | undefined
  if (args.flags.probe === true) {
    probe = await probeConnectorManifest(manifest)
    if (!probe.ok && probe.status !== 404) {
      if (wantsJson(args)) return printJson(ctx, { valid: false, manifest, probe })
      ctx.stdout(`Connector manifest is valid.\nProbe failed: ${probe.message}\n`)
      return 1
    }
  }

  if (wantsJson(args)) return printJson(ctx, { valid: true, manifest, probe })
  ctx.stdout(`Connector manifest is valid: ${manifest.key}\n`)
  if (probe) ctx.stdout(`${probe.message}\n`)
  return 0
}

async function registerConnectorCommand(
  ctx: CommandContext,
  args: ReturnType<typeof parseArgs>,
  manifestPath: string,
): Promise<CommandResult> {
  let manifest: ConnectorManifest
  try {
    manifest = await readConnectorManifest(ctx.cwd, manifestPath)
  } catch (err) {
    return fail(ctx, args, err instanceof Error ? err.message : String(err), "validation_failed")
  }

  const client = clientFromFlags(ctx, args)
  if (!client) return 1

  return runCloud(ctx, args, async () => {
    try {
      const response = await client.transport.request<ConnectorRegistrationResponse>(
        "/connect/v1/connector-providers",
        { body: manifest, method: "POST" },
      )
      if (wantsJson(args)) return printJson(ctx, response)
      const key = response.key ?? manifest.key
      ctx.stdout(`Registered connector provider ${key}.\n`)
      if (response.signingSecret) {
        ctx.stdout(`Signing secret (shown once, store it now): ${response.signingSecret}\n`)
      }
      return 0
    } catch (err) {
      if (err instanceof VoyantApiError && err.status === 403) {
        return fail(
          ctx,
          args,
          `Missing required scope ${REQUIRED_PROVIDER_SCOPE}. Re-authenticate with a token that includes ${REQUIRED_PROVIDER_SCOPE}.`,
          "missing_scope",
        )
      }
      if (err instanceof VoyantApiError && err.status === 409) {
        return fail(
          ctx,
          args,
          `Connector provider key already exists: ${manifest.key}`,
          "key_conflict",
        )
      }
      throw err
    }
  })
}

export async function readConnectorManifest(
  cwd: string,
  manifestPath: string,
): Promise<ConnectorManifest> {
  const path = resolve(cwd, manifestPath)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    throw new Error(`Connector manifest not found: ${manifestPath}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `Connector manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return validateConnectorManifest(parsed)
}

export function validateConnectorManifest(value: unknown): ConnectorManifest {
  const result = connectorManifestSchema.safeParse(value)
  if (result.success) return result.data
  throw new Error(`Connector manifest validation failed:\n${formatZodIssues(result.error.issues)}`)
}

export async function probeConnectorManifest(manifest: ConnectorManifest): Promise<ProbeResult> {
  const baseUrl = manifest.metadata.externalAdapter?.baseUrl
  if (!baseUrl) {
    return {
      ok: false,
      url: "",
      message: "Probe skipped: metadata.externalAdapter.baseUrl is missing.",
    }
  }

  const parsedBaseUrl = new URL(baseUrl)
  parsedBaseUrl.pathname = `${parsedBaseUrl.pathname.replace(/\/$/, "")}/.well-known/voyant-connect/manifest`
  const url = parsedBaseUrl.toString()
  try {
    const response = await fetch(url)
    if (response.status === 404) {
      return {
        ok: false,
        url,
        status: response.status,
        message: `Probe manifest absent at ${url}; continuing because this well-known endpoint is optional.`,
      }
    }
    if (!response.ok) {
      return {
        ok: false,
        url,
        status: response.status,
        message: `Probe failed at ${url}: HTTP ${response.status}`,
      }
    }
    const body = (await response.json()) as { key?: unknown }
    if (body.key !== manifest.key) {
      return {
        ok: false,
        url,
        status: response.status,
        key: typeof body.key === "string" ? body.key : undefined,
        message: `Probe key mismatch: expected ${manifest.key}, got ${String(body.key)}`,
      }
    }
    return {
      ok: true,
      url,
      status: response.status,
      key: manifest.key,
      message: `Probe reached ${url}; key matches ${manifest.key}.`,
    }
  } catch (err) {
    return {
      ok: false,
      url,
      message: `Probe failed at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map(
      (issue) => `- ${issue.path.length > 0 ? issue.path.join(".") : "manifest"}: ${issue.message}`,
    )
    .join("\n")
}
