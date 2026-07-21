import type { CommandContext, CommandResult } from "../types.js"

const USAGE = `voyant — Voyant CLI

USAGE
  voyant <command> [...args]

OPEN-SOURCE COMMANDS
  new <name> [--preset <name>]       Scaffold a clean project with standard defaults
  new <name> --starter <name|path>   Copy a legacy or custom starter explicitly
  new <name> --from-export <bundle>  Generate a self-hosted project from a Cloud export
                                     (--provider <role>=<provider> may be repeated)
  generate module <name>             Scaffold a local module under src/modules/<name>
  add|install <package|path>         Install and explicitly select a module or plugin
  remove|uninstall <package|path>    Remove a selected module or plugin and its dependency
  generate link <a> <b>              Emit a defineLink snippet (a, b as <module>.<entity>)
  config <show|validate|path>        Inspect the nearest voyant.config.* manifest
  admin generate [--check]           Emit admin.extensions.generated.ts from the manifest
                                     (--graph <artifact> derives selected admin packages from a resolved graph)
  admin generate --routes [--check]  Emit the code-assembled admin route module (--files: legacy thin files)
                                     (auto-includes the built-in core entry @voyant-travel/admin-app/core-extension
                                     when the package resolves with a ./core-extension export;
                                     pre-core hosts are unaffected)
  admin generate --destinations [--check]  Emit the generated destination resolver map (RFC 4.7)
  admin doctor                       Check manifest <-> admin extension <-> route/destination parity
                                     (generated-destination drift gates: exit 1; the rest reports)
  doctor [--config <path>] [--strict] [--skip-*] [--json]
                                     Preflight: env/bindings (env.d.ts <-> wrangler.jsonc +
                                     placeholders) + current .voyant graph artifacts +
                                     db doctor + admin doctor (exit 1 on any gate)
  upgrade [package] [--to <version>] [--plan]  Bump a dependency with a graph-aware plan
                                     (then run: voyant db migrate && voyant doctor)
  develop [--host <h>] [--port <n>] Prepare and run the full application in development mode
  start [--port <n>] [--probe]       Start with the project's installed Voyant runtime
  build [--artifacts-only] [--json]  Prepare artifacts and build the full application
  migrate [--plan|--dry-run] [--json] Refresh and execute the graph's Node migration runner
  db <generate|migrate|studio|push>  Proxy drizzle-kit commands (generate defaults to --prefix timestamp)
  db schemas [--emit]                Print/emit the manifest-derived schema list
  db sync-links [--emit-drizzle]     Emit link-table DDL, or a generated Drizzle schema
  db doctor [--fail-on-drift]        Report graph artifacts or legacy migration drift
  exec <script.ts> [args...]         Run a TS/JS script with the voyant loader hook

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
  publish [--dir <dist>] [--yes]     Publish an admin UI extension from voyant-extension.json
  extensions list [--filter <kind>]  List extensions (kind: listed, installed, mine)
  extensions installs                List installed extensions
  connector validate <manifest> [--probe]
                                     Validate a private connector manifest
  connector register <manifest>      Register a private connector provider
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
  voyant new my-app --preset operator-standard
  voyant new my-app --starter operator        # explicit legacy compatibility path
  voyant new my-app --from-export ./voyant-export.json --provider sms=twilio
  voyant generate module invoices
  voyant generate link crm.person products.product --right-list
  voyant config show
  voyant admin generate --check
  voyant admin generate --graph deployment-graph.generated.json
  voyant admin generate --routes
  voyant admin generate --destinations
  voyant admin doctor
  voyant develop --port 3300
  voyant build --artifacts-only --json
  voyant start --port 8080
  voyant migrate --plan --json
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
  voyant publish --dir dist --yes
  voyant extensions list --filter mine
  voyant connector validate ./connector.json --probe
  voyant connector register ./connector.json
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
