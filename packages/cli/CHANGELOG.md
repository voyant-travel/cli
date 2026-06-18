# @voyant-travel/cli

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
