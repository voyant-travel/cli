export type ShutdownSignal = "SIGINT" | "SIGTERM"

export interface ShutdownSignalTarget {
  once(signal: ShutdownSignal, listener: () => void): unknown
  removeListener(signal: ShutdownSignal, listener: () => void): unknown
}

export interface WaitForShutdownOptions {
  signals?: readonly ShutdownSignal[]
  target?: ShutdownSignalTarget
}

export async function waitForShutdownSignal(
  cleanup: () => Promise<void>,
  opts: WaitForShutdownOptions = {},
): Promise<void> {
  const target = opts.target ?? process
  const signals = opts.signals ?? (["SIGINT", "SIGTERM"] as const)

  await new Promise<void>((resolve, reject) => {
    let shuttingDown = false
    const listeners = new Map<ShutdownSignal, () => void>()

    const removeListeners = (): void => {
      for (const [signal, listener] of listeners) {
        target.removeListener(signal, listener)
      }
    }

    const onSignal = (): void => {
      if (shuttingDown) return
      shuttingDown = true
      removeListeners()
      cleanup().then(resolve, reject)
    }

    for (const signal of signals) {
      const listener = (): void => onSignal()
      listeners.set(signal, listener)
      target.once(signal, listener)
    }
  })
}
