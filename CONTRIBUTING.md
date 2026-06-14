# Contributing

This repo publishes the unified `@voyant-travel/cli` binary.

## Scope

- OSS commands that scaffold and run Voyant projects without authentication
- Cloud commands that talk to Voyant Cloud over HTTP via `@voyant-travel/cloud-sdk`
- Shared CLI infrastructure (arg parsing, credentials, config loading,
  template fetching)

Out of scope: server-side code (lives in `voyant-cloud`), framework runtime
(lives in `voyant-travel/voyant`).

## Working rules

- Keep commands thin — push reusable logic into `lib/` so the same code is
  callable both from the CLI and programmatically
- Cloud commands must work without the `voyant` framework being installed
- OSS commands must work without a Voyant Cloud login
- Credentials never get logged

## Before opening a PR

```sh
pnpm check-types
pnpm test
pnpm build
```

## Releases

Add a changeset (`pnpm changeset`) for any user-visible change. CI opens a
release PR; merging it publishes to npm.
