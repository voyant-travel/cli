import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { loadProjectTooling } from "../../src/lib/project-tooling.js"

describe("project runtime tooling loader", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voyant-tooling-"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("reports a missing project runtime", async () => {
    await expect(loadProjectTooling(root)).rejects.toThrow(
      "@voyant-travel/runtime is not installed in the current project",
    )
  })

  it("reports an installed runtime without the tooling export as outdated", async () => {
    writeRuntimePackage({ ".": "./index.mjs" })

    await expect(loadProjectTooling(root)).rejects.toThrow(
      "does not provide its tooling export. Upgrade it",
    )
  })

  it("loads the structural tooling export from the project", async () => {
    writeRuntimePackage({ ".": "./index.mjs", "./tooling": "./tooling.mjs" })
    writeFileSync(
      join(root, "node_modules", "@voyant-travel", "runtime", "tooling.mjs"),
      "export async function buildVoyantProject() {}\n",
    )

    const tooling = await loadProjectTooling(root)

    expect(tooling.buildVoyantProject).toBeTypeOf("function")
  })

  function writeRuntimePackage(exports: Record<string, string>): void {
    const packageRoot = join(root, "node_modules", "@voyant-travel", "runtime")
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@voyant-travel/runtime", type: "module", exports }),
    )
    writeFileSync(join(packageRoot, "index.mjs"), "export const runtime = true\n")
  }
})
