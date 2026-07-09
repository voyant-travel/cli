---
"@voyant-travel/cli": patch
---

Add `voyant doctor --json` to emit a machine-readable `voyant.doctor.v1` report while preserving the existing human-readable doctor output. The top-level doctor now also validates generated deployment graph artifacts when present.
