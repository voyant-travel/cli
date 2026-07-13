import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const RUNTIME_PACKAGE = "@voyant-travel/runtime"
const TOOLING_PACKAGE = "@voyant-travel/runtime/tooling"

export interface VoyantDevelopmentHandle {
  url: string
  close(): Promise<void>
}

export interface VoyantProjectToolingModule {
  developVoyantProject?: (options: {
    projectRoot: string
    host: string
    port: number
  }) => Promise<VoyantDevelopmentHandle>
  buildVoyantProject?: (options: { projectRoot: string }) => Promise<unknown>
}

/** Resolve runtime tooling from the project rather than the CLI installation. */
export async function loadProjectTooling(projectRoot: string): Promise<VoyantProjectToolingModule> {
  const projectRequire = createRequire(resolve(projectRoot, "package.json"))
  try {
    projectRequire.resolve(RUNTIME_PACKAGE)
  } catch {
    throw new Error(
      `${RUNTIME_PACKAGE} is not installed in the current project. Add it to the project's dependencies before running app lifecycle commands.`,
    )
  }

  let toolingEntry: string
  try {
    toolingEntry = projectRequire.resolve(TOOLING_PACKAGE)
  } catch {
    throw new Error(
      `The project-installed ${RUNTIME_PACKAGE} does not provide its tooling export. Upgrade it before running app lifecycle commands.`,
    )
  }

  if (/\.[cm]?tsx?$/.test(toolingEntry)) {
    let tsxApiEntry: string
    try {
      tsxApiEntry = projectRequire.resolve("tsx/esm/api")
    } catch {
      throw new Error(
        `The linked ${TOOLING_PACKAGE} resolves to TypeScript, but tsx is not installed in the current project. Add tsx to devDependencies or use a published runtime build.`,
      )
    }
    const tsxApi = (await import(pathToFileURL(tsxApiEntry).href)) as {
      register(): (() => Promise<void>) | Promise<() => Promise<void>>
    }
    const unregister = await tsxApi.register()
    try {
      return (await import(pathToFileURL(toolingEntry).href)) as VoyantProjectToolingModule
    } finally {
      await unregister()
    }
  }

  return import(pathToFileURL(toolingEntry).href) as Promise<VoyantProjectToolingModule>
}

export function requireToolingFunction<K extends keyof VoyantProjectToolingModule>(
  tooling: VoyantProjectToolingModule,
  name: K,
  command: string,
): NonNullable<VoyantProjectToolingModule[K]> {
  const candidate = tooling[name]
  if (typeof candidate !== "function") {
    throw new Error(
      `The project-installed ${TOOLING_PACKAGE} does not export ${String(name)}(). Upgrade ${RUNTIME_PACKAGE} before running \`voyant ${command}\`.`,
    )
  }
  return candidate as NonNullable<VoyantProjectToolingModule[K]>
}
