import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { loadProjectRuntime, startCommand } from "../../src/commands/start.js"

describe("startCommand", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voyant-cli-start-"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-project" }))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("loads the project runtime and forwards the explicit port", async () => {
    const handle = serverHandle(5500)
    const startVoyantProject = vi.fn(async () => handle)
    const waitForShutdown = vi.fn(async (cleanup: () => Promise<void>) => cleanup())
    const { ctx, stderr } = io(["--port", "5500"], root)

    expect(
      await startCommand(ctx, {
        env: { PORT: "4400" },
        loadRuntime: async () => ({ startVoyantProject }),
        waitForShutdown,
      }),
    ).toBe(0)

    expect(startVoyantProject).toHaveBeenCalledWith({
      projectRoot: root,
      port: 5500,
      preferBuiltAdminAssets: true,
    })
    expect(waitForShutdown).toHaveBeenCalledOnce()
    expect(handle.close).toHaveBeenCalledOnce()
    expect(stderr.join("")).toContain("Node host listening on :5500")
  })

  it("uses PORT and defaults to 8080", async () => {
    for (const [env, expected] of [
      [{ PORT: "4400" }, 4400],
      [{}, 8080],
    ] as const) {
      const startVoyantProject = vi.fn(async () => serverHandle(expected))
      const { ctx } = io([], root)
      expect(
        await startCommand(ctx, {
          env,
          loadRuntime: async () => ({ startVoyantProject }),
          waitForShutdown: async (cleanup) => cleanup(),
        }),
      ).toBe(0)
      expect(startVoyantProject).toHaveBeenCalledWith(expect.objectContaining({ port: expected }))
    }
  })

  it("loads .env while preserving a platform PORT value", async () => {
    writeFileSync(join(root, ".env"), "PORT=3300\nDATABASE_URL=project-db\n")
    const env = { PORT: "4400" } as Record<string, string | undefined>
    const startVoyantProject = vi.fn(async () => serverHandle(4400))
    const { ctx } = io([], root)

    expect(
      await startCommand(ctx, {
        env,
        loadRuntime: async () => ({ startVoyantProject }),
        waitForShutdown: async (cleanup) => cleanup(),
      }),
    ).toBe(0)

    expect(env).toEqual({ PORT: "4400", DATABASE_URL: "project-db" })
    expect(startVoyantProject).toHaveBeenCalledWith(expect.objectContaining({ port: 4400 }))
  })

  it("probes the started host and closes it", async () => {
    const handle = serverHandle(8080)
    handle.server.listening = false
    queueMicrotask(() => {
      handle.server.listening = true
      handle.server.emit("listening")
    })
    const fetch = vi.fn(async () => new Response("ok"))
    const waitForShutdown = vi.fn()
    const { ctx, stderr } = io(["--probe"], root)

    expect(
      await startCommand(ctx, {
        env: {},
        fetch,
        loadRuntime: async () => ({ startVoyantProject: async () => handle }),
        waitForShutdown,
      }),
    ).toBe(0)

    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8080/healthz")
    expect(handle.close).toHaveBeenCalledOnce()
    expect(waitForShutdown).not.toHaveBeenCalled()
    expect(stderr.join("")).toContain("boot probe passed")
  })

  it("reports a failed probe and still closes the host", async () => {
    const handle = serverHandle(8080)
    const { ctx, stderr } = io(["--probe"], root)

    expect(
      await startCommand(ctx, {
        env: {},
        fetch: async () => new Response("not ready", { status: 503 }),
        loadRuntime: async () => ({ startVoyantProject: async () => handle }),
      }),
    ).toBe(1)

    expect(handle.close).toHaveBeenCalledOnce()
    expect(stderr.join("")).toContain("Node host health probe failed")
  })

  it("prints command help without loading the runtime", async () => {
    const loadRuntime = vi.fn()
    const { ctx, stdout } = io(["--help"], root)

    expect(await startCommand(ctx, { loadRuntime })).toBe(0)
    expect(loadRuntime).not.toHaveBeenCalled()
    expect(stdout.join("")).toContain("voyant start [--port <n>] [--probe]")
  })

  it("reports a clear error when the project runtime is absent", async () => {
    const { ctx, stderr } = io([], root)

    expect(await startCommand(ctx)).toBe(1)
    expect(stderr.join("")).toContain("@voyant-travel/runtime is not installed")
    expect(stderr.join("")).toContain("current project")
  })
})

describe("loadProjectRuntime", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voyant-cli-runtime-"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-project" }))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("resolves the public runtime export from the project", async () => {
    writeRuntimePackage(root, "export async function startVoyantProject() {}\n")

    const runtime = await loadProjectRuntime(root)

    expect(runtime.startVoyantProject).toBeTypeOf("function")
  })

  it("rejects a runtime without the public start API", async () => {
    writeRuntimePackage(root, "export const version = 'old'\n")

    await expect(loadProjectRuntime(root)).rejects.toThrow("does not export startVoyantProject()")
  })

  it("explains how to load a linked TypeScript runtime when tsx is absent", async () => {
    writeRuntimePackage(root, "export async function startVoyantProject() {}\n", "index.ts")

    await expect(loadProjectRuntime(root)).rejects.toThrow(
      "resolves to TypeScript, but tsx is not installed",
    )
  })
})

function writeRuntimePackage(root: string, source: string, entry = "index.mjs"): void {
  const packageRoot = join(root, "node_modules", "@voyant-travel", "runtime")
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@voyant-travel/runtime",
      type: "module",
      exports: { ".": `./${entry}` },
    }),
  )
  writeFileSync(join(packageRoot, entry), source)
}

function serverHandle(port: number) {
  const server = Object.assign(new EventEmitter(), { listening: true })
  return { port, server, close: vi.fn(async () => {}) }
}

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
