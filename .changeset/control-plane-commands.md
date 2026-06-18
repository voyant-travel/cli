---
"@voyant-travel/cli": minor
---

Turn the CLI into a complete, agent-ready cloud control plane. New command groups drive the full platform: `voyant apps` (CRUD), `voyant env` (per-environment variables), `voyant deploy` (trigger + list/get/logs/cancel/rollback), `voyant databases` (Neon/D1 + branches, roles, connection strings), and `voyant storage buckets`. All cloud commands accept `--json` for machine output, emit a stable `{ "error": { code, message } }` envelope on failure, and never block on prompts in non-interactive contexts (destructive actions require `--yes`).

Multi-org support: credentials are now stored per organization (with a transparent migration from the old single-token file). Pick the active org with `voyant org list|use|current`, or target one per command with `--org <slug|id>` / `VOYANT_CLOUD_ORG`. `whoami` now resolves the organization from the server. `login`/`logout` are org-aware.

Vaults can no longer decrypt: `voyant secrets get` is removed, and `voyant login` mints tokens without the `vault:read` scope, so secret values are unreachable from the CLI. `secrets list/set/rm` and `vaults list` (metadata only) remain. Requires `@voyant-travel/cloud-sdk@^0.10.0`.
