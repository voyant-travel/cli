import { cpSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const MOCK_FRAMEWORK = fileURLToPath(new URL("../fixtures/mock-framework", import.meta.url))

export function writeProjectFixture(
  root: string,
  options: {
    modules?: readonly string[]
    plugins?: readonly string[]
    frameworkSource?: "javascript" | "typescript"
    meta?: Record<string, unknown>
  } = {},
): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-project", private: true, type: "module" }, null, 2)}\n`,
  )
  const frameworkRoot = join(root, "node_modules", "@voyant-travel", "framework")
  mkdirSync(frameworkRoot, { recursive: true })
  cpSync(MOCK_FRAMEWORK, frameworkRoot, { recursive: true })
  if (options.frameworkSource === "typescript") {
    writeTypeScriptFrameworkExports(frameworkRoot)
  }
  writeProjectConfig(root, options)
}

function writeTypeScriptFrameworkExports(frameworkRoot: string): void {
  writeFileSync(
    join(frameworkRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@voyant-travel/framework",
        version: "0.0.0-workspace-test",
        type: "module",
        exports: { ".": "./src/project.ts", "./project": "./src/project.ts" },
      },
      null,
      2,
    )}\n`,
  )
  mkdirSync(join(frameworkRoot, "src"), { recursive: true })
  writeFileSync(join(frameworkRoot, "src", "project.ts"), `export * from "./project-api.js"\n`)
  writeFileSync(join(frameworkRoot, "src", "project-api.ts"), `export * from "../project.mjs"\n`)
}

export function writeProjectConfig(
  root: string,
  options: {
    modules?: readonly string[]
    plugins?: readonly string[]
    meta?: Record<string, unknown>
  } = {},
): void {
  writeFileSync(
    join(root, "voyant.config.mjs"),
    `import { defineProject } from "@voyant-travel/framework/project"

export default defineProject(${JSON.stringify(
      {
        schemaVersion: "voyant.project.v1",
        modules: options.modules ?? ["@acme/bookings"],
        plugins: options.plugins ?? [],
        ...(options.meta ? { meta: options.meta } : {}),
      },
      null,
      2,
    )})
`,
  )
}
