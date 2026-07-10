import { readFileSync } from "node:fs"

import { renderProjectConfig } from "../lib/project-config.js"
import { VOYANT_FRAMEWORK_VERSION } from "../lib/voyant-version.js"

export const DEFAULT_PROJECT_PRESET = "operator-standard"

const OPERATOR_STANDARD_MODULES = [
  "@voyant-travel/action-ledger",
  "@voyant-travel/relationships",
  "@voyant-travel/quotes",
  "@voyant-travel/operations",
  "@voyant-travel/identity",
  "@voyant-travel/distribution",
  "@voyant-travel/inventory/extras",
  "@voyant-travel/bookings/requirements",
  "@voyant-travel/commerce",
  "@voyant-travel/inventory",
  "@voyant-travel/catalog",
  "@voyant-travel/accommodations",
  "@voyant-travel/bookings",
  "@voyant-travel/finance",
  "@voyant-travel/legal",
  "@voyant-travel/public-document-delivery",
  "@voyant-travel/notifications",
  "@voyant-travel/trips",
  "@voyant-travel/flights",
  "@voyant-travel/operator-settings",
] as const

const OPERATOR_STANDARD_PLUGINS = [
  "@voyant-travel/bookings/booking-supplier-extension",
  "@voyant-travel/finance/bookings-create-extension",
  "@voyant-travel/inventory/booking-extension",
  "@voyant-travel/inventory/authoring/extension",
  "@voyant-travel/quotes/booking-extension",
  "@voyant-travel/distribution#extension",
  "@voyant-travel/distribution/channel-push-extension",
  "@voyant-travel/finance/booking-tax-extension",
] as const

export function operatorStandardProjectFiles(name: string): Array<[string, string]> {
  return [
    ["package.json", projectPackageJson(name)],
    ["voyant.config.ts", operatorStandardConfig()],
    ["tsconfig.json", projectTsconfig()],
    [".gitignore", projectGitignore()],
    ["src/modules/.gitkeep", ""],
    ["src/plugins/.gitkeep", ""],
    ["src/links/.gitkeep", ""],
    ["src/scripts/.gitkeep", ""],
  ]
}

function operatorStandardConfig(): string {
  return renderProjectConfig({
    schemaVersion: "voyant.project.v1",
    presetLineage: DEFAULT_PROJECT_PRESET,
    modules: [...OPERATOR_STANDARD_MODULES],
    plugins: [...OPERATOR_STANDARD_PLUGINS],
  })
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
