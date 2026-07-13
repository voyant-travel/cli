import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { parse } from "dotenv"

import { resolveConfigPath } from "./config-loader.js"

/** Load a project's .env without replacing values supplied by the platform. */
export async function loadProjectEnv(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  let source: string
  try {
    source = await readFile(join(projectRoot, ".env"), "utf8")
  } catch (error) {
    if (hasCode(error, "ENOENT")) return
    throw error
  }

  for (const [key, value] of Object.entries(parseProjectEnv(source))) {
    if (env[key] === undefined) env[key] = value
  }
}

export function resolveProjectEnvRoot(cwd: string, configPath?: string): string {
  const resolvedConfig = resolveConfigPath({ cwd, path: configPath })
  return resolvedConfig ? dirname(resolvedConfig) : cwd
}

export function parseProjectEnv(source: string): Record<string, string> {
  return parse(source)
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    error !== undefined &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  )
}
