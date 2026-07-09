---
"@voyant-travel/cli": minor
---

`voyant db doctor` now supports source-free managed profiles.

When a `managed-profile.json` snapshot is present at the cwd (or `--snapshot <path>`
is passed), `voyant db doctor` runs managed-profile checks instead of requiring a
`drizzle.config`/`voyant.config` template. It loads the deployment's own
`@voyant-travel/framework` (not a bundled copy) and verifies, statically and
DB-free, that the managed migration path will apply:

- the snapshot is a valid Voyant project (the deployment framework's validator)
- the installed `@voyant-travel/framework` version matches the snapshot's pinned
  `frameworkVersion`
- every declared custom-source module resolves to an installed package and, if
  schema-owning, ships a committed `migrations/` folder

Report-by-default (exit 0); pass `--fail-on-drift` to gate CI. The source-backed
mode is unchanged and used when no snapshot is present.
