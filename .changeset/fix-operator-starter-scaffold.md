---
"@voyant-travel/cli": patch
---

Fix `voyant new` scaffolding so local CLI development resolves the current operator starter, rejects the old `--template` flag, and converts starter workspace dependencies to package-specific `@voyant-travel/*` release ranges instead of falling back to stale `@voyantjs/*` starter output.
