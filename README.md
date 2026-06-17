# Voyant CLI

Unified command-line tool for the Voyant open-source framework and the
Voyant Cloud platform. Ships as a single binary, no login required for the
open-source workflows.

```sh
npm i -g @voyant-travel/cli
voyant --help
```

## What it does

**Open source — no login required**

Scaffolding, code generation, config inspection, database tooling, and a
TypeScript script runner. These commands work standalone against any
Voyant project.

```sh
voyant new my-app                          # scaffold from a starter
voyant generate module invoices            # add a new module package
voyant generate link crm.person products.product --right-list
voyant config show                         # inspect voyant.config.ts
voyant db generate                         # drizzle-kit pass-through
voyant db sync-links                       # SQL DDL for module links
voyant exec ./scripts/backfill.ts          # run a TS script with native strip-types
voyant workflows build --file ./src/workflows.ts
voyant dev --file ./src/workflows.ts
```

**Cloud — needs a Voyant Cloud login**

Authenticate once, then drive Voyant Cloud from your terminal.

```sh
voyant login                               # browser device flow
voyant login --token tok_live_…            # CI / headless mode
voyant whoami
voyant logout

voyant vaults list
voyant secrets list production
voyant secrets get production DATABASE_URL
voyant secrets set production STRIPE_KEY sk_live_xyz
voyant secrets rm production OLD_KEY
```

## Login flows

`voyant login` runs an OAuth 2.0 device-code grant ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628))
against `https://api.voyant.travel/cli/v1/device/*`. It prints a verification
URL, opens it in your browser (suppress with `--no-browser`), and polls
until you approve. The minted token is stored in
`~/.voyant/credentials.json` (mode 0600), keyed by API URL — so you can be
logged into multiple environments at once (prod, staging, self-hosted).

For CI or headless use, mint an API token in the dashboard tokens UI and
run `voyant login --token tok_live_xyz`. Same outcome, no browser hop.

Token resolution order on every cloud command:

1. `--token <value>` flag
2. `VOYANT_CLOUD_API_KEY` env var
3. `~/.voyant/credentials.json` for the resolved API URL

## Status

- **0.19.0** — first release from this repo.
- Earlier `0.18.x` was published from the `voyant-travel/voyant` monorepo. That
  copy is now `private: true` and serves only internal workspace consumers
  inside the framework repo.

See [ROADMAP.md](./ROADMAP.md) for what's next.

## Workspace layout

- `packages/cli` — `@voyant-travel/cli`, the published binary.
- `packages/typescript-config` — internal TS preset.

## Develop

```sh
pnpm install
pnpm check-types
pnpm test
pnpm build
node packages/cli/bin/voyant.mjs --help
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
