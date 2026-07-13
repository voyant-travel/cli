import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { developCommand } from "../../src/commands/develop.js"
import { prepareProjectArtifacts } from "../../src/lib/project-artifacts.js"
import { writeProjectFixture } from "../helpers/project-fixture.js"

describe("voyant develop", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voyant-develop-"))
    writeProjectFixture(root)
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("loads env, prepares artifacts, starts runtime tooling, and closes on shutdown", async () => {
    const order: string[] = []
    const close = vi.fn(async () => {
      order.push("close")
    })
    const developVoyantProject = vi.fn(async () => {
      order.push("develop")
      return { url: "http://localhost:4400", close }
    })
    const run = io(["--host", "0.0.0.0", "--port", "4400"], root)

    expect(
      await developCommand(run.ctx, {
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
          return { developVoyantProject }
        },
        watchProjectInputs: () => ({
          close: () => {
            order.push("watcher-close")
          },
        }),
        waitForShutdown: async (cleanup) => {
          order.push("wait")
          await cleanup()
        },
      }),
    ).toBe(0)

    expect(developVoyantProject).toHaveBeenCalledWith({
      projectRoot: root,
      host: "0.0.0.0",
      port: 4400,
    })
    expect(order).toEqual([
      "env",
      "prepare",
      "tooling",
      "develop",
      "wait",
      "watcher-close",
      "close",
    ])
    expect(run.stderr.join("")).toContain("voyant develop: http://localhost:4400")
  })

  it("shows help without preparing or loading tooling", async () => {
    const prepareArtifacts = vi.fn()
    const loadTooling = vi.fn()
    const run = io(["--help"], root)

    expect(await developCommand(run.ctx, { prepareArtifacts, loadTooling })).toBe(0)
    expect(prepareArtifacts).not.toHaveBeenCalled()
    expect(loadTooling).not.toHaveBeenCalled()
    expect(run.stdout.join("")).toContain("voyant develop [--config <path>]")
  })

  it("reports outdated tooling that lacks the development API", async () => {
    const run = io([], root)

    expect(
      await developCommand(run.ctx, {
        prepareArtifacts: (...args) => prepareProjectArtifacts(...args),
        loadTooling: async () => ({}),
      }),
    ).toBe(1)
    expect(run.stderr.join("")).toContain("does not export developVoyantProject()")
    expect(run.stderr.join("")).toContain("Upgrade @voyant-travel/runtime")
  })

  it("serializes artifact refreshes without restarting Vite", async () => {
    let onChange: (() => Promise<void>) | undefined
    let cleanup: (() => Promise<void>) | undefined
    let releaseShutdown: (() => void) | undefined
    let releaseRefresh: (() => void) | undefined
    let prepareCalls = 0
    let activeRefreshes = 0
    let maxActiveRefreshes = 0
    const prepareArtifacts = vi.fn(async (...args: Parameters<typeof prepareProjectArtifacts>) => {
      prepareCalls += 1
      if (prepareCalls > 1) {
        activeRefreshes += 1
        maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes)
        if (prepareCalls === 2) {
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve
          })
        }
      }
      const prepared = await prepareProjectArtifacts(...args)
      if (prepareCalls > 1) activeRefreshes -= 1
      return prepared
    })
    const close = vi.fn(async () => {})
    const developVoyantProject = vi.fn(async () => ({ url: "http://localhost:3300", close }))
    const closeWatcher = vi.fn()
    const run = io([], root)

    const command = developCommand(run.ctx, {
      prepareArtifacts,
      loadTooling: async () => ({ developVoyantProject }),
      watchProjectInputs: (input, refresh) => {
        expect(input).toMatchObject({
          projectRoot: root,
          configPath: join(root, "voyant.config.mjs"),
        })
        onChange = refresh
        return { close: closeWatcher }
      },
      waitForShutdown: (fn) =>
        new Promise<void>((resolve) => {
          cleanup = fn
          releaseShutdown = resolve
        }),
    })

    await vi.waitFor(() => expect(onChange).toBeTypeOf("function"))
    const first = onChange?.()
    await vi.waitFor(() => expect(prepareCalls).toBe(2))
    const second = onChange?.()
    await Promise.resolve()
    expect(prepareCalls).toBe(2)
    expect(developVoyantProject).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()

    releaseRefresh?.()
    await Promise.all([first, second])
    expect(prepareCalls).toBe(3)
    expect(maxActiveRefreshes).toBe(1)
    expect(run.stderr.join("").match(/project artifacts refreshed/g)).toHaveLength(2)

    await cleanup?.()
    await onChange?.()
    expect(prepareCalls).toBe(3)
    releaseShutdown?.()
    await expect(command).resolves.toBe(0)
    expect(closeWatcher).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("reports refresh errors and keeps development running", async () => {
    let onChange: (() => Promise<void>) | undefined
    let cleanup: (() => Promise<void>) | undefined
    let releaseShutdown: (() => void) | undefined
    let prepareCalls = 0
    const prepareArtifacts = vi.fn(async (...args: Parameters<typeof prepareProjectArtifacts>) => {
      prepareCalls += 1
      if (prepareCalls > 1) throw new Error("generated routes are invalid")
      return prepareProjectArtifacts(...args)
    })
    const close = vi.fn(async () => {})
    const run = io([], root)

    const command = developCommand(run.ctx, {
      prepareArtifacts,
      loadTooling: async () => ({
        developVoyantProject: async () => ({ url: "http://localhost:3300", close }),
      }),
      watchProjectInputs: (_input, refresh) => {
        onChange = refresh
        return { close: vi.fn() }
      },
      waitForShutdown: (fn) =>
        new Promise<void>((resolve) => {
          cleanup = fn
          releaseShutdown = resolve
        }),
    })

    await vi.waitFor(() => expect(onChange).toBeTypeOf("function"))
    await onChange?.()

    expect(run.stderr.join("")).toContain(
      "voyant develop: project artifact refresh failed: generated routes are invalid",
    )
    expect(close).not.toHaveBeenCalled()

    await cleanup?.()
    releaseShutdown?.()
    await expect(command).resolves.toBe(0)
    expect(close).toHaveBeenCalledOnce()
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
