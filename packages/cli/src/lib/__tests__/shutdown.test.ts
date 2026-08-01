import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

import { type ShutdownSignal, waitForShutdownSignal } from "../shutdown.js"

describe("waitForShutdownSignal", () => {
  it("waits for a signal, runs cleanup, and removes listeners", async () => {
    const target = new EventEmitter()
    const cleanup = vi.fn(async () => {})

    const done = waitForShutdownSignal(cleanup, {
      target,
      signals: ["SIGINT", "SIGTERM"],
    })

    expect(cleanup).not.toHaveBeenCalled()
    expect(target.listenerCount("SIGINT")).toBe(1)
    expect(target.listenerCount("SIGTERM")).toBe(1)

    target.emit("SIGINT" satisfies ShutdownSignal)
    await done

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(target.listenerCount("SIGINT")).toBe(0)
    expect(target.listenerCount("SIGTERM")).toBe(0)
  })

  it("can be cancelled without running cleanup or retaining listeners", async () => {
    const target = new EventEmitter()
    const cleanup = vi.fn(async () => {})
    const controller = new AbortController()
    const done = waitForShutdownSignal(cleanup, {
      target,
      signals: ["SIGINT", "SIGTERM"],
      abortSignal: controller.signal,
    })

    controller.abort()
    await done

    expect(cleanup).not.toHaveBeenCalled()
    expect(target.listenerCount("SIGINT")).toBe(0)
    expect(target.listenerCount("SIGTERM")).toBe(0)
  })
})
