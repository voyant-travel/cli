import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { generateExtensionCommand } from "../../src/commands/generate-extension.js"

function makeCtx(argv: string[], cwd: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    ctx: {
      argv,
      cwd,
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
    stdout,
    stderr,
  }
}

describe("generateExtensionCommand", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-extension-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("scaffolds an admin extension attached to a module", async () => {
    const { ctx, stdout, stderr } = makeCtx(
      ["booking-notes", "--module", "bookings", "--dir", join(tmp, "src/extensions")],
      tmp,
    )
    const code = await generateExtensionCommand(ctx)
    expect(code).toBe(0)
    expect(stderr.join("")).toBe("")
    expect(stdout.join("")).toContain('Created extension "booking-notes" (attaches to bookings)')
    expect(stdout.join("")).toContain("Mounts under /v1/admin/bookings/*")

    const dir = join(tmp, "src/extensions", "booking-notes")
    const index = readFileSync(join(dir, "index.ts"), "utf8")
    expect(index).toContain("defineDeploymentExtension")
    expect(index).toContain('extension: { name: "booking-notes", module: "bookings" }')
    expect(index).toContain("adminRoutes: bookingNotesRoutes")

    const routes = readFileSync(join(dir, "routes.ts"), "utf8")
    expect(routes).toContain("export const bookingNotesRoutes")
    expect(routes).toContain('.get("/booking-notes"')
    expect(routes).toContain("createBookingNotesSchema")

    const validation = readFileSync(join(dir, "validation.ts"), "utf8")
    expect(validation).toContain("createBookingNotesSchema")

    // No schema by default, and never a package.json/tsconfig (not a package).
    expect(existsSync(join(dir, "schema.ts"))).toBe(false)
    expect(existsSync(join(dir, "package.json"))).toBe(false)
    expect(existsSync(join(dir, "tsconfig.json"))).toBe(false)
  })

  it("mounts on the public surface with --public", async () => {
    const { ctx, stdout } = makeCtx(
      ["loyalty", "--module", "bookings", "--public", "--dir", join(tmp, "src/extensions")],
      tmp,
    )
    expect(await generateExtensionCommand(ctx)).toBe(0)
    expect(stdout.join("")).toContain("Mounts under /v1/public/bookings/*")
    const index = readFileSync(join(tmp, "src/extensions", "loyalty", "index.ts"), "utf8")
    expect(index).toContain("publicRoutes: loyaltyRoutes")
  })

  it("emits an extension table with --with-schema", async () => {
    const { ctx } = makeCtx(
      [
        "booking-notes",
        "--module",
        "bookings",
        "--with-schema",
        "--dir",
        join(tmp, "src/extensions"),
      ],
      tmp,
    )
    expect(await generateExtensionCommand(ctx)).toBe(0)
    const schema = readFileSync(join(tmp, "src/extensions", "booking-notes", "schema.ts"), "utf8")
    expect(schema).toContain('pgTable("booking_notes"')
    expect(schema).toContain('text("bookings_id")')
    // plain text FK column, never a cross-module .references(() => ...) call
    expect(schema).not.toContain(".references(() =>")
  })

  it("normalizes the extension and module names into kebab-case", async () => {
    const { ctx } = makeCtx(
      ["BookingNotes", "--module", "Bookings", "--dir", join(tmp, "src/extensions")],
      tmp,
    )
    expect(await generateExtensionCommand(ctx)).toBe(0)
    const index = readFileSync(join(tmp, "src/extensions", "booking-notes", "index.ts"), "utf8")
    expect(index).toContain('extension: { name: "booking-notes", module: "bookings" }')
  })

  it("errors without an extension name", async () => {
    const { ctx, stderr } = makeCtx(["--module", "bookings"], tmp)
    expect(await generateExtensionCommand(ctx)).toBe(1)
    expect(stderr.join("")).toContain("Usage:")
  })

  it("errors without a target module", async () => {
    const { ctx, stderr } = makeCtx(["booking-notes"], tmp)
    expect(await generateExtensionCommand(ctx)).toBe(1)
    expect(stderr.join("")).toContain("Missing target module")
  })

  it("refuses to overwrite existing files without --force", async () => {
    const args = ["booking-notes", "--module", "bookings", "--dir", join(tmp, "src/extensions")]
    expect(await generateExtensionCommand(makeCtx(args, tmp).ctx)).toBe(0)

    const second = makeCtx(args, tmp)
    expect(await generateExtensionCommand(second.ctx)).toBe(1)
    expect(second.stderr.join("")).toContain("File already exists")
    expect(second.stderr.join("")).toContain("Pass --force")
  })

  it("overwrites when --force is given", async () => {
    const args = ["booking-notes", "--module", "bookings", "--dir", join(tmp, "src/extensions")]
    expect(await generateExtensionCommand(makeCtx(args, tmp).ctx)).toBe(0)
    expect(await generateExtensionCommand(makeCtx([...args, "--force"], tmp).ctx)).toBe(0)
  })
})
