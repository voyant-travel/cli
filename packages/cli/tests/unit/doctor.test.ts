import { describe, expect, it } from "vitest"

import {
  collectWranglerInfo,
  parseRequiredBindings,
  runEnvPreflight,
} from "../../src/commands/doctor.js"

describe("parseRequiredBindings", () => {
  const source = `
    interface CloudflareBindings {
      /** Optional metrics. */
      METRICS?: AnalyticsEngineDataset
      // KV namespaces
      RATE_LIMIT: KVNamespace
      CACHE: KVNamespace
      MEDIA_BUCKET: R2Bucket
      DOCUMENTS_BUCKET: R2Bucket
      INTERNAL_API_KEY: string
      BETTER_AUTH_SECRET: string
      DATABASE_URL: string
      DATABASE_URL_REPLICAS?: string
    }
  `

  it("extracts required bindings classified by category, skipping optionals", () => {
    const got = parseRequiredBindings(source)
    expect(got).toEqual([
      { name: "RATE_LIMIT", category: "kv" },
      { name: "CACHE", category: "kv" },
      { name: "MEDIA_BUCKET", category: "r2" },
      { name: "DOCUMENTS_BUCKET", category: "r2" },
      { name: "INTERNAL_API_KEY", category: "secret" },
      { name: "BETTER_AUTH_SECRET", category: "secret" },
      { name: "DATABASE_URL", category: "secret" },
    ])
    // optional members are excluded
    expect(got.find((b) => b.name === "METRICS")).toBeUndefined()
    expect(got.find((b) => b.name === "DATABASE_URL_REPLICAS")).toBeUndefined()
  })

  it("returns [] when the interface is absent", () => {
    expect(parseRequiredBindings("export const x = 1")).toEqual([])
  })
})

describe("collectWranglerInfo", () => {
  it("collects KV/R2 binding names + vars and flags placeholders (JSONC with comments)", () => {
    const src = `{
      // bindings
      "kv_namespaces": [
        { "binding": "CACHE", "id": "replace-with-cache-kv-namespace-id" },
        { "binding": "RATE_LIMIT", "id": "abc123" }
      ],
      "r2_buckets": [{ "binding": "MEDIA_BUCKET", "bucket_name": "media" }],
      "vars": { "PUBLIC_FLAG": "true" }
    }`
    const info = collectWranglerInfo(src)
    expect(info.kvBindings.sort()).toEqual(["CACHE", "RATE_LIMIT"])
    expect(info.r2Bindings).toEqual(["MEDIA_BUCKET"])
    expect(info.vars).toEqual(["PUBLIC_FLAG"])
    expect(info.placeholders).toEqual(["replace-with-cache-kv-namespace-id"])
  })

  it("returns empty info on unparseable input", () => {
    expect(collectWranglerInfo("{ not json")).toEqual({
      kvBindings: [],
      r2Bindings: [],
      vars: [],
      placeholders: [],
    })
  })
})

describe("runEnvPreflight", () => {
  function ctx(cwd: string) {
    const out: string[] = []
    const err: string[] = []
    return {
      ctx: {
        argv: [],
        cwd,
        stdout: (c: string) => out.push(c),
        stderr: (c: string) => err.push(c),
      },
      out,
      err,
    }
  }

  it("skips cleanly when no env.d.ts / wrangler.jsonc exist", () => {
    const { ctx: c, out } = ctx("/tmp/nonexistent-voyant-doctor-dir")
    const code = runEnvPreflight(c, { strict: false })
    expect(code).toBe(0)
    expect(out.join("")).toContain("skipped")
  })
})
