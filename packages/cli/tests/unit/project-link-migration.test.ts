import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LinkDefinition } from "@voyant-travel/core/links"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  loadProjectLinksArtifact,
  materializeProjectLinks,
} from "../../src/lib/project-link-migration.js"

const queries: string[] = []
const connect = vi.fn(async () => {})
const end = vi.fn(async () => {})
const query = vi.fn(async (sql: string) => {
  queries.push(sql)
})
const roots: string[] = []

vi.mock("pg", () => ({
  Client: class {
    connect = connect
    end = end
    query = query
  },
}))

describe("project link migration", () => {
  afterEach(() => {
    queries.splice(0)
    connect.mockClear()
    end.mockClear()
    query.mockClear()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it("loads generated TypeScript registries that import project source with .js specifiers", async () => {
    const root = mkdtempSync(join(tmpdir(), "voyant-project-links-"))
    roots.push(root)
    mkdirSync(join(root, "src", "links"), { recursive: true })
    mkdirSync(join(root, ".voyant", "runtime"), { recursive: true })
    writeFileSync(join(root, "src", "links", "qa.ts"), `export default ${JSON.stringify(link())}\n`)
    const artifact = join(root, ".voyant", "runtime", "project-links.generated.ts")
    writeFileSync(
      artifact,
      'import qa from "../../src/links/qa.js"\nexport const projectLinks = [qa]\n',
    )

    await expect(loadProjectLinksArtifact(artifact)).resolves.toEqual([
      expect.objectContaining({ tableName: "alpha_records_zeta_record" }),
    ])
  })

  it("materializes writable links transactionally and skips read-only links", async () => {
    const report = await materializeProjectLinks(
      [link(), link({ tableName: "external_records", readOnly: { list: async () => [] } })],
      "postgres://test",
    )

    expect(report).toEqual({ discovered: 2, materialized: 1, readOnly: 1 })
    expect(connect).toHaveBeenCalledOnce()
    expect(queries[0]).toBe("BEGIN")
    expect(queries).toEqual(
      expect.arrayContaining([
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "alpha_records_zeta_record"'),
        expect.stringContaining(
          'CREATE UNIQUE INDEX IF NOT EXISTS "alpha_records_zeta_record_pair_idx"',
        ),
      ]),
    )
    expect(queries.at(-1)).toBe("COMMIT")
    expect(end).toHaveBeenCalledOnce()
  })

  it("rolls back and returns a stable error code when DDL fails", async () => {
    query
      .mockImplementationOnce(async (sql: string) => {
        queries.push(sql)
      })
      .mockImplementationOnce(async (sql: string) => {
        queries.push(sql)
        throw new Error("permission denied")
      })

    await expect(materializeProjectLinks([link()], "postgres://test")).rejects.toMatchObject({
      code: "link_sync_failed",
      message: expect.stringContaining("permission denied"),
    })
    expect(queries[0]).toBe("BEGIN")
    expect(queries[1]).toContain("CREATE TABLE")
    expect(queries[2]).toBe("ROLLBACK")
    expect(end).toHaveBeenCalledOnce()
  })

  it("returns a stable error code when the link database connection fails", async () => {
    connect.mockRejectedValueOnce(new Error("connection refused"))

    await expect(materializeProjectLinks([link()], "postgres://test")).rejects.toMatchObject({
      code: "link_sync_failed",
      message: expect.stringContaining("connection refused"),
    })
    expect(query).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })
})

function link(overrides: Partial<LinkDefinition> = {}): LinkDefinition {
  return {
    left: {
      linkable: { module: "alpha", entity: "record", table: "alpha" },
      isList: false,
    },
    right: {
      linkable: { module: "zeta", entity: "record", table: "zeta" },
      isList: true,
    },
    tableName: "alpha_records_zeta_record",
    leftColumn: "alpha_record_id",
    rightColumn: "zeta_record_id",
    cardinality: "one-to-many",
    deleteCascade: false,
    ...overrides,
  }
}
