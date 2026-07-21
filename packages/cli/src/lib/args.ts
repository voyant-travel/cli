/**
 * Minimal POSIX-ish argv parser.
 *
 * Recognises:
 * - `--flag` → boolean flag (true)
 * - `--key value` and `--key=value` → string value
 * - `-x` → short boolean flag (true)
 * - Everything else → positional
 *
 * Does not support short-flag clustering (`-xyz`) or numeric coercion.
 */
export interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | boolean>
}

export interface ParseArgsOptions {
  booleanFlags?: ReadonlyArray<string>
}

export function parseArgs(argv: ReadonlyArray<string>, options: ParseArgsOptions = {}): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  const booleanFlags = new Set(options.booleanFlags)

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === undefined) continue

    if (token.startsWith("--")) {
      const body = token.slice(2)
      if (body.startsWith("no-")) {
        flags[body] = true
        flags[body.slice(3)] = false
        continue
      }
      const eq = body.indexOf("=")
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      if (booleanFlags.has(body)) {
        flags[body] = true
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }
      continue
    }

    if (token.startsWith("-") && token.length > 1) {
      flags[token.slice(1)] = true
      continue
    }

    positionals.push(token)
  }

  return { positionals, flags }
}

export function getStringFlag(args: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags[name]
    if (typeof value === "string") return value
  }
  return undefined
}

export function getBooleanFlag(args: ParsedArgs, ...names: string[]): boolean {
  for (const name of names) {
    const value = args.flags[name]
    if (typeof value === "boolean") return value
  }
  return false
}

export function getNumberFlag(args: ParsedArgs, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args.flags[name]
    if (typeof value === "string") return Number(value)
  }
  return undefined
}
