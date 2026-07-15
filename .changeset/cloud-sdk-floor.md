---
"@voyant-travel/cli": patch
---

Raise the cloud-sdk floor to 0.12.0 — the release that actually carries the
`extensions` namespace (0.11.0 predates it), fixing `voyant publish` and
`voyant extensions` crashing on an undefined client namespace.
