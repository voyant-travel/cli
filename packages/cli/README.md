# `@voyant-travel/cli`

Unified CLI for the Voyant open-source framework and the Voyant Cloud platform.

```sh
npm i -g @voyant-travel/cli
voyant --help
```

## Open-source commands (no login)

| Command | What it does |
| --- | --- |
| `voyant new <name> [--preset operator-standard]` | Scaffold a clean convention-based project under `<name>/` |
| `voyant new <name> --starter <name\|path>` | Explicitly copy a legacy or custom starter into `<name>/` |
| `voyant new <name> --from-export <bundle.json> [--provider role=provider]` | Validate a Voyant Cloud export and generate its self-hosted Node project |
| `voyant generate module <name>` | Scaffold a conventional local module under `src/modules/<name>` |
| `voyant add\|install <package\|path>` | Install and explicitly select a module or plugin in `voyant.config.ts` |
| `voyant generate link <a> <b>` | Print a `defineLink` snippet — `<a>` and `<b>` as `<module>.<entity>` |
| `voyant config <show\|validate\|path>` | Inspect the nearest `voyant.config.*` |
| `voyant admin generate [--graph <artifact>]` | Emit packaged admin composition from config or a resolved deployment graph |
| `voyant doctor [--json]` | Validate that `.voyant/` represents the current project graph, then run env, database, and admin preflight checks |
| `voyant db <generate\|migrate\|studio\|push\|check>` | Proxy drizzle-kit to the project root |
| `voyant db sync-links [--out <file>]` | Emit DDL for cross-module link tables |
| `voyant exec <script.ts> [args…]` | Run a TS/JS script with native strip-types |
| `voyant theme init [directory]` | Scaffold a tour-capable Astro theme using the v1alpha4 contract |
| `voyant theme check [--json]` | Validate a theme with its project-installed `@voyant-travel/theme/tooling` |
| `voyant theme build [--json]` | Build a theme with its project-installed SDK tooling |
| `voyant theme dev [--host <h>] [--port <n>]` | Start the theme SDK development server |
| `voyant develop [--host <h>] [--port <n>]` | Keep `.voyant/` refreshed and run the full app through project-installed runtime tooling |
| `voyant start [--port <n>] [--probe]` | Start the project through its installed `@voyant-travel/runtime` |
| `voyant build [--json]` | Refresh `.voyant/` and build the full app through project-installed runtime tooling |
| `voyant build --artifacts-only [--json]` | Write deterministic `.voyant/` outputs without building the app |
| `voyant migrate [--json]` | Refresh `.voyant/` and execute the framework-authored migration plan |
| `voyant --version` | Print the CLI version |

### Generate from a self-host export

Use the framework-owned export contract to validate and project a Voyant Cloud
bundle into the standard small Node starter:

```sh
voyant new operator-self-hosted \
  --from-export ./voyant-self-host-export.json \
  --provider sms=twilio
```

Repeat `--provider role=provider` for each provider that needs an explicit
self-host override. The command refuses invalid bundles, unsupported providers,
and non-portable package sources before writing the target. `--force` replaces
an existing target only after validation and projection succeed. If replacement
and rollback both fail, the error reports the retained backup directory instead
of deleting the only recoverable copy. Provider override advice is printed only
for provider diagnostics; package diagnostics must be resolved at their source.

Generated `package.json` dependencies preserve exact admitted registry versions
and commit-pinned git references from the projected graph. Generation stops when
any starter dependency lacks an exact coordinate; it never substitutes
`latest`. The explicit
`defineProject` config retains module, extension, and plugin subpaths plus their
JSON config and projected self-host provider selections. Secret-bearing config
is rejected at the CLI boundary and must be supplied through deployment
environment requirements. Review
`SELF_HOST_PROVISIONING.md` before restoring the database and object storage;
the checklist records the migration-journal lineage and requires restoring its
ledger without replaying represented migrations. Missing journal rows, migration
content-hash mismatches, or unexplained schema drift are stop conditions, not a
reason to baseline over the restored database. The checklist and `.env.example`
contain requirement names but no secret values.

## Cloud commands (Voyant Cloud login)

| Command | What it does |
| --- | --- |
| `voyant login` | Browser device-code flow (RFC 8628) |
| `voyant login --token tok_…` | Paste-token mode (CI / headless) |
| `voyant logout` | Remove the stored credential |
| `voyant whoami` | Show the resolved API URL + token source |
| `voyant vaults list` | List vaults visible to the current credential |
| `voyant secrets list <vault>` | List secret keys + versions |
| `voyant secrets get <vault> <key>` | Fetch a single secret value (pipe-friendly) |
| `voyant secrets set <vault> <key> [value]` | Upsert a secret (stdin if value omitted) |
| `voyant secrets rm <vault> <key>` | Delete a secret |
| `voyant publish [--dir <dist>]` | Publish an admin UI extension from `voyant-extension.json` |
| `voyant extensions list [--filter listed\|installed\|mine]` | List extensions visible to the current organization |
| `voyant extensions installs` | List installed admin UI extensions |
| `voyant connector validate <manifest.json> [--probe]` | Validate a private connector manifest |
| `voyant connector register <manifest.json>` | Register a private connector provider |

## Configuration

`voyant develop`, `build`, `start`, and `migrate` load `.env` from the project
root. Variables already supplied by the shell or hosting platform take
precedence. App development and builds require the project-installed
`@voyant-travel/runtime/tooling` export; update `@voyant-travel/runtime` when an
older installation does not provide it.

Theme lifecycle commands similarly resolve `@voyant-travel/theme/tooling`
relative to the theme project. This keeps validation, diagnostics, builds, and
the Astro development server pinned to the SDK version declared by that theme;
the CLI does not carry a second copy of those rules. Use `voyant theme check
--json` for the SDK's deterministic structured report. Newly scaffolded themes
pin `@voyant-travel/theme` `0.1.0-alpha.14` and its `v1alpha4` contract, with
canonical tour index/detail routes and declarations for live search, pricing,
availability, booking, and checkout capabilities. The companion Astro
integration remains pinned to its independently published `0.1.0-alpha.13`
release. Scaffolds require CLI `^1.1.0`, the first release containing these
commands.

## Cloud configuration

Cloud commands accept these inputs in priority order:

- `--token <value>` flag
- `VOYANT_CLOUD_API_KEY` env var
- `~/.voyant/credentials.json` (created by `voyant login`, mode 0600,
  keyed by API URL — multiple environments coexist cleanly)

`--api-url <url>` and `VOYANT_CLOUD_API_URL` likewise override the default
`https://api.voyant.travel`.

## Framework project resolver contract

Project lifecycle commands resolve `@voyant-travel/framework/project` relative
to the project, never from the CLI's dependencies. That export must provide:

```ts
resolveProject({ project, projectRoot, configPath }): Promise<{
  graph: {
    schemaVersion: "voyant.resolved-graph.v1"
    contentHash: `sha256:${string}`
    diagnostics: readonly unknown[]
    deployment?: { target?: undefined }
  }
  artifacts: {
    runtimeEntry: string
    files: readonly { path: string; contents: string }[]
    migrationPlan: {
      schemaVersion: "voyant.migration-plan.v1"
      contentHash: string
      migrations: readonly unknown[]
    }
  }
}>
```

`project` is the default export loaded from the single `voyant.config.*` input.
Generated paths are relative to `.voyant/`, must not escape it, and the runtime
entry and migration plan must carry the graph's canonical `contentHash`.

## Programmatic use

`@voyant-travel/cli` exposes its lib helpers and command handlers for embedding
in scripts and other tools:

```ts
import { resolveSchemas } from "@voyant-travel/cli/drizzle"
import { runDeviceCodeFlow } from "@voyant-travel/cli/lib/device-code"
import { resolveCloudAuth } from "@voyant-travel/cli/lib/cloud-client"
import { setCredential } from "@voyant-travel/cli/lib/credentials"
import { loadThemeTooling } from "@voyant-travel/cli/lib/theme-tooling"
import { addCommand } from "@voyant-travel/cli/commands/add"
import { newCommand } from "@voyant-travel/cli/commands/new"
import { themeCommand } from "@voyant-travel/cli/commands/theme"
```

Subpath exports under `./commands/*` and `./lib/*` are stable; see the
package.json `exports` field for the full list.

## Requirements

- Node 20+ (Node 22.6+ recommended for the strip-types runner used by
  `voyant exec` and `voyant db sync-links`).

## Source

[github.com/voyant-travel/cli](https://github.com/voyant-travel/cli)

## License

Apache-2.0
