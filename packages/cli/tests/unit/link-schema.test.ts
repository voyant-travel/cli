import type { LinkDefinition } from "@voyant-travel/core/links"
import { describe, expect, it } from "vitest"

import { renderLinkDrizzleSchema } from "../../src/lib/link-schema.js"

function link(
  tableName: string,
  leftColumn: string,
  rightColumn: string,
  leftIsList: boolean,
  rightIsList: boolean,
  readOnly = false,
): LinkDefinition {
  return {
    tableName,
    leftColumn,
    rightColumn,
    left: { linkable: { module: "a", entity: "x" }, isList: leftIsList },
    right: { linkable: { module: "b", entity: "y" }, isList: rightIsList },
    cardinality: "one-to-many",
    deleteCascade: false,
    ...(readOnly ? { readOnly: { list: () => [] } } : {}),
  } as unknown as LinkDefinition
}

describe("renderLinkDrizzleSchema", () => {
  it("emits a pgTable with the canonical link columns", () => {
    const out = renderLinkDrizzleSchema([
      link("crm_person_products_product", "crm_person_id", "products_product_id", false, true),
    ])
    expect(out).toContain(
      'import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"',
    )
    expect(out).toContain("export const crm_person_products_product = pgTable(")
    expect(out).toContain('"crm_person_id": text("crm_person_id").notNull()')
    expect(out).toContain('"products_product_id": text("products_product_id").notNull()')
    expect(out).toContain('id: text("id").primaryKey().notNull()')
    expect(out).toContain('deleted_at: timestamp("deleted_at", { withTimezone: true })')
  })

  it("derives index uniqueness from cardinality (one-to-many: l_idx + r_uniq)", () => {
    // left single, right list → left non-unique (l_idx), right unique (r_uniq).
    const out = renderLinkDrizzleSchema([link("t", "a_id", "b_id", false, true)])
    expect(out).toContain('uniqueIndex("t_pair_idx").on(t["a_id"], t["b_id"])')
    expect(out).toContain('index("t_l_idx").on(t["a_id"])')
    expect(out).toContain('uniqueIndex("t_r_uniq").on(t["b_id"])')
  })

  it("emits non-unique indexes on both sides for many-to-many", () => {
    const out = renderLinkDrizzleSchema([link("m2m", "a_id", "b_id", true, true)])
    expect(out).toContain('index("m2m_l_idx").on(t["a_id"])')
    expect(out).toContain('index("m2m_r_idx").on(t["b_id"])')
    expect(out).not.toContain("_l_uniq")
    expect(out).not.toContain("_r_uniq")
  })

  it("emits unique indexes on both sides for one-to-one", () => {
    const out = renderLinkDrizzleSchema([link("o2o", "a_id", "b_id", false, false)])
    expect(out).toContain('uniqueIndex("o2o_l_uniq").on(t["a_id"])')
    expect(out).toContain('uniqueIndex("o2o_r_uniq").on(t["b_id"])')
  })

  it("skips read-only (externally-owned) links", () => {
    const out = renderLinkDrizzleSchema([
      link("kept", "a_id", "b_id", false, true),
      link("external", "c_id", "d_id", false, true, true),
    ])
    expect(out).toContain("kept")
    expect(out).not.toContain("external")
  })

  it("handles an empty / all-read-only link set", () => {
    const out = renderLinkDrizzleSchema([])
    expect(out).toContain("No materialized link tables")
  })
})
