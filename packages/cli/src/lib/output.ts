import type { CommandContext, CommandResult } from "../types.js"
import { getBooleanFlag, getStringFlag, type ParsedArgs } from "./args.js"
import { CloudAuthError, createCloudClient, type ResolveCloudAuthOptions } from "./cloud-client.js"

/**
 * Agent-ready output helpers.
 *
 * Every cloud command supports `--json` for machine consumption and resolves
 * auth/org from a shared set of global flags (`--token`, `--api-url`, `--org`),
 * so an agent can drive the CLI non-interactively with stable, parseable I/O.
 */

/** True when the caller passed `--json` (or `--output json`). */
export function wantsJson(args: ParsedArgs): boolean {
  if (getBooleanFlag(args, "json")) return true
  return getStringFlag(args, "output", "o") === "json"
}

/** Print a value as pretty JSON with a trailing newline. Returns exit code 0. */
export function printJson(ctx: CommandContext, value: unknown): 0 {
  ctx.stdout(`${JSON.stringify(value, null, 2)}\n`)
  return 0
}

/** Write `text` to stdout and return exit code 0 (handy for terse `return out(...)`). */
export function out(ctx: CommandContext, text: string): 0 {
  ctx.stdout(text)
  return 0
}

/**
 * Report an error and return exit code 1. In `--json` mode emits a stable
 * `{ "error": { "code", "message" } }` envelope to stderr; otherwise a plain
 * line. `code` defaults to a generic value so agents can branch on it.
 */
export function fail(ctx: CommandContext, args: ParsedArgs, message: string, code = "error"): 1 {
  if (wantsJson(args)) {
    ctx.stderr(`${JSON.stringify({ error: { code, message } })}\n`)
  } else {
    ctx.stderr(`${message}\n`)
  }
  return 1
}

/** Convert an unknown thrown value to a message string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The standard global flags shared by every cloud command. Resolve once and
 * pass into {@link createCloudClient} / output helpers.
 */
export interface GlobalCloudFlags extends ResolveCloudAuthOptions {
  json: boolean
}

export function resolveGlobalFlags(args: ParsedArgs): GlobalCloudFlags {
  return {
    token: getStringFlag(args, "token"),
    apiUrl: getStringFlag(args, "api-url"),
    org: getStringFlag(args, "org"),
    json: wantsJson(args),
  }
}

/**
 * Build a cloud client from the global flags, mapping auth failures to a
 * `not_authenticated` JSON error. Returns null on failure (caller returns 1).
 */
export function clientFromFlags(
  ctx: CommandContext,
  args: ParsedArgs,
): ReturnType<typeof createCloudClient> | null {
  try {
    return createCloudClient(resolveGlobalFlags(args))
  } catch (err) {
    if (err instanceof CloudAuthError) {
      fail(ctx, args, err.message, "not_authenticated")
      return null
    }
    throw err
  }
}

/**
 * Confirm a destructive action. Auto-approves when `--yes`/`-y` is passed.
 * In a non-interactive context (no TTY) without `--yes`, refuses rather than
 * hanging on a prompt — agents must opt in explicitly with `--yes`.
 */
export function confirmDestructive(ctx: CommandContext, args: ParsedArgs, what: string): boolean {
  if (getBooleanFlag(args, "yes", "y")) return true
  if (!process.stdout.isTTY) {
    fail(
      ctx,
      args,
      `Refusing to ${what} without confirmation. Re-run with --yes to proceed.`,
      "confirmation_required",
    )
    return false
  }
  // Interactive prompting is intentionally not implemented yet; require --yes
  // everywhere so behavior is identical in and out of a TTY.
  fail(ctx, args, `Re-run with --yes to ${what}.`, "confirmation_required")
  return false
}

/** Run a sub-handler and translate uncaught errors into a JSON-aware failure. */
export async function runCloud(
  ctx: CommandContext,
  args: ParsedArgs,
  handler: () => Promise<CommandResult>,
): Promise<CommandResult> {
  try {
    return await handler()
  } catch (err) {
    return fail(ctx, args, errorMessage(err))
  }
}
