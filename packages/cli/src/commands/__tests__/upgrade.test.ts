import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CommandContext } from "../../types.js"
import { upgradeCommand } from "../upgrade.js"

function makeCtx(cwd: string, argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const ctx: CommandContext = {
    cwd,
    argv,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  }
  return { ctx, out: () => out.join(""), err: () => err.join("") }
}

const FRAMEWORK = "@voyant-travel/framework"

describe("upgradeCommand", () => {
  let dir: string
  const writePkg = (deps: Record<string, string>) =>
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme", dependencies: deps }))
  const frameworkRange = () =>
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies[FRAMEWORK]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "voyant-upgrade-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("bumps the framework BOM as a caret range and installs", async () => {
    writePkg({ [FRAMEWORK]: "^2.3.0" })
    const runInstall = vi.fn(async () => 0)
    const { ctx, out } = makeCtx(dir, [])
    const code = await upgradeCommand(ctx, { resolveLatestVersion: () => "2.4.0", runInstall })
    expect(code).toBe(0)
    expect(frameworkRange()).toBe("^2.4.0")
    expect(runInstall).toHaveBeenCalledWith(dir, expect.any(String))
    expect(out()).toMatch(/voyant db migrate/)
  })

  it("--dry-run neither writes nor installs", async () => {
    writePkg({ [FRAMEWORK]: "^2.3.0" })
    const runInstall = vi.fn(async () => 0)
    const { ctx, out } = makeCtx(dir, ["--dry-run"])
    await upgradeCommand(ctx, { resolveLatestVersion: () => "2.4.0", runInstall })
    expect(frameworkRange()).toBe("^2.3.0")
    expect(runInstall).not.toHaveBeenCalled()
    expect(out()).toMatch(/Would update/)
  })

  it("reports already up to date", async () => {
    writePkg({ [FRAMEWORK]: "^2.4.0" })
    const { ctx, out } = makeCtx(dir, [])
    const code = await upgradeCommand(ctx, {
      resolveLatestVersion: () => "2.4.0",
      runInstall: async () => 0,
    })
    expect(code).toBe(0)
    expect(out()).toMatch(/Already on/)
  })

  it("--to pins an explicit version without resolving latest", async () => {
    writePkg({ [FRAMEWORK]: "^2.3.0" })
    const resolveLatestVersion = vi.fn(() => "2.4.0")
    const { ctx } = makeCtx(dir, ["--to", "2.5.0-rc.1"])
    await upgradeCommand(ctx, { resolveLatestVersion, runInstall: async () => 0 })
    expect(frameworkRange()).toBe("^2.5.0-rc.1")
    expect(resolveLatestVersion).not.toHaveBeenCalled()
  })

  it("errors when the BOM is not a dependency", async () => {
    writePkg({ "other-pkg": "^1.0.0" })
    const { ctx, err } = makeCtx(dir, [])
    const code = await upgradeCommand(ctx, { resolveLatestVersion: () => "2.4.0" })
    expect(code).toBe(1)
    expect(err()).toMatch(/not a dependency/)
  })

  it("skips a workspace dependency (monorepo)", async () => {
    writePkg({ [FRAMEWORK]: "workspace:^" })
    const runInstall = vi.fn(async () => 0)
    const { ctx, out } = makeCtx(dir, [])
    const code = await upgradeCommand(ctx, { resolveLatestVersion: () => "2.4.0", runInstall })
    expect(code).toBe(0)
    expect(runInstall).not.toHaveBeenCalled()
    expect(out()).toMatch(/workspace dependency/)
  })

  it("fails when the latest version cannot be resolved", async () => {
    writePkg({ [FRAMEWORK]: "^2.3.0" })
    const { ctx, err } = makeCtx(dir, [])
    const code = await upgradeCommand(ctx, { resolveLatestVersion: () => null })
    expect(code).toBe(1)
    expect(err()).toMatch(/could not resolve/)
  })
})
