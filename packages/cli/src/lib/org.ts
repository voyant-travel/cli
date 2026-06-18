import type { VoyantCloudClient } from "@voyant-travel/cloud-sdk"

/**
 * The organization an API token is bound to, as returned by
 * `GET /cloud/v1/organization`. The cloud-sdk does not expose a typed method
 * for this route (its routes live alongside workflow routes the SDK doesn't
 * mirror), so we call the transport directly.
 */
export interface CloudOrganizationInfo {
  id: string
  slug: string
  name?: string
}

/**
 * Best-effort fetch of the token's organization. Returns null on any failure so
 * callers (login, whoami) can degrade gracefully when the control-plane route
 * isn't reachable yet.
 */
export async function fetchOrganization(
  client: VoyantCloudClient,
): Promise<CloudOrganizationInfo | null> {
  try {
    const org = await client.transport.request<CloudOrganizationInfo>("/cloud/v1/organization")
    return org && typeof org.id === "string" ? org : null
  } catch {
    return null
  }
}
