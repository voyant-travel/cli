---
"@voyant-travel/cli": minor
---

Deploy one validated Node application graph through Voyant Cloud, Docker, or custom targets with shared content-hash plans. Docker now executes deterministic build, migration, application start, and HTTP smoke-test phases, while `custom --emit-manifest` emits a portable Node deployment manifest without requiring adapter code. Project-specified custom adapters remain supported. Source projects re-resolve their current config before deployment and reject stale persisted artifacts, while explicitly supplied artifacts remain source-free deploy inputs.
