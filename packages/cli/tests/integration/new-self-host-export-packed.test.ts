import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const runPackedAcceptance = process.env.VOYANT_PACKED_SELF_HOST_ACCEPTANCE === "1" ? it : it.skip
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

describe("packed CLI self-host contract", () => {
  let tmp: string | undefined

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  runPackedAcceptance(
    "loads the published framework contract from an isolated package install",
    () => {
      tmp = mkdtempSync(join(tmpdir(), "voyant-cli-packed-self-host-"))
      const packRoot = join(tmp, "pack")
      const consumerRoot = join(tmp, "consumer")
      mkdirSync(packRoot)
      mkdirSync(consumerRoot)

      const packed = spawnSync("pnpm", ["pack", "--pack-destination", packRoot], {
        cwd: packageRoot,
        encoding: "utf8",
      })
      expect(packed.status, packed.stderr).toBe(0)
      const tarball = readdirSync(packRoot).find((entry) => entry.endsWith(".tgz"))
      expect(tarball).toBeDefined()

      writeFileSync(
        join(consumerRoot, "package.json"),
        `${JSON.stringify({ name: "packed-self-host-acceptance", private: true })}\n`,
      )
      const installed = spawnSync(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(packRoot, tarball!)],
        { cwd: consumerRoot, encoding: "utf8" },
      )
      expect(installed.status, installed.stderr).toBe(0)

      const bundlePath = join(consumerRoot, "invalid-export.json")
      writeFileSync(bundlePath, "{}\n")
      const invoked = spawnSync(
        process.execPath,
        [
          join(consumerRoot, "node_modules", "@voyant-travel", "cli", "bin", "voyant.mjs"),
          "new",
          "generated",
          "--from-export",
          bundlePath,
        ],
        { cwd: consumerRoot, encoding: "utf8" },
      )

      expect(invoked.status).toBe(1)
      expect(invoked.stderr).toContain(
        "Cannot generate a project from an invalid Voyant self-host export bundle",
      )
      expect(invoked.stderr).toContain("VOYANT_EXPORT_INVALID_SCHEMA_VERSION")
      expect(invoked.stderr).not.toContain(
        "Could not load @voyant-travel/framework/self-host-export",
      )
      expect(readFileSync(join(consumerRoot, "package.json"), "utf8")).toContain(
        "@voyant-travel/cli",
      )
    },
    180_000,
  )
})
