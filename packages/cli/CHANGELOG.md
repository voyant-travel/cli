# @voyant-travel/cli

## 1.0.1

### Patch Changes

- e54a4af: Use a pnpm release that supports catalog dependency specifiers in the workspace and generated projects.

## 1.0.0

### Major Changes

- bef4286: Remove the Voyant Workflows CLI product, including `voyant workflows`, the workflow-only `voyant dev` command, and their public command exports. Use `voyant develop` for full-application development.

## 0.42.2

### Patch Changes

- 1005d86: Restore compatibility with the framework 0.48 / core 0.125 package set.

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

## 0.42.1

### Patch Changes

- cdc8288: Raise the cloud-sdk floor to 0.12.0 — the release that actually carries the
  `extensions` namespace (0.11.0 predates it), fixing `voyant publish` and
  `voyant extensions` crashing on an undefined client namespace.

## 0.42.0

### Minor Changes

- 453d6f8: Add admin extension publishing, extension read commands, private connector manifest registration and validation, and deploy awareness for extension projects.

## 0.41.0

### Minor Changes

- 13011dc: Generate deterministic self-hosted Node projects from validated Voyant Cloud
  export bundles, preserving exact graph selections and package coordinates while
  emitting targeted diagnostics and a secret-free provisioning checklist with
  migration-journal restore guidance. Forced replacement now preserves and reports
  the original project backup when rollback fails. The CLI loads the published
  framework self-host contract through a regular runtime dependency.

## 0.40.5

### Patch Changes

- 2968a88: Use framework project selections when scanning admin module entries so `voyant doctor` supports current `defineConfig` operator projects.

## 0.40.4

### Patch Changes

- 6418a98: Discover generated project link artifacts when running `voyant db sync-links`, including `--emit-drizzle` from an operator project.

## 0.40.3

### Patch Changes

- c2313dd: Report malformed module entries in `voyant admin doctor` instead of crashing, and exit with a failure status.

## 0.40.2

### Patch Changes

- a49ce6c: Materialize graph-discovered writable link pivots automatically after successful schema migrations in `voyant migrate`.
- 7c09edd: Reject runtime-only project modules that return `webhookRoutes` without a graph-owned inbound webhook declaration, and report the supported project-owned package manifest syntax during build.

## 0.40.1

### Patch Changes

- fbd2f90: Show `voyant workflows serve --help` without starting the local server.

## 0.40.0

### Minor Changes

- b7f76af: Add full-application `voyant develop` and `voyant build` commands backed by project-installed runtime tooling, keep development artifacts refreshed as project inputs change, retain artifact-only builds through `--artifacts-only`, refresh artifacts before implicit migrations, load project `.env` files across lifecycle commands, and update generated project scripts.

## 0.39.0

### Minor Changes

- 3e8a4ee: Add `voyant start`, which loads the current project's installed Voyant runtime and starts its generated application.

## 0.38.2

### Patch Changes

- b93fda8: Teach `voyant db doctor` to validate graph-native project and migration artifacts without requiring a template-local `drizzle.config`, while preserving legacy template and managed-profile checks.

## 0.38.1

### Patch Changes

- 6f205dd: Support deployment-local migrations, derive database schema and link checks from current project graph artifacts, and load workspace TypeScript framework exports in project lifecycle commands.

## 0.38.0

### Minor Changes

- f5f3d28: Scaffold clean convention-based projects and single-entry local modules, and remove the unsupported local extension generator.
- 3e06b43: Execute hash-bound Node schema and setup migration runners by default, with plan-only, dry-run, structured status reporting, stale-artifact rejection, and explicit source-free artifact support.
- 3e06b43: Add deterministic package lifecycle plans, graph-aware upgrades, and idempotent remove/uninstall commands for CLI-managed project graphs.
- 3e06b43: Deploy one validated Node application graph through Voyant Cloud, Docker, or custom targets with shared content-hash plans. Docker now executes deterministic build, migration, application start, and HTTP smoke-test phases, while `custom --emit-manifest` emits a portable Node deployment manifest without requiring adapter code. Project-specified custom adapters remain supported. Source projects re-resolve their current config before deployment and reject stale persisted artifacts, while explicitly supplied artifacts remain source-free deploy inputs.
- 3e06b43: Resolve graph-native projects through their installed framework package and use one deterministic `.voyant` graph hash for dev preparation, doctor validation, build artifacts, and migration planning.

  Generate package-owned admin routes, navigation, copy, slots, and contributions directly from target-neutral resolved graph facets. Old graphs with no admin facets retain an explicit legacy package-scanning fallback.

## 0.37.0

### Minor Changes

- 0674cb5: Add graph-native project authoring: expand the `operator-standard` preset into a clean explicit project, scaffold selectable local modules with optional facets, and install/select package or path dependencies with idempotent `add` and `install` commands.

## 0.36.1

### Patch Changes

- 62942d5: Load compiled framework profile entries when a workspace deployment exports TypeScript source, so `voyant db doctor --fail-on-drift` works on Node 20.

## 0.36.0

### Minor Changes

- 2adf822: Add `voyant admin generate --graph <artifact>` to derive packaged admin entries from the selected module and plugin packages in a resolved deployment graph.

## 0.35.2

### Patch Changes

- b7cd8c1: Extract deployment graph doctor report parsing into a shared CLI helper and keep
  explicit graph doctor reports ahead of legacy artifact validation.

## 0.35.1

### Patch Changes

- 758de8f: Allow `voyant dev` to use the managed Node runtime entry from
  `deployment-artifacts.generated.json` when `--file` is omitted.

## 0.35.0

### Minor Changes

- b1a8312: Wire `voyant doctor` to consume deployment graph doctor reports and include graph diagnostics in JSON output.

## 0.34.2

### Patch Changes

- fe5f8c3: Validate deployment graph resource environment requirements in `voyant doctor`.

## 0.34.1

### Patch Changes

- 8f10a4d: Add `voyant doctor --json` to emit a machine-readable `voyant.doctor.v1` report while preserving the existing human-readable doctor output. The top-level doctor now also validates generated deployment graph artifacts when present.

## 0.34.0

### Minor Changes

- 1a71e19: Teach managed-profile `voyant db doctor` to consume the installed framework deployment graph, report graph diagnostics, and distinguish absent graph support from broken graph exports.

## 0.33.0

### Minor Changes

- 8d7798a: `voyant db doctor` now supports source-free managed profiles.

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

## 0.32.2

### Patch Changes

- f426b85: Keep local workflow servers alive until shutdown and show `voyant dev --help` without requiring `--file`.

## 0.32.1

### Patch Changes

- 474e29f: Fix `voyant new` scaffolding so local CLI development resolves the current operator starter, rejects the old `--template` flag, and converts starter workspace dependencies to package-specific `@voyant-travel/*` release ranges instead of falling back to stale `@voyantjs/*` starter output.

## 0.32.0

### Minor Changes

- 5be50cd: Add `voyant generate extension <name> --module <target>`. It scaffolds a deployment-local `HonoExtension` under `src/extensions/<name>/` that attaches to an existing module's surface — the counterpart to `voyant generate module`, for adding routes (and optionally a detail table) to a module like `bookings` without forking it.

  Flags: `--module <target>` (required — the module the extension attaches to), `--public` (mount on `/v1/public` instead of `/v1/admin`), `--with-schema` (also emit a 1:1 extension table with a plain-text FK), plus `--dir` and `--force`. Generates `index.ts` (via `defineDeploymentExtension`), `routes.ts`, `validation.ts`, and an optional `schema.ts` — no `package.json`/`tsconfig.json`, since an extension is not an npm package. Names that would produce an invalid TypeScript identifier are rejected before any files are written.

- 5be50cd: `voyant new <name>` now scaffolds from the `operator` starter by default — no flag required. Reframe the "template" concept as a "starter" throughout the command: the flag is now `--starter <name|path>` (`--template` is still accepted as a deprecated alias), repo-local checkouts are resolved from `starters/<name>` (with `templates/<name>` honored as a legacy fallback), and all user-facing messages refer to starters. Resolution order is unchanged: explicit path → repo-local starter → built-in starter tarball from GitHub Releases, defaulting to `operator`.

## 0.31.0

### Minor Changes

- d94dfb5: Add `voyant generate extension <name> --module <target>`. It scaffolds a deployment-local `HonoExtension` under `src/extensions/<name>/` that attaches to an existing module's surface — the counterpart to `voyant generate module`, for adding routes (and optionally a detail table) to a module like `bookings` without forking it.

  Flags: `--module <target>` (required — the module the extension attaches to), `--public` (mount on `/v1/public` instead of `/v1/admin`), `--with-schema` (also emit a 1:1 extension table with a plain-text FK), plus `--dir` and `--force`. Generates `index.ts` (via `defineDeploymentExtension`), `routes.ts`, `validation.ts`, and an optional `schema.ts` — no `package.json`/`tsconfig.json`, since an extension is not an npm package. Names that would produce an invalid TypeScript identifier are rejected before any files are written.

## 0.30.0

### Minor Changes

- 248d6be: Workflows are Node-only now (the Cloudflare Worker/Durable Object workflow adapter has been removed from the workspace), so `voyant workflows deploy` and `voyant workflows doctor` drop the dead `--target cloudflare` lane — `docker` (the Node self-host server) is the only deploy target.

  `voyant workflows doctor` also gains `--target entry --file <path>`, which inspects a workflow entry file before it is built. It flags two host-wiring mistakes that previously slipped past `tsc`: local workflows declared in source but never imported from the entry (so never registered with the app composition), and workflow ids that collide with an already-registered — usually upstream-owned — workflow.

## 0.29.0

### Minor Changes

- 3606f8c: Turn the CLI into a complete, agent-ready cloud control plane. New command groups drive the full platform: `voyant apps` (CRUD), `voyant env` (per-environment variables), `voyant deploy` (trigger + list/get/logs/cancel/rollback), `voyant databases` (Neon/D1 + branches, roles, connection strings), and `voyant storage buckets`. All cloud commands accept `--json` for machine output, emit a stable `{ "error": { code, message } }` envelope on failure, and never block on prompts in non-interactive contexts (destructive actions require `--yes`).

  Multi-org support: credentials are now stored per organization (with a transparent migration from the old single-token file). Pick the active org with `voyant org list|use|current`, or target one per command with `--org <slug|id>` / `VOYANT_CLOUD_ORG`. `whoami` now resolves the organization from the server. `login`/`logout` are org-aware.

  Vaults can no longer decrypt: `voyant secrets get` is removed, and `voyant login` mints tokens without the `vault:read` scope, so secret values are unreachable from the CLI. `secrets list/set/rm` and `vaults list` (metadata only) remain. Requires `@voyant-travel/cloud-sdk@^0.10.0`.

## 0.28.0

### Minor Changes

- 7eb9baa: Add `voyant logs <app>` to read and follow a deployed app's runtime logs. `--follow` polls and streams new lines like `tail -f` (clean Ctrl-C exit); filter with `--level`, `-q/--search`, `--env`, and a time window via `--since 1h` / `--from` / `--to`. `--json` emits an array, or NDJSON when following, so humans and agents can both inspect and watch logs. Reads from the token-authed `GET /cloud/v1/apps/:app/runtime-logs` endpoint via the cloud-sdk transport.

## 0.27.0

### Minor Changes

- 3e22fc7: Add `voyant upgrade [--to <version>] [--dry-run] [--package <name>]` — bumps the deployment's `@voyant-travel/framework` BOM to one version (the latest published, or an explicit `--to`) and runs the detected package manager's install. The BOM's pinned `dependencies` transitively resolve the whole tested runtime set, so a deployment tracks a single version instead of a per-package matrix.

  This completes the upgrade path the consolidated-deployments RFC defines: `voyant upgrade && voyant db migrate && voyant doctor`. `--dry-run` reports the change without writing; a `workspace:` range (monorepo) is skipped; the version resolver + installer are injectable for testing.

## 0.26.0

### Minor Changes

- 7ac9392: `admin generate --routes` + `admin doctor`: core extension, nested children, and redirect contributions (packaged-admin RFC voyant-travel/voyant#1643 final sweep)

  - Scanner: extracts `redirectTo` (template-literal-resolved like `path`); redirect-only contributions count as implemented. Descends into `children: [...]` arrays (parent-relative paths, `"/"` = index) producing parent/child structures; spread elements (runtime-known children) stay invisible by design.
  - `admin generate --routes` includes the BUILT-IN core entry `@voyant-travel/admin-app/core-extension` (extension id `core`, factory `createAdminCoreExtension`) independently of the manifest module list — conditional on the package resolving from the host with a `"./core-extension"` export, so pre-core hosts are unaffected. The core factory builds its routes imperatively (unscannable), so the CLI carries its static contribution table (dashboard `/`, account, settings layout + index redirect + 9 built-in pages).
  - Nested emission: layout parents emit an accessor thunk (`const coreSettings = () => CoreSettingsRoute`), children with `getParentRoute`, and a `<Parent>RouteWithChildren = parent.addChildren([...static, ...adminExtensionChildRoutes(ext, id, accessor, runtime, { exclude: [...] })])` subtree; the tree array references the `WithChildren` const.
  - Typed-link maps handle nested/index/redirect shapes: parent → `typeof <Parent>RouteWithChildren` (ByFullPath/ById), index child claims `"<parent>/"` (ByFullPath), `"<parent>"` (ByTo), and `"/_workspace<parent>/"` (ById); redirect leaves keep plain keys.
  - Doctor Finding C: redirect contributions bound in the generated module satisfy their path with no file and no page; children are traversed with absolute paths reconstructed on both sides (contributions AND the generated module's nested `createRoute` trees); runtime-bound extraPages children never report; the core entry participates when resolvable.
  - `--routes --files` (legacy thin files) skips redirect/children contributions — they are module-only concepts — and never emits the core entry.
  - The workspace layout's own `route.tsx` no longer ejects the root path `/` (it is the layout, not the index binding).

### Patch Changes

- 81e54bd: Update workflow runtime dependencies to the current package line.

## 0.25.0

### Minor Changes

- 30246ee: `voyant admin generate --destinations` + doctor Finding D gate (packaged-admin RFC §4.7 endgame).

  - `voyant admin generate --destinations [--out <file>] [--check]` emits the
    generated destination resolver map (`src/admin.destinations.generated.ts`):
    one pure path-interpolation resolver (`encodeURIComponent`,
    `destinationParams` name mapping) per route contribution annotated with
    `destination:`, `satisfies Partial<AdminDestinationResolvers>`. Generated
    header + ejection contract (a file without the header is never touched; a
    stale generated file converges to deletion when no annotations remain) and
    a `--check` drift gate, same as `--routes`.
  - `voyant admin doctor` Finding D is now two-tier: the GENERATED portion
    gates (exit 1) — an annotated destination missing from the generated
    module, a generated resolver whose annotation vanished, or any content
    drift; an ejected module skips the gate but keeps its keys for parity.
    Custom-resolver parity against declared `AdminDestinations` keys stays
    report-only (exit 0). New `--destinations-out <file>` flag for
    non-default generated-module paths.
  - Contribution scanning learns the `destination:` string literal and the
    `destinationParams: { route: "destination" }` object literal.

## 0.24.0

### Minor Changes

- 3025fec: `voyant admin generate --routes` now emits the CODE-ASSEMBLED admin route module (packaged-admin RFC §4.8 — voyant-travel/voyant#1643): one committed `src/admin.routes.generated.tsx` holding a code-based `createRoute` per implemented extension route contribution (`page` or `component` — `$param` routes included), options resolved from the host-registered extension instances via `adminExtensionRouteOptions`, literal paths + typed search contracts (search schemas resolved statically and imported from the admin entry), and the three `AdminExtensionRoutesBy*` typed-link map interfaces the host's `router.tsx` merges. NO per-route files exist for package-delivered pages.

  - The ejection-header contract carries over: a target module without the generated header is never overwritten; a hand-written route file binding a contribution's path ejects that single route from the module; leftover generated thin route files (increment 1) are deleted on write and flagged as drift with `--check`.
  - The static scanner now recognizes lazy `page:` loaders (in addition to `component:`) when deciding a contribution is implemented, and key-matches properties preceded by doc comments.
  - The legacy per-route thin-file emission remains available behind `voyant admin generate --routes --files` for hosts not yet migrated (the voyant monorepo no longer uses it).
  - `admin doctor` Finding C (route parity) accepts EITHER a route file under the routes dir OR an entry in the code-assembled module (default `src/admin.routes.generated.tsx`; `--routes-dir`/`--routes-out` flags and `admin.routes.dir`/`admin.routes.out` manifest keys are honored) — this removes the false positive on package-delivered fileless routes like `/promotions`. Declared paths now come from resolved route contributions instead of a raw `path:`-literal regex. Still report-only.
  - Manifest `admin.routes` gains `out`, `registryModule`, `registryExport`, and `workspaceRouteModule` knobs; defaults follow the operator conventions (`@/lib/admin-extensions`, `@/routes/_workspace/route`).
  - Includes the `<module>-react/admin` entry convention fix (the `*-ui` packages merged into `*-react`, voyant-travel/voyant#1652/#1670).

  Emission fidelity is validated against the real operator template: `voyant admin generate --routes --check` reports its checked-in `admin.routes.generated.tsx` (49 routes across 10 extensions) byte-for-byte up to date, and `voyant admin doctor` reports 0 findings.

## 0.23.0

### Minor Changes

- 3611b2d: First increment of the packaged-admin RFC's §4.2 code-based route assembly:

  - `voyant admin generate --routes [--routes-dir <dir>] [--check]` — statically
    scans each resolved admin entry's route contributions (no code execution)
    and emits generated thin route files into the host's file-based route tree,
    one per ZERO-PROP route (component present, no `$param` segments). Generated
    hosts resolve the contribution via `requireAdminRoute` from
    `@voyant-travel/admin` and bind the app runtime
    (`{ baseUrl: getApiUrl(), fetcher: operatorFetcher }` by default; module and
    export names configurable via the manifest's `admin.routes` block).
    Param-taking detail hosts stay hand-written. Files without the
    `// GENERATED by voyant admin generate --routes` header are never
    overwritten — deleting the header is the explicit ejection story. `--check`
    exits 1 on missing/stale generated files for CI.
  - `voyant admin doctor` gains Finding D (destination parity, RFC §4.7):
    `AdminDestinations` keys declared by mounted admin entries via
    `declare module "@voyant-travel/admin"` are compared against the host's resolver
    map (the object marked `satisfies AdminDestinationResolvers`, default
    `src/lib/admin-destinations.ts`, override with `--destinations <file>`).
    Reports both declared-but-unresolved keys and resolvers matching no declared
    destination. Report-only, like Findings A–C.

## 0.22.0

### Minor Changes

- 9e6e98c: New `voyant admin` commands — manifest-driven admin composition for the
  packaged-admin RFC (voyant#1643 Phase 2):

  - `voyant admin generate [--config <path>] [--out <file>] [--check]` — scans
    the manifest's modules, resolves each module's admin entry via the
    `<module>-ui/admin` convention (or an explicit `package.json#voyant.adminEntry`
    override) by pure package.json `exports` inspection, and emits a committed
    `src/admin.extensions.generated.ts` with static factory imports. `--check`
    exits 1 on drift for CI.
  - `voyant admin doctor [--config <path>] [--out <file>]` — report-only parity
    check: admin entries not imported in the generated file, generated imports
    whose module left the manifest, and extension route paths with no matching
    host route file.

### Patch Changes

- 05982d7: Drop the retired `dmc` starter: `voyant new` now defaults to the `operator` template (the only starter shipped by the voyant monorepo since voyant-travel/voyant#1643 Phase 3). Unknown template names, including `dmc`, still fail with an explicit "Could not find a template" error.

## 0.21.0

### Minor Changes

- 9939e73: Add migration-resilience `voyant db` tooling:

  - `voyant db doctor` — report-first migration drift check (manifest resolvability, schema parity, generated-manifest freshness, duplicate-prefix baseline, link-tables-in-snapshot) with `--fail-on-drift` to gate CI.
  - Manifest-driven schema resolution: `resolveSchemas` seeds from `modules` + `extensions` + `additionalSchemas`; `db schemas --emit` and `db generate` write a committed `drizzle.schemas.generated.ts`.
  - `db sync-links --emit-drizzle` generates Drizzle table definitions for cross-module link tables so they fold into the migration snapshot.
  - `db generate` forwards flags to drizzle-kit and defaults to `--prefix timestamp` for collision-free migration ordering.

## 0.20.1

### Patch Changes

- f47c30c: Fix node workflow builds that load bundled CommonJS dependencies with dynamic requires of Node built-ins.

## 0.20.0

### Minor Changes

- 07085fb: First release of `@voyant-travel/cli` from the dedicated `voyant-travel/cli` repo —
  published as `0.20.0` (the `0.19.0` version was already shipped from
  `voyant-travel/voyant` before that repo's `packages/cli` was privatized; from
  this point on, all `@voyant-travel/cli` releases come from `voyant-travel/cli`).

  This is the unified CLI for the Voyant open-source framework AND the Voyant
  Cloud platform — replacing the in-monorepo `@voyant-travel/cli@0.18.x`/`0.19.0`
  that previously shipped from `voyant-travel/voyant`.

  **Open source (no login required):**

  Ports every command from the previous in-monorepo CLI 1:1 — `new`,
  `generate {module,link}`, `config`, `db {generate,migrate,studio,push,check,sync-links,schemas}`,
  `exec`, `dev`, `workflows`. Same commands, same flags, same tests.

  Two monorepo-coupling issues from the previous version are fixed:

  - `voyant new` no longer assumes a sibling `templates/` directory in a
    Voyant checkout. Built-in starters now resolve from the
    `github.com/voyant-travel/voyant` releases tarballs.
  - `voyant db` no longer hardcodes `templates/dmc` — it resolves the
    drizzle config from `cwd` (or `--template <path>`).

  **Cloud (Voyant Cloud login):**

  - `voyant login` — browser device-code flow (RFC 8628), or
    `--token <value>` for CI/headless. Tokens stored in
    `~/.voyant/credentials.json` keyed by API URL.
  - `voyant logout`, `voyant whoami`.
  - `voyant vaults list`.
  - `voyant secrets list/get/set/rm`.

  **Decoupled framework version.** The CLI's own version is now independent
  of the framework version it scaffolds projects against — bumping the CLI
  no longer drags `@voyant-travel/core` deps in `voyant new` / `voyant generate
module` output.
