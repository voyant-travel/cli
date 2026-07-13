/**
 * The version of the `@voyant-travel/*` framework packages that scaffolded code
 * — projects from `voyant new`, modules from `voyant generate module` —
 * should depend on by default.
 *
 * Deliberately decoupled from this CLI's own `version` field so the CLI
 * can iterate (release fixes, add commands) without forcing a framework
 * version bump. Bump this constant when a new framework release lands
 * and we want fresh scaffolds to track it.
 *
 * It also drives the URL for `voyant new --starter <built-in>`, which
 * resolves to `https://github.com/voyant-travel/voyant/releases/download/v<X>/voyant-starter-<name>-<X>.tar.gz`.
 * That release tag must exist with the matching starter assets attached.
 */
export const VOYANT_FRAMEWORK_VERSION = "0.36.2"

/** Version of the independently-versioned generic Node runtime used by clean scaffolds. */
export const VOYANT_RUNTIME_VERSION = "0.7.0"
