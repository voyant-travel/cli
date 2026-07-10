import { describe, expect, it } from "vitest"

import { parseArgs } from "../../src/lib/args.js"

describe("parseArgs", () => {
  it("parses positionals", () => {
    expect(parseArgs(["module", "invoices"])).toEqual({
      positionals: ["module", "invoices"],
      flags: {},
    })
  })

  it("parses long flags with adjacent values", () => {
    expect(parseArgs(["--dir", "custom/path"])).toEqual({
      positionals: [],
      flags: { dir: "custom/path" },
    })
  })

  it("parses long flags with = syntax", () => {
    expect(parseArgs(["--dir=custom/path"])).toEqual({
      positionals: [],
      flags: { dir: "custom/path" },
    })
  })

  it("parses boolean long flags", () => {
    expect(parseArgs(["--force"])).toEqual({
      positionals: [],
      flags: { force: true },
    })
  })

  it("parses boolean long flags followed by another flag", () => {
    expect(parseArgs(["--force", "--dir=p"])).toEqual({
      positionals: [],
      flags: { force: true, dir: "p" },
    })
  })

  it("parses short flags as booleans", () => {
    expect(parseArgs(["-f"])).toEqual({
      positionals: [],
      flags: { f: true },
    })
  })

  it("mixes positionals + flags", () => {
    expect(parseArgs(["module", "invoices", "--dir", "custom", "--force"])).toEqual({
      positionals: ["module", "invoices"],
      flags: { dir: "custom", force: true },
    })
  })

  it("handles empty input", () => {
    expect(parseArgs([])).toEqual({ positionals: [], flags: {} })
  })

  it("keeps values after declared boolean flags as positionals", () => {
    expect(parseArgs(["--plan", "@acme/plugin"], { booleanFlags: ["plan"] })).toEqual({
      positionals: ["@acme/plugin"],
      flags: { plan: true },
    })
  })
})
