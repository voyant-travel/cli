import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  CORE_ADMIN_ENTRY_IMPORT_SPEC,
  CORE_SETTINGS_SUBTREE_COMMENT,
  coreAdminRouteContributions,
  resolveCoreAdminEntry,
} from "../../src/lib/admin-core-entry.js"
import {
  collectContributionRoutePaths,
  isImplementedContribution,
} from "../../src/lib/admin-routes.js"

describe("coreAdminRouteContributions", () => {
  const contributions = coreAdminRouteContributions()

  it("mirrors createAdminCoreExtension's default static route table", () => {
    expect(contributions.map((contribution) => contribution.id)).toEqual([
      "core-dashboard",
      "core-account",
      "core-settings",
    ])
    expect(contributions.map((contribution) => contribution.path)).toEqual([
      "/",
      "/account",
      "/settings",
    ])
    const settings = contributions[2]
    expect(settings?.children?.map((child) => child.id)).toEqual([
      "core-settings-index",
      "core-settings-team",
      "core-settings-api-tokens",
      "core-settings-channels",
      "core-settings-taxes",
      "core-settings-cost-categories",
      "core-settings-pricing-categories",
      "core-settings-price-catalogs",
      "core-settings-product-types",
      "core-settings-product-tags",
    ])
    expect(settings?.children?.map((child) => child.path)).toEqual([
      "/",
      "/team",
      "/api-tokens",
      "/channels",
      "/taxes",
      "/cost-categories",
      "/pricing-categories",
      "/price-catalogs",
      "/product-types",
      "/product-tags",
    ])
  })

  it("marks every contribution implemented (the index child via redirectTo)", () => {
    const settings = contributions[2]
    expect(contributions.every((contribution) => isImplementedContribution(contribution))).toBe(
      true,
    )
    expect(settings?.children?.every((child) => isImplementedContribution(child))).toBe(true)
    expect(settings?.children?.[0]).toMatchObject({
      hasPage: false,
      hasComponent: false,
      hasRedirectTo: true,
      redirectTo: "/settings/channels",
    })
  })

  it("yields the doctor's absolute path set (no '/', no index children)", () => {
    expect(collectContributionRoutePaths(contributions).sort()).toEqual([
      "/account",
      "/settings",
      "/settings/api-tokens",
      "/settings/channels",
      "/settings/cost-categories",
      "/settings/price-catalogs",
      "/settings/pricing-categories",
      "/settings/product-tags",
      "/settings/product-types",
      "/settings/taxes",
      "/settings/team",
    ])
  })
})

describe("resolveCoreAdminEntry", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-core-entry-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function writeAdminApp(exports: Record<string, string>, files: Record<string, string> = {}) {
    const dir = join(tmp, "node_modules", "@voyant-travel", "admin-app")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@voyant-travel/admin-app", version: "0.0.0", exports }),
    )
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel)
      mkdirSync(join(abs, ".."), { recursive: true })
      writeFileSync(abs, content)
    }
  }

  it("resolves when the package exposes ./core-extension", () => {
    writeAdminApp(
      { ".": "./src/index.ts", "./core-extension": "./src/core-extension/index.tsx" },
      { "src/core-extension/index.tsx": `export function createAdminCoreExtension() {}\n` },
    )
    const entry = resolveCoreAdminEntry(tmp)
    expect(entry).not.toBeNull()
    expect(entry?.importSpec).toBe(CORE_ADMIN_ENTRY_IMPORT_SPEC)
    expect(entry?.extensionId).toBe("core")
    expect(entry?.note).toBeUndefined()
    expect(entry?.contributions.map((contribution) => contribution.id)).toContain("core-settings")
    expect(entry?.subtreeComments["core-settings"]).toBe(CORE_SETTINGS_SUBTREE_COMMENT)
  })

  it("returns null when the exports map lacks ./core-extension (pre-core host)", () => {
    writeAdminApp({ ".": "./src/index.ts" })
    expect(resolveCoreAdminEntry(tmp)).toBeNull()
  })

  it("notes a resolved entry whose source lacks the factory export", () => {
    writeAdminApp(
      { "./core-extension": "./src/core-extension/index.tsx" },
      { "src/core-extension/index.tsx": `export function createSomethingElse() {}\n` },
    )
    expect(resolveCoreAdminEntry(tmp)?.note).toContain("does not export createAdminCoreExtension")
  })
})
