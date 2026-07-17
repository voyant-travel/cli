---
"@voyant-travel/cli": patch
---

Restore compatibility with the framework 0.48 / core 0.125 package set.

`@voyant-travel/core@0.125` removed the `@voyant-travel/core/config` export
subpath (the "unify application config ownership" deployment-graph rewrite), so
the CLI crashed with `ERR_PACKAGE_PATH_NOT_EXPORTED: ./config` on **every**
invocation against a 0.48-pinned workspace — `db doctor`, `admin generate`, and
`workflows build` all died at import time.

The legacy `voyant.config.*` manifest authoring contracts (`VoyantConfig`,
`ModuleEntry`, `PluginEntry`, `resolveEntry`, `validateVoyantConfig`, and the
validation result types) — which the CLI's `config`, `admin generate`, and
`admin doctor` commands read and which customers still ship — now live in the
CLI itself (`lib/config-manifest.ts`) instead of being imported from core.
Also drops the caller-supplied `nodeStepRunner` from the `workflows serve`
handler wiring: `@voyant-travel/workflows@0.122` runs `runtime: "node"` step
bodies in-process by default, so the override is redundant and no longer typed
into `StepHandlerDeps`.

Bumps the framework/core/workflows floors to the matched 0.48 line
(core `^0.125.0`, framework `^0.48.2`, workflows/orchestrator `^0.122.2`,
orchestrator-node `^0.108.0`).
