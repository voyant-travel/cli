import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  checkProjectArtifacts,
  PROJECT_ARTIFACT_MANIFEST,
  prepareProjectArtifacts,
} from "../../src/lib/project-artifacts.js"
import { writeProjectConfig, writeProjectFixture } from "../helpers/project-fixture.js"

describe("project artifacts", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voyant-project-artifacts-"))
    writeProjectFixture(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("loads the project-installed framework resolver and writes deterministic .voyant outputs", async () => {
    const first = await prepareProjectArtifacts(root)
    const firstManifest = readFileSync(join(root, ".voyant", PROJECT_ARTIFACT_MANIFEST), "utf8")
    const firstGraph = readFileSync(join(root, ".voyant", first.manifest.graph), "utf8")

    const second = await prepareProjectArtifacts(root)

    expect(second.manifest.graphHash).toBe(first.manifest.graphHash)
    expect(readFileSync(join(root, ".voyant", PROJECT_ARTIFACT_MANIFEST), "utf8")).toBe(
      firstManifest,
    )
    expect(readFileSync(join(root, ".voyant", second.manifest.graph), "utf8")).toBe(firstGraph)
    expect(second.manifest.files).toEqual([
      "deployment-graph.generated.json",
      "migration-plan.generated.json",
      "runtime/project-migrations.generated.mjs",
      "runtime/project-runtime.generated.ts",
    ])
    expect(existsSync(second.runtimeEntryPath)).toBe(true)
  })

  it("replaces .voyant as a complete artifact set", async () => {
    await prepareProjectArtifacts(root)
    const stalePath = join(root, ".voyant", "runtime", "removed.generated.ts")
    writeFileSync(stalePath, "export const stale = true\n")

    await prepareProjectArtifacts(root)

    expect(existsSync(stalePath)).toBe(false)
  })

  it("detects artifacts made stale by a config change", async () => {
    const prepared = await prepareProjectArtifacts(root)
    writeProjectConfig(root, { modules: ["@acme/bookings", "@acme/loyalty"] })

    await expect(checkProjectArtifacts(root)).rejects.toMatchObject({
      code: "artifact_stale",
    })
    await expect(checkProjectArtifacts(root)).rejects.toThrow(prepared.manifest.graphHash)
  })

  it("fails clearly when generated outputs are missing", async () => {
    await expect(checkProjectArtifacts(root)).rejects.toMatchObject({
      code: "artifact_missing",
    })
    await expect(checkProjectArtifacts(root)).rejects.toThrow("Run `voyant build` or `voyant dev`")
  })
})
