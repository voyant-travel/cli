import type { CommandContext, CommandResult } from "../types.js"

const USAGE = `voyant — Voyant CLI

USAGE
  voyant <command> [...args]

OPEN-SOURCE COMMANDS
  new <name> [--template <name|path>] Scaffold a new project from a template
  generate module <name>             Scaffold a new module package under packages/<name>
  generate link <a> <b>              Emit a defineLink snippet (a, b as <module>.<entity>)
  config <show|validate|path>        Inspect the nearest voyant.config.* manifest
  admin generate [--check]           Emit admin.extensions.generated.ts from the manifest
  admin generate --routes [--check]  Emit the code-assembled admin route module (--files: legacy thin files)
                                     (auto-includes the built-in core entry @voyant-travel/admin-app/core-extension
                                     when the package resolves with a ./core-extension export;
                                     pre-core hosts are unaffected)
  admin generate --destinations [--check]  Emit the generated destination resolver map (RFC 4.7)
  admin doctor                       Check manifest <-> admin extension <-> route/destination parity
                                     (generated-destination drift gates: exit 1; the rest reports)
  dev --file <path>                  Watch and serve workflows locally with hot reload
  db <generate|migrate|studio|push>  Proxy drizzle-kit commands (generate defaults to --prefix timestamp)
  db schemas [--emit]                Print/emit the manifest-derived schema list
  db sync-links [--emit-drizzle]     Emit link-table DDL, or a generated Drizzle schema
  db doctor [--fail-on-drift]        Report migration drift (manifest/schema/prefix/link checks)
  exec <script.ts> [args...]         Run a TS/JS script with the voyant loader hook
  workflows <subcommand>             Build, serve, inspect, and self-host workflows

CLOUD COMMANDS  (need a Voyant Cloud token)
  login [--token <value>]            Authorize via browser device flow (or paste a token)
  logout                             Remove the stored credential
  whoami                             Show the resolved API URL and token source
  vaults list                        List vaults visible to the current credential
  secrets list <vault>               List secret keys + versions in a vault
  secrets get <vault> <key>          Fetch a single secret value
  secrets set <vault> <key> [value]  Upsert a secret (stdin if value omitted)
  secrets rm <vault> <key>           Delete a secret

  --help, -h                         Show this help
  --version, -v                      Show CLI version

EXAMPLES
  voyant new my-app --template operator
  voyant generate module invoices
  voyant generate link crm.person products.product --right-list
  voyant config show
  voyant admin generate --check
  voyant admin generate --routes
  voyant admin generate --destinations
  voyant admin doctor
  voyant db generate
  voyant exec ./scripts/backfill.ts --dry-run
  voyant login                                # browser device flow
  voyant login --token tok_live_abc123        # paste-token mode (CI/headless)
  voyant whoami
  voyant vaults list --json
  voyant secrets list production
  voyant secrets get production DATABASE_URL
  voyant secrets set production STRIPE_KEY sk_live_xyz
  voyant secrets rm production OLD_KEY
`

export function helpCommand(ctx: CommandContext): CommandResult {
  ctx.stdout(USAGE)
  return 0
}
