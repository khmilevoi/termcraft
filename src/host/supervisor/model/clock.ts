/** A cancellable scheduled callback (host-supervision §9). */
export interface TimerHandle {
  cancel(): void
}

/**
 * The single injected time seam for every §9 deadline. `now()` is monotonic ms;
 * `setTimer` schedules a one-shot callback. Owned by supervisor code with an
 * explicit `cancel()` on every exit path — never a Reatom connect hook.
 */
export interface Clock {
  now(): number
  setTimer(delayMs: number, callback: () => void): TimerHandle
}

/** Production clock: monotonic `Bun.nanoseconds` + real `setTimeout`. */
export function createSystemClock(): Clock {
  return {
    now: () => Math.trunc(Bun.nanoseconds() / 1e6),
    setTimer: (delayMs, callback) => {
      const id = setTimeout(callback, delayMs)
      return { cancel: () => clearTimeout(id) }
    },
  }
}

/** A deterministic clock for tests: virtual time advanced explicitly. */
export interface ManualClock extends Clock {
  advance(ms: number): void
  pending(): number
}

/**
 * Fires due callbacks exactly once, at their exact virtual deadline, in due
 * order — including timers scheduled during an `advance` (backoff chains). No
 * real waits (proven in Spike 04 D4).
 */
export function createManualClock(): ManualClock {
  let current = 0
  let seq = 0
  const timers = new Map<number, { at: number; order: number; cb: () => void }>()
  return {
    now: () => current,
    setTimer(delayMs, callback) {
      const id = seq
      seq += 1
      timers.set(id, { at: current + delayMs, order: id, cb: callback })
      return { cancel: () => void timers.delete(id) }
    },
    pending: () => timers.size,
    advance(ms) {
      const target = current + ms
      while (true) {
        let pick: { id: number; at: number; order: number } | null = null
        for (const [id, t] of timers) {
          if (t.at > target) continue
          if (pick === null || t.at < pick.at || (t.at === pick.at && t.order < pick.order)) {
            pick = { id, at: t.at, order: t.order }
          }
        }
        if (pick === null) break
        const timer = timers.get(pick.id)
        if (timer === undefined) break
        timers.delete(pick.id)
        current = timer.at
        timer.cb()
      }
      current = target
    },
  }
}
