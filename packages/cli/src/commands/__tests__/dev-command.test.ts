import { describe, expect, it, vi } from "vitest"
import type { DevDeps } from "../dev.js"
import { devCommand } from "../dev-command.js"

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

describe("devCommand", () => {
  it("prints help before required --file validation", async () => {
    const { ctx, stdout, stderr } = makeCtx(["--help"])

    const code = await devCommand(ctx)

    expect(code).toBe(0)
    expect(stdout.join("")).toContain("voyant dev --file <path>")
    expect(stderr.join("")).not.toContain("missing required --file")
  })

  it("keeps running until shutdown is released", async () => {
    const { ctx, stderr } = makeCtx(["--file", "src/workflows.ts", "--port", "3310"])
    const closeServe = vi.fn(async () => {})
    const disposeBundler = vi.fn(async () => {})
    const devDeps: DevDeps = {
      startBundler: async ({ onRebuild }) => {
        await onRebuild({ ok: true, errors: [] })
        return { dispose: disposeBundler }
      },
      startServe: async () => ({
        url: "http://127.0.0.1:3310",
        close: closeServe,
        workflowCount: 1,
      }),
      log: () => {},
    }

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
    const command = devCommand(ctx, { devDeps, waitForShutdown }).then((code) => {
      settled = true
      return code
    })

    await vi.waitFor(() => expect(waitForShutdown).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(stderr.join("")).toContain("voyant dev: listening at http://127.0.0.1:3310")

    await cleanup?.()
    release?.()

    await expect(command).resolves.toBe(0)
    expect(closeServe).toHaveBeenCalledTimes(1)
    expect(disposeBundler).toHaveBeenCalledTimes(1)
  })
})
