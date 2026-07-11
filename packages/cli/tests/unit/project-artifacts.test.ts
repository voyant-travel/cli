import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
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
  let frameworkWrites: Array<{
    projectRoot: string
    artifacts: { files: readonly { path: string; contents: string }[] }
    mode: string
  }>

  beforeEach(() => {
    frameworkWrites = []
    ;(
      globalThis as typeof globalThis & {
        __voyantFrameworkArtifactWrites?: typeof frameworkWrites
      }
    ).__voyantFrameworkArtifactWrites = frameworkWrites
    root = mkdtempSync(join(tmpdir(), "voyant-project-artifacts-"))
    writeProjectFixture(root)
  })

  afterEach(() => {
    delete (
      globalThis as typeof globalThis & { __voyantFrameworkArtifactWrites?: typeof frameworkWrites }
    ).__voyantFrameworkArtifactWrites
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
    expect(frameworkWrites).toHaveLength(2)
    expect(frameworkWrites[0]?.mode).toBe("write")
    expect(frameworkWrites[0]?.projectRoot).toBe(root)
    expect(frameworkWrites[0]?.artifacts.files.map((file) => file.path)).toEqual([
      "deployment-artifacts.generated.json",
      "deployment-graph.generated.json",
      "migration-plan.generated.json",
      "runtime/project-migrations.generated.mjs",
      "runtime/project-runtime.generated.ts",
    ])
  })

  it("delegates check mode and reports stale and missing framework results", async () => {
    await prepareProjectArtifacts(root)
    writeFileSync(join(root, ".voyant", PROJECT_ARTIFACT_MANIFEST), "{}\n")
    unlinkSync(join(root, ".voyant", "runtime", "project-runtime.generated.ts"))

    await expect(checkProjectArtifacts(root)).rejects.toMatchObject({ code: "artifact_missing" })
    await expect(checkProjectArtifacts(root)).rejects.toThrow(
      "missing: runtime/project-runtime.generated.ts; stale: deployment-artifacts.generated.json",
    )

    expect(frameworkWrites.at(-1)?.mode).toBe("check")
  })

  it("detects artifacts made stale by a config change", async () => {
    await prepareProjectArtifacts(root)
    writeProjectConfig(root, { modules: ["@acme/bookings", "@acme/loyalty"] })

    await expect(checkProjectArtifacts(root)).rejects.toMatchObject({
      code: "artifact_stale",
    })
    await expect(checkProjectArtifacts(root)).rejects.toThrow(
      "stale: deployment-artifacts.generated.json",
    )
  })

  it("fails clearly when generated outputs are missing", async () => {
    await expect(checkProjectArtifacts(root)).rejects.toMatchObject({
      code: "artifact_missing",
    })
    await expect(checkProjectArtifacts(root)).rejects.toThrow("Run `voyant build` or `voyant dev`")
  })
})
