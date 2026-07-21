import { describe, expect, it } from "vitest"
import { getBooleanFlag, getStringFlag, parseArgs } from "../args.js"

describe("parseArgs", () => {
  it("collects positional args", () => {
    const parsed = parseArgs(["a", "b", "c"])
    expect(parsed).toEqual({
      positionals: ["a", "b", "c"],
      flags: {},
    })
  })

  it("parses --flag=value form", () => {
    expect(parseArgs(["--key=value", "--other=123"]).flags).toEqual({
      key: "value",
      other: "123",
    })
  })

  it("parses --flag value form when next arg is not a flag", () => {
    expect(parseArgs(["--input", "./in.json", "--count", "3"]).flags).toEqual({
      input: "./in.json",
      count: "3",
    })
  })

  it("treats bare --flag as boolean true", () => {
    expect(parseArgs(["--json"]).flags).toEqual({ json: true })
  })

  it("does not consume the next arg if it starts with --", () => {
    expect(parseArgs(["--foo", "--bar"]).flags).toEqual({
      foo: true,
      bar: true,
    })
  })

  it("mixes positional and flags in any order", () => {
    const parsed = parseArgs(["list", "--file", "./a.js", "--json"])
    expect(parsed.positionals).toEqual(["list"])
    expect(parsed.flags).toEqual({ file: "./a.js", json: true })
  })
})

describe("getStringFlag / getBooleanFlag", () => {
  it("returns the first matching string value across aliases", () => {
    const p = parseArgs(["--entry", "./a.js"])
    expect(getStringFlag(p, "file", "entry")).toBe("./a.js")
  })

  it("returns undefined when no alias matches or when value is boolean", () => {
    const p = parseArgs(["--other", "true"])
    expect(getStringFlag(p, "file")).toBeUndefined()
  })

  it("detects boolean flags", () => {
    const p = parseArgs(["--json"])
    expect(getBooleanFlag(p, "json")).toBe(true)
    expect(getBooleanFlag(p, "file")).toBe(false)
  })
})
