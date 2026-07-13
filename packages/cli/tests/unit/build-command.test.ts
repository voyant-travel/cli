import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { buildCommand, buildProject } from "../../src/commands/build-command.js"
import { prepareProjectArtifacts } from "../../src/lib/project-artifacts.js"
import { writeProjectFixture } from "../helpers/project-fixture.js"

describe("voyant build", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voyant-build-command-"))
    writeProjectFixture(root)
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("prepares artifacts before invoking project runtime tooling", async () => {
    const order: string[] = []
    const buildVoyantProject = vi.fn(async () => order.push("build"))
    const run = io([], root)

    expect(
      await buildCommand(run.ctx, {
        env: {},
        loadEnv: async () => {
          order.push("env")
        },
        prepareArtifacts: async (...args) => {
          order.push("prepare")
          return prepareProjectArtifacts(...args)
        },
        loadTooling: async () => {
          order.push("tooling")
          return { buildVoyantProject }
        },
      }),
    ).toBe(0)

    expect(order).toEqual(["env", "prepare", "tooling", "build"])
    expect(buildVoyantProject).toHaveBeenCalledWith({ projectRoot: root })
  })

  it("keeps artifacts-only JSON output and skips runtime tooling", async () => {
    const loadTooling = vi.fn()
    const run = io(["--artifacts-only", "--json"], root)

    expect(await buildCommand(run.ctx, { loadTooling })).toBe(0)
    expect(loadTooling).not.toHaveBeenCalled()
    expect(JSON.parse(run.stdout.join(""))).toMatchObject({
      schemaVersion: "voyant.build.v1",
      ok: true,
      artifactRoot: join(root, ".voyant"),
    })
  })

  it("keeps buildProject artifact-only for programmatic callers", async () => {
    const prepareArtifacts = vi.fn((...args: Parameters<typeof prepareProjectArtifacts>) =>
      prepareProjectArtifacts(...args),
    )

    const built = await buildProject({ cwd: root }, { prepareArtifacts })

    expect(prepareArtifacts).toHaveBeenCalledOnce()
    expect(built.artifactRoot).toBe(join(root, ".voyant"))
  })

  it("documents the artifacts-only option", async () => {
    const run = io(["--help"], root)

    expect(await buildCommand(run.ctx)).toBe(0)
    expect(run.stdout.join("")).toContain("--artifacts-only")
  })
})

function io(argv: string[], cwd: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    ctx: {
      argv,
      cwd,
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
  }
}
