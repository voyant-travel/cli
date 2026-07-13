---
"@voyant-travel/cli": patch
---

Reject runtime-only project modules that return `webhookRoutes` without a graph-owned inbound webhook declaration, and report the supported project-owned package manifest syntax during build.
