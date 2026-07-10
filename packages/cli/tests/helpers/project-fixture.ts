import { cpSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const MOCK_FRAMEWORK = fileURLToPath(new URL("../fixtures/mock-framework", import.meta.url))

export function writeProjectFixture(
  root: string,
  options: { modules?: readonly string[]; plugins?: readonly string[] } = {},
): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-project", private: true, type: "module" }, null, 2)}\n`,
  )
  const frameworkRoot = join(root, "node_modules", "@voyant-travel", "framework")
  mkdirSync(frameworkRoot, { recursive: true })
  cpSync(MOCK_FRAMEWORK, frameworkRoot, { recursive: true })
  writeProjectConfig(root, options)
}

export function writeProjectConfig(
  root: string,
  options: { modules?: readonly string[]; plugins?: readonly string[] } = {},
): void {
  writeFileSync(
    join(root, "voyant.config.mjs"),
    `import { defineProject } from "@voyant-travel/framework/project"

export default defineProject(${JSON.stringify(
      {
        schemaVersion: "voyant.project.v1",
        modules: options.modules ?? ["@acme/bookings"],
        plugins: options.plugins ?? [],
      },
      null,
      2,
    )})
`,
  )
}
