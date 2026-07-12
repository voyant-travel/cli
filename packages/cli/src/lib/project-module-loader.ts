import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { createJiti } from "jiti"

/** Load project-owned modules without assuming they have already been compiled to JavaScript. */
export async function loadProjectModule<T>(modulePath: string): Promise<T> {
  const loader = createProjectModuleLoader(modulePath)
  return loader.import(modulePath) as Promise<T>
}

/** Evaluate current project source so repeated resolutions observe config edits. */
export async function loadProjectSourceModule<T>(modulePath: string): Promise<T> {
  const loader = createProjectModuleLoader(modulePath)
  const source = await readFile(modulePath, "utf8")
  return loader.evalModule(source, {
    async: true,
    ext: ".ts",
    filename: modulePath,
  }) as Promise<T>
}

/** Load config natively when possible, then fall back to source transformation. */
export async function loadProjectConfigModule<T>(modulePath: string): Promise<T> {
  const source = await readFile(modulePath, "utf8")
  const cacheKey = createHash("sha256").update(source).digest("hex")
  try {
    return (await import(`${pathToFileURL(modulePath).href}?voyant_config=${cacheKey}`)) as T
  } catch {
    return loadProjectSourceModule<T>(modulePath)
  }
}

function createProjectModuleLoader(modulePath: string) {
  return createJiti(modulePath, {
    interopDefault: false,
    moduleCache: false,
  })
}
