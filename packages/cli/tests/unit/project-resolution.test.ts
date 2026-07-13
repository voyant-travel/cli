import { describe, expect, it } from "vitest"

import { parseMigrationPlan } from "../../src/lib/project-resolution.js"

const CONTENT_HASH = `sha256:${"a".repeat(64)}`

describe("parseMigrationPlan", () => {
  it("accepts deployment-local schema migrations without a package name", () => {
    expect(
      parseMigrationPlan(
        {
          schemaVersion: "voyant.migration-plan.v1",
          contentHash: CONTENT_HASH,
          migrations: [
            {
              id: "deployment",
              migrationKind: "schema",
              order: 0,
              idempotencyKey: "schema:deployment",
              owner: "deployment",
              source: { kind: "deployment", path: "./migrations" },
            },
          ],
        },
        CONTENT_HASH,
      ).migrations,
    ).toEqual([
      {
        id: "deployment",
        migrationKind: "schema",
        order: 0,
        idempotencyKey: "schema:deployment",
        owner: "deployment",
        source: { kind: "deployment", path: "./migrations" },
      },
    ])
  })

  it("still requires package ownership for package schema migrations", () => {
    expect(() =>
      parseMigrationPlan(
        {
          schemaVersion: "voyant.migration-plan.v1",
          contentHash: CONTENT_HASH,
          migrations: [
            {
              id: "bookings",
              migrationKind: "schema",
              order: 0,
              idempotencyKey: "schema:bookings",
              owner: "@voyant-travel/bookings",
              source: {
                kind: "package",
                packageName: "@voyant-travel/bookings",
                path: "./migrations",
              },
            },
          ],
        },
        CONTENT_HASH,
      ),
    ).toThrow("artifacts.migrationPlan.migrations[0].packageName must be a non-empty string")
  })

  it("requires deployment-local schema migrations to declare a path", () => {
    expect(() =>
      parseMigrationPlan(
        {
          schemaVersion: "voyant.migration-plan.v1",
          contentHash: CONTENT_HASH,
          migrations: [
            {
              id: "deployment",
              migrationKind: "schema",
              order: 0,
              idempotencyKey: "schema:deployment",
              owner: "deployment",
              source: { kind: "deployment" },
            },
          ],
        },
        CONTENT_HASH,
      ),
    ).toThrow("artifacts.migrationPlan.migrations[0].source.path must be a non-empty string")
  })
})
