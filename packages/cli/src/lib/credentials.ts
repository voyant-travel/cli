import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * One stored credential — a single API token, which is bound to exactly one
 * organization. A user who belongs to several organizations holds one of these
 * per org (each is a distinct token).
 *
 * `organizationId` may be a synthetic key (e.g. `"default"`) for a pasted raw
 * token whose org could not be resolved at login time.
 */
export interface OrgCredential {
  accessToken: string
  organizationId: string
  organizationSlug?: string
  userId?: string
  /** ISO 8601 timestamp of when this credential was stored. */
  createdAt: string
}

/**
 * All credentials for a single API URL: a set of per-organization tokens plus a
 * pointer to the active organization. Commands resolve against `activeOrg`
 * unless overridden by `--org` / `VOYANT_CLOUD_ORG`.
 */
export interface ApiUrlCredentials {
  /** organizationId of the active org. May be undefined when only one org exists. */
  activeOrg?: string
  orgs: Record<string, OrgCredential>
}

/**
 * Map of `apiUrl → ApiUrlCredentials`. Multiple environments (prod / staging /
 * a self-hosted Voyant Cloud) can coexist in one file.
 */
export type CredentialsFile = Record<string, ApiUrlCredentials>

const ENV_OVERRIDE = "VOYANT_CREDENTIALS_FILE"
const SYNTHETIC_ORG_KEY = "default"

/**
 * Default location of the credentials file. Honors `VOYANT_CREDENTIALS_FILE`
 * for tests and for users who keep dotfiles elsewhere.
 */
export function getCredentialsPath(): string {
  const override = process.env[ENV_OVERRIDE]
  if (override && override.length > 0) return override
  return join(homedir(), ".voyant", "credentials.json")
}

/**
 * Read and parse the credentials file. Missing or unparseable files are
 * treated as empty — the CLI never crashes because someone hand-edited it.
 *
 * Older files stored a single `{ accessToken, organizationId? }` per API URL;
 * those are migrated in-memory to the multi-org shape so existing logins keep
 * working without a forced re-login.
 */
export function loadCredentials(path: string = getCredentialsPath()): CredentialsFile {
  if (!existsSync(path)) return {}
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return {}
  }
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

  const out: CredentialsFile = {}
  for (const [apiUrl, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = migrateEntry(value)
    if (entry) out[apiUrl] = entry
  }
  return out
}

/** Coerce a raw parsed entry (old flat shape or new nested shape) into ApiUrlCredentials. */
function migrateEntry(value: unknown): ApiUrlCredentials | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>

  // New shape: { orgs: {...}, activeOrg?: ... }
  if (record.orgs && typeof record.orgs === "object") {
    return record as unknown as ApiUrlCredentials
  }

  // Old flat shape: { accessToken, organizationId?, userId?, createdAt }
  if (typeof record.accessToken === "string") {
    const organizationId =
      typeof record.organizationId === "string" ? record.organizationId : SYNTHETIC_ORG_KEY
    const cred: OrgCredential = {
      accessToken: record.accessToken,
      organizationId,
      organizationSlug:
        typeof record.organizationSlug === "string" ? record.organizationSlug : undefined,
      userId: typeof record.userId === "string" ? record.userId : undefined,
      createdAt:
        typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
    }
    return { activeOrg: organizationId, orgs: { [organizationId]: cred } }
  }

  return null
}

/**
 * Write the credentials file with mode 0600. Creates the parent directory
 * with mode 0700 if it doesn't exist. Mode-setting is a no-op on Windows.
 */
export function saveCredentials(file: CredentialsFile, path: string = getCredentialsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  // writeFileSync only sets mode on file creation, so re-chmod for the
  // overwrite case to make sure we never leak a previously-loose mode.
  if (process.platform !== "win32") chmodSync(path, 0o600)
}

/** All stored credentials for an API URL, or undefined if none. */
export function getApiUrlCredentials(
  apiUrl: string,
  path: string = getCredentialsPath(),
): ApiUrlCredentials | undefined {
  return loadCredentials(path)[normalizeApiUrl(apiUrl)]
}

/** Every org credential stored for an API URL (empty array if none). */
export function listOrgCredentials(
  apiUrl: string,
  path: string = getCredentialsPath(),
): OrgCredential[] {
  const entry = getApiUrlCredentials(apiUrl, path)
  return entry ? Object.values(entry.orgs) : []
}

/**
 * Resolve a single org credential for an API URL.
 *
 * With `orgId` set, returns that org's credential (matched by id or slug).
 * Without it, returns the active org, or — when exactly one org is stored — that
 * sole org. Returns undefined when the choice is ambiguous or nothing matches.
 */
export function resolveOrgCredential(
  apiUrl: string,
  orgId: string | undefined,
  path: string = getCredentialsPath(),
): OrgCredential | undefined {
  const entry = getApiUrlCredentials(apiUrl, path)
  if (!entry) return undefined
  const orgs = Object.values(entry.orgs)

  if (orgId) {
    return orgs.find((o) => o.organizationId === orgId || o.organizationSlug === orgId)
  }
  if (entry.activeOrg && entry.orgs[entry.activeOrg]) return entry.orgs[entry.activeOrg]
  if (orgs.length === 1) return orgs[0]
  return undefined
}

/**
 * Upsert an org credential. By default the stored org also becomes the active
 * one (so a fresh `voyant login` selects what you just authorized).
 */
export function setOrgCredential(
  apiUrl: string,
  cred: OrgCredential,
  opts: { setActive?: boolean } = {},
  path: string = getCredentialsPath(),
): void {
  const file = loadCredentials(path)
  const key = normalizeApiUrl(apiUrl)
  const entry = file[key] ?? { orgs: {} }
  entry.orgs[cred.organizationId] = cred
  if (opts.setActive !== false) entry.activeOrg = cred.organizationId
  file[key] = entry
  saveCredentials(file, path)
}

/**
 * Point the active org at `orgId` (matched by id or slug). Returns the resolved
 * org credential, or undefined when no stored org matches.
 */
export function setActiveOrg(
  apiUrl: string,
  orgId: string,
  path: string = getCredentialsPath(),
): OrgCredential | undefined {
  const file = loadCredentials(path)
  const key = normalizeApiUrl(apiUrl)
  const entry = file[key]
  if (!entry) return undefined
  const match = Object.values(entry.orgs).find(
    (o) => o.organizationId === orgId || o.organizationSlug === orgId,
  )
  if (!match) return undefined
  entry.activeOrg = match.organizationId
  saveCredentials(file, path)
  return match
}

/**
 * Remove credentials for `apiUrl`. With `orgId`, removes just that org (and
 * clears `activeOrg` if it pointed there); otherwise removes the whole API URL.
 * Deletes the file entirely when nothing is left.
 */
export function clearCredential(
  apiUrl: string,
  orgId: string | undefined = undefined,
  path: string = getCredentialsPath(),
): void {
  const file = loadCredentials(path)
  const key = normalizeApiUrl(apiUrl)
  const entry = file[key]

  if (entry && orgId) {
    const match = Object.values(entry.orgs).find(
      (o) => o.organizationId === orgId || o.organizationSlug === orgId,
    )
    if (match) {
      delete entry.orgs[match.organizationId]
      if (entry.activeOrg === match.organizationId) entry.activeOrg = undefined
    }
    if (Object.keys(entry.orgs).length === 0) delete file[key]
  } else {
    delete file[key]
  }

  if (Object.keys(file).length === 0) {
    if (existsSync(path)) unlinkSync(path)
    return
  }
  saveCredentials(file, path)
}

export function normalizeApiUrl(url: string): string {
  return url.replace(/\/+$/, "")
}
