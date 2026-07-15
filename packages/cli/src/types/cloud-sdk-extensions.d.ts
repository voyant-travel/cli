import "@voyant-travel/cloud-sdk"

declare module "@voyant-travel/cloud-sdk" {
  interface VoyantCloudClient {
    readonly extensions: {
      create(input: { key: string; displayName: string; description?: string }): Promise<unknown>
      publishVersion(
        key: string,
        input: {
          manifest: {
            schemaVersion: "voyant.extension-manifest.v1"
            key: string
            displayName: string
            description?: string
            version: string
            extensionApi: string
            entry: string
            targets: Array<{ slot: string }>
            configSchema?: unknown
          }
          bundle: Uint8Array | Blob
        },
      ): Promise<unknown>
      list(filter?: "listed" | "installed" | "mine"): Promise<
        Array<{
          key: string
          displayName: string
          description: string | null
          visibility: "private" | "unlisted" | "listed"
          installed: boolean
        }>
      >
      get(key: string): Promise<unknown>
      update(
        key: string,
        input: {
          displayName?: string
          description?: string | null
          visibility?: "private" | "unlisted"
        },
      ): Promise<unknown>
      install(key: string, input?: { version?: string; config?: unknown }): Promise<unknown>
      updateInstall(
        key: string,
        input: { enabled?: boolean; config?: unknown; version?: string },
      ): Promise<unknown>
      uninstall(key: string): Promise<null>
      listInstalls(): Promise<
        Array<{
          key: string
          version: string
          displayName: string
          extensionApi: string
          entryUrl: string
          slots: string[]
          config?: Record<string, unknown>
        }>
      >
    }
  }
}
