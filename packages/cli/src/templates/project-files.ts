import { readFileSync } from "node:fs"

import { VOYANT_FRAMEWORK_VERSION } from "../lib/voyant-version.js"

export const DEFAULT_PROJECT_PRESET = "operator-standard"

export const UNAVAILABLE_PROJECT_PRESETS = {
  "pms-standard": {
    code: "VOYANT_PRESET_UNAVAILABLE",
    reason: "No first-party PMS/property-operations package set is published.",
  },
} as const

export function cleanProjectFiles(name: string): Array<[string, string]> {
  return [
    ["package.json", projectPackageJson(name)],
    ["voyant.config.ts", projectConfig()],
    ["tsconfig.json", projectTsconfig()],
    [".gitignore", projectGitignore()],
    ["src/api/admin/.gitkeep", ""],
    ["src/api/store/.gitkeep", ""],
    ["src/admin/.gitkeep", ""],
    ["src/workflows/.gitkeep", ""],
    ["src/jobs/.gitkeep", ""],
    ["src/subscribers/.gitkeep", ""],
    ["src/modules/.gitkeep", ""],
    ["src/links/.gitkeep", ""],
  ]
}

function projectConfig(): string {
  return `import { defineConfig } from "@voyant-travel/framework"

export default defineConfig({})
`
}

function projectPackageJson(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.0.1",
      private: true,
      type: "module",
      scripts: {
        dev: "voyant dev",
        doctor: "voyant doctor",
      },
      dependencies: {
        "@voyant-travel/framework": `^${VOYANT_FRAMEWORK_VERSION}`,
      },
      devDependencies: {
        "@voyant-travel/cli": `^${readCliPackageVersion()}`,
        typescript: "^5.9.2",
      },
      packageManager: "pnpm@9.0.0",
    },
    null,
    2,
  )}\n`
}

function readCliPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown }
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Could not read the @voyant-travel/cli package version")
  }
  return packageJson.version
}

function projectTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src/**/*.ts", "voyant.config.ts"],
    },
    null,
    2,
  )}\n`
}

function projectGitignore(): string {
  return `node_modules/
.env
.env.*
!.env.example
.voyant/
dist/
coverage/
`
}
