import type { WorkflowDefinition } from "@voyant-travel/workflows"
import { describe, expect, it } from "vitest"
import {
  buildManifest,
  DYNAMIC_FUNCTION,
  hashRun,
  MANIFEST_SCHEMA_VERSION,
  type ManifestWorkflow,
} from "../manifest.js"

function wf(partial: {
  id: string
  run: (input: unknown, ctx: unknown) => Promise<unknown>
  description?: string
  schedule?: unknown
  concurrency?: unknown
  retry?: unknown
  timeout?: unknown
  defaultRuntime?: "edge" | "node"
  tags?: string[]
}): WorkflowDefinition {
  return {
    id: partial.id,
    config: { ...partial, run: partial.run },
  } as unknown as WorkflowDefinition
}

describe("hashRun", () => {
  it("is stable across calls with the same source", () => {
    const fn = async (): Promise<void> => {
      /* body */
    }
    expect(hashRun(fn)).toBe(hashRun(fn))
  })

  it("yields a 12-hex-char string", () => {
    const h = hashRun(async () => 1)
    expect(h).toMatch(/^[0-9a-f]{12}$/)
  })

  it("differs when the body differs", () => {
    expect(hashRun(async () => 1)).not.toBe(hashRun(async () => 2))
  })

  it("ignores trailing whitespace / blank-line differences", () => {
    const a = "async function x() {\n  return 1;\n}"
    const b = "async function x() {  \n\n  return 1;   \n}"
    expect(hashRun(a)).toBe(hashRun(b))
  })
})

describe("buildManifest", () => {
  const fixedNow = (): string => "2026-04-17T00:00:00.000Z"

  it("produces a schemaVersion + generatedAt + entryFile envelope", () => {
    const m = buildManifest({
      entryFile: "/abs/path/app.js",
      workflows: [wf({ id: "a", run: async () => 1 })],
      now: fixedNow,
    })
    expect(m.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION)
    expect(m.generatedAt).toBe("2026-04-17T00:00:00.000Z")
    expect(m.entryFile).toBe("/abs/path/app.js")
    expect(m.workflows).toHaveLength(1)
  })

  it("sorts workflows by id for deterministic output", () => {
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [
        wf({ id: "zeta", run: async () => 1 }),
        wf({ id: "alpha", run: async () => 2 }),
        wf({ id: "middle", run: async () => 3 }),
      ],
      now: fixedNow,
    })
    expect(m.workflows.map((w) => w.id)).toEqual(["alpha", "middle", "zeta"])
  })

  it("omits undefined optional fields", () => {
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [wf({ id: "plain", run: async () => 1 })],
      now: fixedNow,
    })
    const wfOut = m.workflows[0]!
    expect(Object.keys(wfOut).sort()).toEqual(["id", "version"])
  })

  it("captures description, retry, timeout, defaultRuntime, tags verbatim", () => {
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [
        wf({
          id: "rich",
          description: "does a thing",
          retry: { max: 3, backoff: "exponential", initial: "500ms" } as never,
          timeout: "30s" as never,
          defaultRuntime: "node",
          tags: ["critical", "reminder"],
          run: async () => 1,
        }),
      ],
      now: fixedNow,
    })
    const wfOut = m.workflows[0]!
    expect(wfOut.description).toBe("does a thing")
    expect(wfOut.retry).toEqual({ max: 3, backoff: "exponential", initial: "500ms" })
    expect(wfOut.timeout).toBe("30s")
    expect(wfOut.defaultRuntime).toBe("node")
    expect(wfOut.tags).toEqual(["critical", "reminder"])
  })

  it("does NOT include empty tag arrays (treated as undefined)", () => {
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [wf({ id: "notag", tags: [], run: async () => 1 })],
      now: fixedNow,
    })
    expect(m.workflows[0]).not.toHaveProperty("tags")
  })

  it("normalizes a single schedule to an array", () => {
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [
        wf({
          id: "sch",
          schedule: { cron: "0 9 * * *", name: "daily", timezone: "UTC" } as never,
          run: async () => 1,
        }),
      ],
      now: fixedNow,
    })
    expect(m.workflows[0]!.schedule).toEqual([
      { cron: "0 9 * * *", name: "daily", timezone: "UTC" },
    ])
  })

  it("passes multiple schedules through and converts Date `at` to ISO", () => {
    const at = new Date(Date.UTC(2027, 0, 1))
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [
        wf({
          id: "sch",
          schedule: [{ cron: "*/5 * * * *" } as never, { at } as never, { every: "1m" } as never],
          run: async () => 1,
        }),
      ],
      now: fixedNow,
    })
    const s = m.workflows[0]!.schedule!
    expect(s[0]).toEqual({ cron: "*/5 * * * *" })
    expect(s[1]).toEqual({ at: at.toISOString() })
    expect(s[2]).toEqual({ every: "1m" })
  })

  it("replaces function-valued schedule.input with the dynamic sentinel", () => {
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [
        wf({
          id: "sch",
          schedule: { every: "1m", input: () => ({ n: Date.now() }) } as never,
          run: async () => 1,
        }),
      ],
      now: fixedNow,
    })
    expect(m.workflows[0]!.schedule![0]!.input).toEqual(DYNAMIC_FUNCTION)
  })

  it("keeps literal schedule.input values verbatim", () => {
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [
        wf({
          id: "sch",
          schedule: { every: "1m", input: { n: 1 } } as never,
          run: async () => 1,
        }),
      ],
      now: fixedNow,
    })
    expect(m.workflows[0]!.schedule![0]!.input).toEqual({ n: 1 })
  })

  it("replaces function-valued concurrency.key with the dynamic sentinel", () => {
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [
        wf({
          id: "concur",
          concurrency: { key: (i: { uid: string }) => i.uid, limit: 3 } as never,
          run: async () => 1,
        }),
      ],
      now: fixedNow,
    })
    expect(m.workflows[0]!.concurrency).toEqual({ key: DYNAMIC_FUNCTION, limit: 3 })
  })

  it("keeps string concurrency.key verbatim", () => {
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [
        wf({
          id: "concur",
          concurrency: { key: "static-key", strategy: "queue" } as never,
          run: async () => 1,
        }),
      ],
      now: fixedNow,
    })
    expect(m.workflows[0]!.concurrency).toEqual({ key: "static-key", strategy: "queue" })
  })

  it("assigns each workflow its own version hash", () => {
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [wf({ id: "a", run: async () => 1 }), wf({ id: "b", run: async () => 2 })],
      now: fixedNow,
    })
    const [a, b] = m.workflows as [ManifestWorkflow, ManifestWorkflow]
    expect(a.version).not.toBe(b.version)
    expect(a.version).toMatch(/^[0-9a-f]{12}$/)
    expect(b.version).toMatch(/^[0-9a-f]{12}$/)
  })

  it("is JSON-stringify safe (no functions leak through)", () => {
    const m = buildManifest({
      entryFile: "/app.js",
      workflows: [
        wf({
          id: "mix",
          concurrency: { key: (i: { uid: string }) => i.uid } as never,
          schedule: { every: "1m", input: () => ({}) } as never,
          run: async () => 1,
        }),
      ],
      now: fixedNow,
    })
    const round = JSON.parse(JSON.stringify(m))
    expect(round).toEqual(m)
  })
})
