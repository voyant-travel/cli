import { describe, expect, it, vi } from "vitest"
import type { ServeDeps } from "../workflows/serve.js"
import { workflowsCommand } from "../workflows-command.js"

function makeCtx(argv: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    ctx: {
      argv,
      cwd: "/tmp",
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
  }
}

describe("workflowsCommand", () => {
  it("prints serve help without starting the server", async () => {
    const { ctx, stdout, stderr } = makeCtx(["serve", "--help"])
    const defaultServeDeps = vi.fn(async () => ({}) as ServeDeps)
    const startServer = vi.fn(async () => ({
      url: "http://127.0.0.1:3232",
      close: async () => {},
    }))

    const code = await workflowsCommand(ctx, {
      defaultServeDeps,
      startServer,
    })

    expect(code).toBe(0)
    expect(stdout.join("")).toContain("voyant workflows serve [--port <n>]")
    expect(stderr.join("")).not.toContain("listening at")
    expect(defaultServeDeps).not.toHaveBeenCalled()
    expect(startServer).not.toHaveBeenCalled()
  })

  it("keeps serve running until shutdown is released", async () => {
    const { ctx, stderr } = makeCtx(["serve", "--file", "bundle.cjs", "--port", "3310"])
    const close = vi.fn(async () => {})
    const defaultServeDeps = vi.fn(
      async () =>
        ({
          listWorkflows: () => [{ id: "bookTrip" }],
          listSchedules: () => [],
          triggerRun: async () => {
            throw new Error("not used")
          },
        }) as ServeDeps,
    )
    const startServer = vi.fn(async () => ({
      url: "http://127.0.0.1:3310",
      close,
    }))

    let cleanup: (() => Promise<void>) | undefined
    let release: (() => void) | undefined
    const waitForShutdown = vi.fn(
      (fn: () => Promise<void>) =>
        new Promise<void>((resolve) => {
          cleanup = fn
          release = resolve
        }),
    )

    let settled = false
    const command = workflowsCommand(ctx, {
      defaultServeDeps,
      startServer,
      waitForShutdown,
    }).then((code) => {
      settled = true
      return code
    })

    await vi.waitFor(() => expect(waitForShutdown).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(stderr.join("")).toContain("voyant workflows serve: listening at http://127.0.0.1:3310")
    expect(stderr.join("")).toContain("Press Ctrl+C to stop.")

    await cleanup?.()
    release?.()

    await expect(command).resolves.toBe(0)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
