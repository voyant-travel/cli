# Roadmap

## Shipped

### Phase 0 — scaffold ✓

Stripped the duplicated `data-sdk` bones, stood up `packages/cli` with a
working `voyant --help`, smoke tests, build, and CI.

### Phase 1 — port OSS commands ✓

Ported every command from `voyant-travel/voyant`'s `packages/cli`: `new`,
`generate {module,link}`, `config`, `db {generate,migrate,studio,push,check,sync-links,schemas}`,
`exec`, `dev`, `workflows`. Swapped `workspace:*` deps for published
versions of `@voyant-travel/core` and `@voyant-travel/workflows*`. Made `new` and
`db` resolve templates from `cwd` rather than a hardcoded monorepo path.

### Phase 2 — credentials + cloud client factory ✓

Added `lib/credentials` (`~/.voyant/credentials.json`, mode 0600, keyed by
`apiUrl`) and `lib/cloud-client` resolving tokens via `--token` →
`VOYANT_CLOUD_API_KEY` → credentials file.

### Phase 3 — device-code flow on `voyant-cloud` ✓

Lives in the `voyant-cloud` repo. `POST /cli/v1/device/{authorize,token,approve}`
plus `GET /cli/v1/device/authorization` and a dash route at `/cli` that
handles the browser side. RFC 8628 shape. Tokens minted into the existing
`apiTokens` table.

### Phase 4 — first cloud commands ✓

`voyant login` (paste-token mode), `logout`, `whoami`, `vaults list`,
`secrets list`, `secrets get`.

### Phase 4.6 — device-code login ✓

Wired the RFC 8628 client into `voyant login` (no flag → browser flow);
`--no-browser` for ssh sessions and CI.

### Phase 4.7 — vault writes ✓

`voyant secrets set` and `voyant secrets rm`. Server-side `POST/DELETE
/vault/v1/:vault/secrets/:key` (in `voyant-cloud`); typed
`vault.setSecret` / `vault.deleteSecret` in `cloud-sdk@0.7.0`.

### Phase 5 — retire the in-monorepo CLI ✓

`voyant-travel/voyant/packages/cli` set `private: true`; this repo bumped to
`@voyant-travel/cli@0.19.0` and is the source of truth for npm publishes going
forward. CLI version decoupled from framework version (scaffolds still
track `@voyant-travel/core@^0.18.0` regardless of how often we ship CLI
patches).

## Upcoming

- **Refactor `secrets set/rm` to `client.vault.setSecret/deleteSecret`** once
  cloud-sdk@0.7.0 publishes — currently uses `client.transport.request`
  directly because typed methods only land in 0.7.0.
- **`voyant runs list` + `voyant runs logs <id>`** — needs cloud-sdk to add a
  `developer` namespace exposing the existing
  `/dashboard/v1/organizations/:id/developers/runs(*)` routes (or new
  `/cli/v1/runs` routes if we want them under API-token auth).
- **Garbage-collect expired `cli_device_codes` rows** — the lazy expiry
  works fine, but a cron sweep keeps the table tidy.
