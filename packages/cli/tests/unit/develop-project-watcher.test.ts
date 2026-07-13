import { describe, expect, it, vi } from "vitest"

import { watchDevelopProjectInputs } from "../../src/lib/develop-project-watcher.js"

describe("develop project watcher", () => {
  it("filters project inputs, debounces refreshes, and cancels pending work on close", () => {
    vi.useFakeTimers()
    try {
      let listener: ((event: string, filename: string | Buffer | null) => void) | undefined
      const close = vi.fn()
      const onChange = vi.fn(async () => {})
      const watcher = watchDevelopProjectInputs(
        {
          projectRoot: "/project",
          configPath: "/project/voyant.config.ts",
        },
        onChange,
        {
          watchDirectory: (path, options, nextListener) => {
            expect(path).toBe("/project")
            expect(options).toEqual({ recursive: true })
            listener = nextListener
            return { close }
          },
        },
      )

      listener?.("change", ".voyant/deployment-artifacts.generated.json")
      vi.advanceTimersByTime(100)
      expect(onChange).not.toHaveBeenCalled()

      listener?.("change", "voyant.config.mts")
      listener?.("rename", "package.json")
      listener?.("change", "src/api/public/routes.ts")
      listener?.("change", "src/admin/extensions.tsx")
      listener?.("change", "src/workflows/confirm-booking.ts")
      listener?.("change", "src/jobs/send-reminders.ts")
      listener?.("change", "src/subscribers/audit-events.ts")
      listener?.("change", "src/links/booking-customer.ts")
      vi.advanceTimersByTime(74)
      expect(onChange).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onChange).toHaveBeenCalledOnce()

      listener?.("change", "src/modules/bookings/index.ts")
      watcher.close()
      vi.advanceTimersByTime(100)
      expect(onChange).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
