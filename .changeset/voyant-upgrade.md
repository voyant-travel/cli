---
"@voyant-travel/cli": minor
---

Add `voyant upgrade [--to <version>] [--dry-run] [--package <name>]` — bumps the deployment's `@voyant-travel/framework` BOM to one version (the latest published, or an explicit `--to`) and runs the detected package manager's install. The BOM's pinned `dependencies` transitively resolve the whole tested runtime set, so a deployment tracks a single version instead of a per-package matrix.

This completes the upgrade path the consolidated-deployments RFC defines: `voyant upgrade && voyant db migrate && voyant doctor`. `--dry-run` reports the change without writing; a `workspace:` range (monorepo) is skipped; the version resolver + installer are injectable for testing.
