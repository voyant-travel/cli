import { watch as watchFs } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

import { CONFIG_FILENAMES } from "./config-loader.js"

const DEFAULT_DEBOUNCE_MS = 75

const PROJECT_MANIFESTS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
])

const PROJECT_CONFIGS = new Set<string>(CONFIG_FILENAMES)

const PROJECT_CONVENTION_DIRECTORIES = [
  "src/api",
  "src/admin",
  "src/modules",
  "src/workflows",
  "src/jobs",
  "src/subscribers",
  "src/links",
] as const

export interface DevelopProjectWatchInput {
  projectRoot: string
  configPath: string
}

export interface DevelopProjectWatcher {
  close(): void
}

type WatchListener = (event: string, filename: string | Buffer | null) => void

export interface DevelopProjectWatcherDeps {
  debounceMs?: number
  watchDirectory?: (
    path: string,
    options: { recursive: boolean },
    listener: WatchListener,
  ) => DevelopProjectWatcher
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export type DevelopProjectWatcherFactory = (
  input: DevelopProjectWatchInput,
  onChange: () => Promise<void>,
) => DevelopProjectWatcher

/** Watch artifact inputs while leaving the runtime development server untouched. */
export function watchDevelopProjectInputs(
  input: DevelopProjectWatchInput,
  onChange: () => Promise<void>,
  deps: DevelopProjectWatcherDeps = {},
): DevelopProjectWatcher {
  const watchDirectory =
    deps.watchDirectory ??
    ((path, options, listener) => watchFs(path, options, listener) as DevelopProjectWatcher)
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const configRelativePath = projectRelativePath(input.projectRoot, input.configPath)
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const scheduleRefresh = (): void => {
    if (closed) return
    if (timer !== undefined) clearTimer(timer)
    timer = setTimer(() => {
      timer = undefined
      if (!closed) void onChange()
    }, debounceMs)
  }

  const watcher = watchDirectory(input.projectRoot, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const path = filename.toString().replaceAll("\\", "/").replace(/^\.\//, "")
    if (isWatchedProjectPath(path, configRelativePath)) scheduleRefresh()
  })

  return {
    close: () => {
      if (closed) return
      closed = true
      if (timer !== undefined) clearTimer(timer)
      watcher.close()
    },
  }
}

function isWatchedProjectPath(path: string, configRelativePath: string | undefined): boolean {
  if (path === configRelativePath || PROJECT_CONFIGS.has(path) || PROJECT_MANIFESTS.has(path)) {
    return true
  }
  return PROJECT_CONVENTION_DIRECTORIES.some(
    (directory) => path === directory || path.startsWith(`${directory}/`),
  )
}

function projectRelativePath(projectRoot: string, path: string): string | undefined {
  const absolutePath = isAbsolute(path) ? path : resolve(projectRoot, path)
  const relativePath = relative(projectRoot, absolutePath).replaceAll("\\", "/")
  if (relativePath.startsWith("../") || isAbsolute(relativePath)) return undefined
  return relativePath
}
