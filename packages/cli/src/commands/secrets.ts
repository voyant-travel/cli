import type { VaultSecretSummary, VaultSecretValue } from "@voyant-travel/cloud-sdk"

import { getStringFlag, parseArgs } from "../lib/args.js"
import { CloudAuthError, createCloudClient } from "../lib/cloud-client.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant secrets <subcommand>` — Voyant Cloud Vault secret operations.
 *
 * Subcommands:
 *   - `list <vault>`            — list secret keys in a vault (no values)
 *   - `get <vault> <key>`       — fetch a single secret value
 *   - `set <vault> <key> [val]` — upsert a secret value (stdin if omitted)
 *   - `rm <vault> <key>`        — delete a secret
 *
 * `set` / `rm` use `client.transport.request` directly because typed
 * helpers (`vault.setSecret`, `vault.deleteSecret`) only land in
 * `@voyant-travel/cloud-sdk@0.7.0` — refactor to `client.vault.setSecret(...)`
 * once the CLI bumps its cloud-sdk dep.
 */
export async function secretsCommand(ctx: CommandContext): Promise<CommandResult> {
  const [sub, ...rest] = ctx.argv
  if (!sub) {
    ctx.stderr("Usage: voyant secrets <list|get|set|rm> [...args]\n")
    return 1
  }

  if (sub === "list") return secretsListCommand({ ...ctx, argv: rest })
  if (sub === "get") return secretsGetCommand({ ...ctx, argv: rest })
  if (sub === "set") return secretsSetCommand({ ...ctx, argv: rest })
  if (sub === "rm") return secretsRmCommand({ ...ctx, argv: rest })

  ctx.stderr(`Unknown secrets subcommand: ${sub}. Expected "list", "get", "set", or "rm".\n`)
  return 1
}

async function secretsListCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [vault] = args.positionals
  if (!vault) {
    ctx.stderr("Usage: voyant secrets list <vault> [--token <tok>] [--json]\n")
    return 1
  }

  const json = args.flags.json === true

  let client: ReturnType<typeof createCloudClient>
  try {
    client = createCloudClient({
      token: getStringFlag(args, "token"),
      apiUrl: getStringFlag(args, "api-url"),
    })
  } catch (err) {
    if (err instanceof CloudAuthError) {
      ctx.stderr(`${err.message}\n`)
      return 1
    }
    throw err
  }

  let secrets: VaultSecretSummary[]
  try {
    secrets = await client.vault.listSecrets(vault)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to list secrets in ${vault}: ${reason}\n`)
    return 1
  }

  if (json) {
    ctx.stdout(`${JSON.stringify(secrets, null, 2)}\n`)
    return 0
  }

  if (secrets.length === 0) {
    ctx.stdout(`No secrets in ${vault}.\n`)
    return 0
  }

  for (const s of secrets) {
    ctx.stdout(`${s.key}  v${s.version}  (updated ${s.updatedAt})\n`)
  }
  return 0
}

async function secretsGetCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [vault, key] = args.positionals
  if (!vault || !key) {
    ctx.stderr("Usage: voyant secrets get <vault> <key> [--token <tok>] [--json]\n")
    return 1
  }

  const json = args.flags.json === true

  let client: ReturnType<typeof createCloudClient>
  try {
    client = createCloudClient({
      token: getStringFlag(args, "token"),
      apiUrl: getStringFlag(args, "api-url"),
    })
  } catch (err) {
    if (err instanceof CloudAuthError) {
      ctx.stderr(`${err.message}\n`)
      return 1
    }
    throw err
  }

  let secret: VaultSecretValue
  try {
    secret = await client.vault.getSecret(vault, key)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to fetch ${vault}/${key}: ${reason}\n`)
    return 1
  }

  if (json) {
    ctx.stdout(`${JSON.stringify(secret, null, 2)}\n`)
    return 0
  }

  // Plain mode: print just the value, no trailing newline confusion. This
  // is the shell-pipe-friendly default — mirrors `gh secret get` etc.
  ctx.stdout(secret.value)
  return 0
}

async function secretsSetCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [vault, key, valueArg] = args.positionals
  if (!vault || !key) {
    ctx.stderr(
      "Usage: voyant secrets set <vault> <key> [value] [--token <tok>] [--json]\n" +
        "If <value> is omitted, the secret is read from stdin.\n",
    )
    return 1
  }

  const json = args.flags.json === true

  // Resolve the value: positional > stdin. We avoid logging the value back
  // even on success — only the metadata envelope is shown.
  let value: string
  if (typeof valueArg === "string") {
    value = valueArg
  } else {
    try {
      value = await readAllStdin()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.stderr(`Failed to read value from stdin: ${reason}\n`)
      return 1
    }
    if (value.length === 0) {
      ctx.stderr("Empty value (no positional arg and stdin was empty). Aborting.\n")
      return 1
    }
  }

  let client: ReturnType<typeof createCloudClient>
  try {
    client = createCloudClient({
      token: getStringFlag(args, "token"),
      apiUrl: getStringFlag(args, "api-url"),
    })
  } catch (err) {
    if (err instanceof CloudAuthError) {
      ctx.stderr(`${err.message}\n`)
      return 1
    }
    throw err
  }

  // Raw transport call: typed `client.vault.setSecret` ships in cloud-sdk
  // 0.7.0; the CLI's pinned 0.6.x doesn't expose it yet.
  let summary: VaultSecretSummary
  try {
    summary = await client.transport.request<VaultSecretSummary>(
      `/vault/v1/${encodeURIComponent(vault)}/secrets/${encodeURIComponent(key)}`,
      { method: "POST", body: { value } },
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to set ${vault}/${key}: ${reason}\n`)
    return 1
  }

  if (json) {
    ctx.stdout(`${JSON.stringify(summary, null, 2)}\n`)
    return 0
  }

  ctx.stdout(`Set ${vault}/${summary.key} (v${summary.version})\n`)
  return 0
}

async function secretsRmCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [vault, key] = args.positionals
  if (!vault || !key) {
    ctx.stderr("Usage: voyant secrets rm <vault> <key> [--token <tok>]\n")
    return 1
  }

  let client: ReturnType<typeof createCloudClient>
  try {
    client = createCloudClient({
      token: getStringFlag(args, "token"),
      apiUrl: getStringFlag(args, "api-url"),
    })
  } catch (err) {
    if (err instanceof CloudAuthError) {
      ctx.stderr(`${err.message}\n`)
      return 1
    }
    throw err
  }

  // Raw transport call (see secretsSetCommand for why).
  try {
    await client.transport.request<void>(
      `/vault/v1/${encodeURIComponent(vault)}/secrets/${encodeURIComponent(key)}`,
      { method: "DELETE" },
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to delete ${vault}/${key}: ${reason}\n`)
    return 1
  }

  ctx.stdout(`Deleted ${vault}/${key.toUpperCase()}\n`)
  return 0
}

/**
 * Read all of process.stdin until EOF. Used by `secrets set` when the
 * caller pipes a value in (e.g. `cat .env | voyant secrets set prod KEY`).
 *
 * We trim a single trailing newline because `echo "value" | ...` always
 * appends one and would otherwise round-trip as `"value\n"`. Multi-line
 * secrets keep their internal newlines.
 */
function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    })
    process.stdin.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8")
      resolve(text.replace(/\n$/, ""))
    })
    process.stdin.on("error", reject)
  })
}
