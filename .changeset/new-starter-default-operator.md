---
"@voyant-travel/cli": minor
---

`voyant new <name>` now scaffolds from the `operator` starter by default — no flag required. Reframe the "template" concept as a "starter" throughout the command: the flag is now `--starter <name|path>` (`--template` is still accepted as a deprecated alias), repo-local checkouts are resolved from `starters/<name>` (with `templates/<name>` honored as a legacy fallback), and all user-facing messages refer to starters. Resolution order is unchanged: explicit path → repo-local starter → built-in starter tarball from GitHub Releases, defaulting to `operator`.
