import { parseArgs } from "../lib/args.js"
import { clientFromFlags, fail, out, printJson, runCloud, wantsJson } from "../lib/output.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant secrets <subcommand>` — Voyant Cloud Vault secret management.
 *
 * Subcommands:
 *   - `list <vault>`            — list secret keys + versions (NO values)
 *   - `set <vault> <key> [val]` — upsert a secret value (stdin if omitted)
 *   - `rm <vault> <key>`        — delete a secret
 *
 * There is deliberately no `get`: the CLI cannot decrypt secrets. CLI tokens
 * are minted without the `vault:read` scope that the decrypt endpoints require,
 * so even a hand-rolled call would be rejected. Reveal a value in the
 * dashboard, or use a server-side app token with `vault:read`.
 */
export async function secretsCommand(ctx: CommandContext): Promise<CommandResult> {
  const [sub, ...rest] = ctx.argv
  if (!sub || sub === "help") {
    ctx.stdout("Usage: voyant secrets <list|set|rm> [...args]\n")
    return sub ? 0 : 1
  }

  if (sub === "list") return secretsListCommand({ ...ctx, argv: rest })
  if (sub === "set") return secretsSetCommand({ ...ctx, argv: rest })
  if (sub === "rm") return secretsRmCommand({ ...ctx, argv: rest })

  if (sub === "get") {
    ctx.stderr(
      "`voyant secrets get` was removed: the CLI cannot decrypt secrets. " +
        "Reveal a value in the dashboard, or use a server token with vault:read.\n",
    )
    return 1
  }

  ctx.stderr(`Unknown secrets subcommand: ${sub}. Expected "list", "set", or "rm".\n`)
  return 1
}

async function secretsListCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [vault] = args.positionals
  if (!vault) return fail(ctx, args, "Usage: voyant secrets list <vault> [--json]", "usage")

  const client = clientFromFlags(ctx, args)
  if (!client) return 1

  return runCloud(ctx, args, async () => {
    const secrets = await client.vault.listSecrets(vault)
    if (wantsJson(args)) return printJson(ctx, secrets)
    if (secrets.length === 0) return out(ctx, `No secrets in ${vault}.\n`)
    for (const s of secrets) ctx.stdout(`${s.key}  v${s.version}  (updated ${s.updatedAt})\n`)
    return 0
  })
}

async function secretsSetCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [vault, key, valueArg] = args.positionals
  if (!vault || !key) {
    ctx.stderr(
      "Usage: voyant secrets set <vault> <key> [value] [--json]\n" +
        "If <value> is omitted, the secret is read from stdin.\n",
    )
    return 1
  }

  let value: string
  if (typeof valueArg === "string") {
    value = valueArg
  } else {
    try {
      value = await readAllStdin()
    } catch (err) {
      return fail(
        ctx,
        args,
        `Failed to read value from stdin: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (value.length === 0) {
      return fail(
        ctx,
        args,
        "Empty value (no positional arg and stdin was empty). Aborting.",
        "usage",
      )
    }
  }

  const client = clientFromFlags(ctx, args)
  if (!client) return 1

  return runCloud(ctx, args, async () => {
    const summary = await client.vault.setSecret(vault, key, value)
    if (wantsJson(args)) return printJson(ctx, summary)
    return out(ctx, `Set ${vault}/${summary.key} (v${summary.version})\n`)
  })
}

async function secretsRmCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const [vault, key] = args.positionals
  if (!vault || !key) return fail(ctx, args, "Usage: voyant secrets rm <vault> <key>", "usage")

  const client = clientFromFlags(ctx, args)
  if (!client) return 1

  return runCloud(ctx, args, async () => {
    await client.vault.deleteSecret(vault, key)
    if (wantsJson(args)) return printJson(ctx, { deleted: key })
    return out(ctx, `Deleted ${vault}/${key.toUpperCase()}\n`)
  })
}

/**
 * Read all of process.stdin until EOF. Used by `secrets set` when the caller
 * pipes a value in (e.g. `cat .env | voyant secrets set prod KEY`).
 *
 * We trim a single trailing newline because `echo "value" | ...` always
 * appends one. Multi-line secrets keep their internal newlines.
 */
function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    })
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8").replace(/\n$/, ""))
    })
    process.stdin.on("error", reject)
  })
}
