import { describe, expect, it } from "vitest"

import { main } from "../../src/index.js"

function makeIo() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    opts: {
      cwd: "/tmp",
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
  }
}

describe("main", () => {
  it("prints usage with --help", async () => {
    const { stdout, opts } = makeIo()
    const code = await main(["--help"], opts)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("voyant — Voyant CLI")
    expect(stdout.join("")).toContain("generate module")
  })

  it("prints usage with -h", async () => {
    const { stdout, opts } = makeIo()
    const code = await main(["-h"], opts)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("voyant — Voyant CLI")
  })

  it("prints usage with no args", async () => {
    const { stdout, opts } = makeIo()
    const code = await main([], opts)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("voyant — Voyant CLI")
  })

  it("prints usage with `help`", async () => {
    const { stdout, opts } = makeIo()
    const code = await main(["help"], opts)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("voyant — Voyant CLI")
  })

  it("errors on unknown command", async () => {
    const { stderr, opts } = makeIo()
    const code = await main(["explode"], opts)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Unknown command: explode")
  })

  it("errors on unknown generate subcommand", async () => {
    const { stderr, opts } = makeIo()
    const code = await main(["generate", "nothing"], opts)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Unknown generate subcommand: nothing")
  })

  it("dispatches generate link to the link command", async () => {
    const { stdout, opts } = makeIo()
    const code = await main(["generate", "link", "crm.person", "products.product"], opts)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("export const personProductLink")
  })

  it("dispatches `config` to the config command", async () => {
    const { stderr, opts } = makeIo()
    const code = await main(["config"], opts)
    // No config file in /tmp — expect failure with the config-specific message.
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("No voyant.config.* found")
  })

  it("dispatches `db sync-links` to the db command", async () => {
    const { stderr, opts } = makeIo()
    const code = await main(["db", "sync-links"], opts)
    // No links file discoverable in /tmp — expect failure with the specific message.
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Could not find a links file")
  })

  it("dispatches `new` to the new command", async () => {
    const { stderr, opts } = makeIo()
    const code = await main(["new"], opts)
    // No name provided — expect the new-specific usage message.
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Usage: voyant new <name>")
  })

  it("dispatches `add` and `install` to the authoring command", async () => {
    const add = makeIo()
    expect(await main(["add"], add.opts)).toBe(1)
    expect(add.stderr.join("")).toContain("Usage: voyant add")

    const install = makeIo()
    expect(await main(["install"], install.opts)).toBe(1)
    expect(install.stderr.join("")).toContain("Usage: voyant add")
  })

  it("dispatches `exec` to the exec command", async () => {
    const { stderr, opts } = makeIo()
    const code = await main(["exec"], opts)
    // No script provided — expect the exec-specific usage message.
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Usage: voyant exec")
  })
})
