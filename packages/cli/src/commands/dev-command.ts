import { parseArgs } from "../lib/args.js"
import { waitForShutdownSignal } from "../lib/shutdown.js"
import type { CommandContext, CommandResult } from "../types.js"
import { type DevDeps, defaultDevDeps, parseServeOptions, runDev } from "./dev.js"

export interface DevCommandDeps {
  devDeps?: DevDeps
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

  const entryFile = typeof args.flags.file === "string" ? args.flags.file : undefined
  if (!entryFile) {
    ctx.stderr("voyant dev: missing required --file <path>\n")
    return 2
  }

  const outDir = typeof args.flags.out === "string" ? args.flags.out : ".voyant/dev"

  let handle: { close: () => Promise<void>; url: string } | undefined
  try {
    handle = await runDev(
      { entryFile, outDir, options: parsed.options },
      deps.devDeps ?? (await defaultDevDeps()),
    )
  } catch (err) {
    ctx.stderr(`voyant dev: failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  ctx.stderr(`voyant dev: listening at ${handle.url}\n`)
  ctx.stderr(`  watching ${entryFile}\n`)
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
  voyant dev --file <path> [--port <n>] [--host <h>] [--out <dir>] [--dashboard <path>]
`
