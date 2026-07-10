import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  type DeploymentArtifactError,
  readDeploymentGraphArtifact,
} from "../../src/lib/deployment-artifact-reader.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("deployment artifact discovery", () => {
  it("does not discover root artifacts for a config-driven project", () => {
    const root = fixtureRoot()
    writeFileSync(join(root, "voyant.config.mjs"), "export default {}\n")
    writeArtifactSet(root)

    expect(() => readDeploymentGraphArtifact({ cwd: root })).toThrowError(
      expect.objectContaining<Partial<DeploymentArtifactError>>({ code: "artifact_missing" }),
    )
  })

  it("preserves root artifact discovery for a source-free handoff", () => {
    const root = fixtureRoot()
    const contentHash = writeArtifactSet(root)

    expect(readDeploymentGraphArtifact({ cwd: root }).contentHash).toBe(contentHash)
  })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "voyant-artifact-reader-"))
  roots.push(root)
  return root
}

function writeArtifactSet(root: string): string {
  mkdirSync(root, { recursive: true })
  const graphWithoutHash = {
    schemaVersion: "voyant.resolved-graph.v1",
    project: {},
    deployment: {},
    requirements: {},
    modules: [],
    plugins: [],
    packageRecords: [],
    diagnostics: [],
  }
  const contentHash = `sha256:${createHash("sha256")
    .update(canonicalJson(graphWithoutHash))
    .digest("hex")}`
  writeJson(join(root, "deployment-graph.generated.json"), {
    ...graphWithoutHash,
    contentHash,
  })
  writeFileSync(join(root, "runtime.mjs"), "export default {}\n")
  writeJson(join(root, "deployment-artifacts.generated.json"), {
    schemaVersion: "voyant.deployment-artifacts.v1",
    graphHash: contentHash,
    graph: "deployment-graph.generated.json",
    runtimeEntries: [
      {
        id: "project",
        target: "node",
        kind: "application",
        file: "runtime.mjs",
        graphHash: contentHash,
      },
    ],
  })
  return contentHash
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`
}
