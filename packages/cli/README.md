# `@voyant-travel/cli`

Unified CLI for the Voyant open-source framework and the Voyant Cloud platform.

```sh
npm i -g @voyant-travel/cli
voyant --help
```

## Open-source commands (no login)

| Command | What it does |
| --- | --- |
| `voyant new <name> [--template <name\|path>]` | Clone a starter into `<name>/` |
| `voyant generate module <name>` | Scaffold a module package under `packages/<name>` |
| `voyant generate link <a> <b>` | Print a `defineLink` snippet — `<a>` and `<b>` as `<module>.<entity>` |
| `voyant config <show\|validate\|path>` | Inspect the nearest `voyant.config.*` |
| `voyant db <generate\|migrate\|studio\|push\|check>` | Proxy drizzle-kit to the project root |
| `voyant db sync-links [--out <file>]` | Emit DDL for cross-module link tables |
| `voyant exec <script.ts> [args…]` | Run a TS/JS script with native strip-types |
| `voyant dev --file <path>` | Watch + serve workflows locally |
| `voyant workflows <subcommand>` | Build, serve, inspect, and self-host workflows |
| `voyant --version` | Print the CLI version |

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

## Configuration

Cloud commands accept these inputs in priority order:

- `--token <value>` flag
- `VOYANT_CLOUD_API_KEY` env var
- `~/.voyant/credentials.json` (created by `voyant login`, mode 0600,
  keyed by API URL — multiple environments coexist cleanly)

`--api-url <url>` and `VOYANT_CLOUD_API_URL` likewise override the default
`https://api.voyant.travel`.

## Workflow bundles

`voyant workflows build --platform node` emits `bundle.mjs` for Node's native
ESM loader and expects the bundle to be imported from a filesystem path or
`file:` URL. Node bundles may include a `createRequire(import.meta.url)` shim so
valid Node dependencies that dynamically require built-ins such as `stream` can
load during manifest extraction and in the self-hosted Node runner.

Use `--platform neutral` or `--platform browser` for runtimes that do not load
workflow bundles from the filesystem.

## Programmatic use

`@voyant-travel/cli` exposes its lib helpers and command handlers for embedding
in scripts and other tools:

```ts
import { resolveSchemas } from "@voyant-travel/cli/drizzle"
import { runDeviceCodeFlow } from "@voyant-travel/cli/lib/device-code"
import { resolveCloudAuth } from "@voyant-travel/cli/lib/cloud-client"
import { setCredential } from "@voyant-travel/cli/lib/credentials"
import { newCommand } from "@voyant-travel/cli/commands/new"
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
