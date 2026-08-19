import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  parseThemeProjectLink,
  readThemeProjectLink,
  removeThemeProjectLink,
  resolveThemeProject,
  resolveThemeTargetSelectors,
  THEME_PROJECT_LINK_SCHEMA_VERSION,
  type ThemeProjectLink,
  ThemeProjectLinkError,
  writeThemeProjectLink,
} from "../../src/lib/theme-project-link.js"

describe("Theme Project Link", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voyant-theme-project-link-"))
    writeFileSync(join(root, "theme.config.ts"), "export default {}\n")
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("finds the nearest project from a nested working directory", async () => {
    const nested = join(root, "src", "pages")
    mkdirSync(nested, { recursive: true })

    const project = await resolveThemeProject({ cwd: nested })

    expect(project.projectRoot).toBe(root)
    expect(project.configPath).toBe(join(root, "theme.config.ts"))
    expect(project.linkPath).toBe(join(root, ".voyant", "theme-project-link.json"))
  })

  it("fails deterministically when no theme config exists", async () => {
    rmSync(join(root, "theme.config.ts"))
    await expect(resolveThemeProject({ cwd: root })).rejects.toMatchObject({
      code: "theme_project_not_found",
    })
  })

  it("atomically writes, reads, and removes only versioned non-secret fields", async () => {
    const project = await resolveThemeProject({ cwd: root })
    const link = validLink()

    await expect(writeThemeProjectLink(project, link)).resolves.toEqual(link)
    await expect(readThemeProjectLink(project)).resolves.toEqual(link)
    expect(JSON.parse(readFileSync(project.linkPath, "utf8"))).toEqual(link)
    expect(statSync(project.linkPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(project.linkPath, "utf8")).not.toContain("token")
    expect(await removeThemeProjectLink(project)).toBe(true)
    expect(await removeThemeProjectLink(project)).toBe(false)
    await expect(readThemeProjectLink(project)).resolves.toBeNull()
  })

  it("persists a normalized sandbox API base path", async () => {
    const project = await resolveThemeProject({ cwd: root })
    const input = {
      ...validLink(),
      apiUrl: "https://sandbox.onvoyant.com/__voyant/themes-sandbox-api///",
    }
    const expected = {
      ...input,
      apiUrl: "https://sandbox.onvoyant.com/__voyant/themes-sandbox-api",
    }

    await expect(writeThemeProjectLink(project, input)).resolves.toEqual(expected)
    await expect(readThemeProjectLink(project)).resolves.toEqual(expected)
    expect(JSON.parse(readFileSync(project.linkPath, "utf8"))).toEqual(expected)
  })

  it("rejects unknown fields so credentials cannot be persisted accidentally", () => {
    expect(() => parseThemeProjectLink({ ...validLink(), token: "secret" })).toThrowError(
      ThemeProjectLinkError,
    )
    try {
      parseThemeProjectLink({ ...validLink(), token: "secret" })
    } catch (error) {
      expect(error).toMatchObject({ code: "theme_project_link_invalid" })
    }
  })

  it("rejects API URLs that could persist credentials or request metadata", () => {
    for (const apiUrl of [
      "https://token@example.com",
      "https://@example.com",
      "https://example.com?token=secret",
      "https://example.com/path?",
      "https://example.com/path#fragment",
      "ftp://example.com",
    ]) {
      expect(() => parseThemeProjectLink({ ...validLink(), apiUrl })).toThrow(
        /credential-free HTTP\(S\) base URL without query or fragment/,
      )
    }
  })

  it("rejects malformed JSON and inconsistent installation state", async () => {
    const project = await resolveThemeProject({ cwd: root })
    mkdirSync(dirname(project.linkPath), { recursive: true })
    writeFileSync(project.linkPath, "{")
    await expect(readThemeProjectLink(project)).rejects.toMatchObject({
      code: "theme_project_link_invalid",
    })

    expect(() =>
      parseThemeProjectLink({
        ...validLink(),
        siteId: undefined,
        installationId: "thi_123",
      }),
    ).toThrow(/installationId requires siteId/)
  })

  it("refuses to write through a symlinked .voyant directory", async () => {
    const project = await resolveThemeProject({ cwd: root })
    const outside = mkdtempSync(join(tmpdir(), "voyant-theme-link-outside-"))
    symlinkSync(outside, join(root, ".voyant"), "dir")
    try {
      await expect(writeThemeProjectLink(project, validLink())).rejects.toMatchObject({
        code: "theme_project_path_unsafe",
      })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("resolves explicit selectors over local defaults and reports their source", () => {
    expect(
      resolveThemeTargetSelectors(
        { theme: "thm_explicit", site: "site_explicit", apiUrl: "https://sandbox.test" },
        validLink(),
      ),
    ).toEqual({
      theme: "thm_explicit",
      site: "site_explicit",
      installation: "thi_linked",
      apiUrl: "https://sandbox.test",
      organization: "org_linked",
      sources: {
        theme: "explicit",
        site: "explicit",
        installation: "link",
        apiUrl: "explicit",
        organization: "link",
      },
    })
  })
})

function validLink(): ThemeProjectLink {
  return {
    schemaVersion: THEME_PROJECT_LINK_SCHEMA_VERSION,
    apiUrl: "https://api.voyant.travel",
    organizationId: "org_linked",
    themeId: "thm_linked",
    siteId: "site_linked",
    installationId: "thi_linked",
  }
}
