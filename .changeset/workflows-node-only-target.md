---
"@voyant-travel/cli": minor
---

Workflows are Node-only now (the Cloudflare Worker/Durable Object workflow adapter has been removed from the workspace), so `voyant workflows deploy` and `voyant workflows doctor` drop the dead `--target cloudflare` lane — `docker` (the Node self-host server) is the only deploy target.

`voyant workflows doctor` also gains `--target entry --file <path>`, which inspects a workflow entry file before it is built. It flags two host-wiring mistakes that previously slipped past `tsc`: local workflows declared in source but never imported from the entry (so never registered with the app composition), and workflow ids that collide with an already-registered — usually upstream-owned — workflow.
