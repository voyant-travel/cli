---
"@voyant-travel/cli": minor
---

Add `voyant logs <app>` to read and follow a deployed app's runtime logs. `--follow` polls and streams new lines like `tail -f` (clean Ctrl-C exit); filter with `--level`, `-q/--search`, `--env`, and a time window via `--since 1h` / `--from` / `--to`. `--json` emits an array, or NDJSON when following, so humans and agents can both inspect and watch logs. Reads from the token-authed `GET /cloud/v1/apps/:app/runtime-logs` endpoint via the cloud-sdk transport.
