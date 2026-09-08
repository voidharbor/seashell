/**
 * The one thing quit waits on before it starts reaping. [pure]
 *
 * Only the renderer knows the current layout, so main cannot write the
 * last-session file itself; it has to ask and then wait. This is that wait,
 * with the asking left to the caller so the whole timing story is testable
 * without a window.
 *
 * A single slot, deliberately: there is one window and one quit, and a queue
 * of pending snapshot requests would only ever describe a bug.
 */

export interface SnapshotGate {
  /**
   * Asks, then resolves when `answer` is called or when `timeoutMs` passes,
   * whichever comes first. The timeout is the load-bearing half: a renderer
   * that is wedged, crashed or mid-reload must never make the app unquittable.
   * A `send` that throws means there was nobody to ask, and resolves at once.
   */
  request(send: () => void, timeoutMs: number): Promise<void>
  /** The renderer answered. A stale answer, after a timeout, does nothing. */
  answer(): void
}

export function createSnapshotGate(): SnapshotGate {
  let pending: (() => void) | null = null

  return {
    request(send, timeoutMs) {
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          if (pending === finish) pending = null
          if (timer) clearTimeout(timer)
          resolve()
        }

        pending = finish
        timer = setTimeout(finish, timeoutMs)

        try {
          send()
        } catch {
          finish()
        }
      })
    },
    answer() {
      pending?.()
    },
  }
}
