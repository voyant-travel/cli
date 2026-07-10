import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { DevDeps } from "../dev.js"
import { devCommand } from "../dev-command.js"

function makeCtx(argv: string[], cwd = "/tmp") {
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

describe("devCommand", () => {
  it("prints help before required --file validation", async () => {
    const { ctx, stdout, stderr } = makeCtx(["--help"])

    const code = await devCommand(ctx)

    expect(code).toBe(0)
    expect(stdout.join("")).toContain("voyant dev [--file <path>]")
    expect(stderr.join("")).not.toContain("missing required --file")
  })

  it("reports missing entry source when neither --file nor deployment artifacts exist", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "voyant-dev-command-"))
    const { ctx, stderr } = makeCtx([], tmp)

    const code = await devCommand(ctx)

    expect(code).toBe(2)
    expect(stderr.join("")).toContain(
      "voyant dev: missing --file <path> and no deployment-artifacts.generated.json was found",
    )
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

  it("defaults to the managed Node runtime entry declared by deployment artifacts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "voyant-dev-command-"))
    mkdirSync(join(tmp, "src"), { recursive: true })
    writeDeploymentArtifacts(tmp, "src/runtime-entry.generated.ts")
    const { ctx, stderr } = makeCtx(["--port", "3310"], tmp)
    const startedEntries: string[] = []
    const devDeps = makeReadyDevDeps(startedEntries)

    const code = await devCommand(ctx, {
      devDeps,
      waitForShutdown: async (cleanup) => {
        await cleanup()
      },
    })

    expect(code).toBe(0)
    expect(startedEntries).toEqual([join(tmp, "src/runtime-entry.generated.ts")])
    expect(stderr.join("")).toContain("graph     deployment-artifacts.generated.json")
  })

  it("honors a custom deployment artifacts path when --file is omitted", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "voyant-dev-command-"))
    mkdirSync(join(tmp, "generated"), { recursive: true })
    writeDeploymentArtifacts(join(tmp, "generated"), "runtime-entry.generated.ts")
    const { ctx } = makeCtx(
      ["--deployment-artifacts", "generated/deployment-artifacts.generated.json"],
      tmp,
    )
    const startedEntries: string[] = []
    const devDeps = makeReadyDevDeps(startedEntries)

    const code = await devCommand(ctx, {
      devDeps,
      waitForShutdown: async (cleanup) => {
        await cleanup()
      },
    })

    expect(code).toBe(0)
    expect(startedEntries).toEqual([join(tmp, "generated/runtime-entry.generated.ts")])
  })
})

function makeReadyDevDeps(startedEntries: string[]): DevDeps {
  return {
    startBundler: async ({ entryFile, onRebuild }) => {
      startedEntries.push(entryFile)
      await onRebuild({ ok: true, errors: [] })
      return { dispose: async () => {} }
    },
    startServe: async () => ({
      url: "http://127.0.0.1:3310",
      close: async () => {},
      workflowCount: 1,
    }),
    log: () => {},
  }
}

function writeDeploymentArtifacts(root: string, entryFile: string): void {
  writeFileSync(
    join(root, "deployment-artifacts.generated.json"),
    `${JSON.stringify(
      {
        schemaVersion: "voyant.deployment-artifacts.v1",
        graphHash: "sha256:example",
        graph: "deployment-graph.generated.json",
        runtimeEntries: [
          {
            id: "@voyant-travel/framework#runtime.node",
            target: "node",
            file: entryFile,
            graphHash: "sha256:example",
            kind: "managed-profile-node",
            profileSnapshot: "managed-profile.json",
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
}
