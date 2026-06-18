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
  doctor [--strict] [--skip-*]       Preflight: env/bindings (env.d.ts <-> wrangler.jsonc +
                                     placeholders) + db doctor + admin doctor (exit 1 on any gate)
  upgrade [--to <version>] [--dry-run]  Bump the @voyant-travel/framework BOM + install
                                     (then run: voyant db migrate && voyant doctor)
  dev --file <path>                  Watch and serve workflows locally with hot reload
  db <generate|migrate|studio|push>  Proxy drizzle-kit commands (generate defaults to --prefix timestamp)
  db schemas [--emit]                Print/emit the manifest-derived schema list
  db sync-links [--emit-drizzle]     Emit link-table DDL, or a generated Drizzle schema
  db doctor [--fail-on-drift]        Report migration drift (manifest/schema/prefix/link checks)
  exec <script.ts> [args...]         Run a TS/JS script with the voyant loader hook
  workflows <subcommand>             Build, serve, inspect, and self-host workflows

CLOUD COMMANDS  (need a Voyant Cloud token; add --json for machine output)
  login [--token <value>]            Authorize via browser device flow (or paste a token)
  logout [--org <slug>]              Remove a stored credential (one org or all)
  whoami                             Show the API URL, token source, and active org
  org <list|use|current>             Pick which org to target when you're in several
  apps <list|get|create|delete>      Manage apps
  env <list|set|rm> <app> [--env]    Manage an app environment's variables
  deploy <app> [--env]               Trigger a deployment
  deploy <list|get|logs|cancel|rollback> <app> [id]
                                     Inspect and control deployments
  databases <list|get|create|delete|branches|connection>
                                     Manage Neon / D1 databases
  storage buckets <list|create|delete>  Manage R2 buckets
  vaults list                        List vaults in the active org
  secrets list <vault>               List secret keys + versions (no values)
  secrets set <vault> <key> [value]  Upsert a secret (stdin if value omitted)
  secrets rm <vault> <key>           Delete a secret
  logs <app> [--level] [--since]     Read a deployed app's runtime logs
  logs <app> --follow                Stream new runtime logs live (tail -f)

GLOBAL CLOUD FLAGS
  --org <slug|id>                    Target organization (when logged in to several)
  --token <token>                    Voyant Cloud API token
  --api-url <url>                    Voyant Cloud API base URL
  --json                             Machine-readable output
  --yes, -y                          Approve destructive actions non-interactively

  --help, -h                         Show this help
  --version, -v                      Show CLI version

The CLI cannot decrypt secrets (no 'secrets get'): CLI tokens lack the
vault:read scope. Reveal values in the dashboard or with a server token.

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
  voyant whoami --json
  voyant org list
  voyant org use acme
  voyant apps list --json
  voyant env list my-app --env production --json
  voyant env set my-app STRIPE_KEY sk_live_xyz --secret
  voyant deploy my-app
  voyant databases list --json
  voyant storage buckets list
  voyant vaults list --json
  voyant secrets list production
  voyant secrets set production STRIPE_KEY sk_live_xyz
  voyant secrets rm production OLD_KEY --yes
  voyant logs my-app --level error --since 1h
  voyant logs my-app --follow --json
`

export function helpCommand(ctx: CommandContext): CommandResult {
  ctx.stdout(USAGE)
  return 0
}
