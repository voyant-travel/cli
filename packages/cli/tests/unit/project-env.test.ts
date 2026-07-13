import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  loadProjectEnv,
  parseProjectEnv,
  resolveProjectEnvRoot,
} from "../../src/lib/project-env.js"

describe("project environment", () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    roots.length = 0
  })

  it("parses dotenv quoting, comments, exports, and escaped newlines", () => {
    expect(
      parseProjectEnv(`PLAIN=value # comment
export SINGLE='literal # value'
DOUBLE="line\\nnext"
EMPTY=
`),
    ).toEqual({
      PLAIN: "value",
      SINGLE: "literal # value",
      DOUBLE: "line\nnext",
      EMPTY: "",
    })
  })

  it("loads project values without overriding platform variables", async () => {
    const root = mkdtempSync(join(tmpdir(), "voyant-env-"))
    roots.push(root)
    writeFileSync(join(root, ".env"), "PORT=3300\nDATABASE_URL=project\n")
    const env = { PORT: "8080" } as Record<string, string | undefined>

    await loadProjectEnv(root, env)

    expect(env).toEqual({ PORT: "8080", DATABASE_URL: "project" })
  })

  it("finds the project environment root from a nested working directory", () => {
    const root = mkdtempSync(join(tmpdir(), "voyant-env-root-"))
    roots.push(root)
    const nested = join(root, "src", "jobs")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(root, "voyant.config.mjs"), "export default {}\n")

    expect(resolveProjectEnvRoot(nested)).toBe(root)
  })
})
