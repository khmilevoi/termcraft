// D4 — fake-clock timeouts under bun:test.
// Proves the injected-clock design for the §9 timeouts: a `now()` + a schedulable
// timer seam driven by a virtual clock, so the 3s/10s/2s/5s/1s deadlines are
// tested deterministically WITHOUT real waits. A scripted advance must fire a due
// callback exactly once; cancellation must prevent it; timers scheduled during an
// advance (backoff chains) must fire in due order.
import { describe, expect, test } from "bun:test"

interface Cancel {
  cancel(): void
}
interface Clock {
  now(): number
  setTimer(delayMs: number, cb: () => void): Cancel
}
interface FakeClock extends Clock {
  advance(ms: number): void
  pending(): number
}

function createFakeClock(): FakeClock {
  let current = 0
  let seq = 0
  const timers = new Map<number, { at: number; order: number; cb: () => void }>()
  return {
    now: () => current,
    setTimer(delayMs, cb) {
      const id = seq
      seq += 1
      timers.set(id, { at: current + delayMs, order: id, cb })
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
        const t = timers.get(pick.id)!
        timers.delete(pick.id)
        current = t.at // virtual time is exactly the timer's deadline when it fires
        t.cb()
      }
      current = target
    },
  }
}

describe("D4 fake clock seam", () => {
  test("a due timer fires exactly once at its deadline", () => {
    const clock = createFakeClock()
    let fired = 0
    let firedAt = -1
    clock.setTimer(3_000, () => {
      fired += 1
      firedAt = clock.now()
    })
    clock.advance(2_999)
    expect(fired).toBe(0) // not yet due
    clock.advance(1)
    expect(fired).toBe(1)
    expect(firedAt).toBe(3_000)
    clock.advance(10_000)
    expect(fired).toBe(1) // never fires twice
  })

  test("cancel before the deadline prevents the fire", () => {
    const clock = createFakeClock()
    let fired = 0
    const handle = clock.setTimer(2_000, () => (fired += 1))
    clock.advance(1_000)
    handle.cancel()
    clock.advance(5_000)
    expect(fired).toBe(0)
    expect(clock.pending()).toBe(0)
  })

  test("timers scheduled during advance fire in due order (backoff chain)", () => {
    const clock = createFakeClock()
    const order: number[] = []
    // deterministic base-2 backoff 250/500/1000 ms, each scheduled by the prior.
    clock.setTimer(250, () => {
      order.push(clock.now())
      clock.setTimer(500, () => {
        order.push(clock.now())
        clock.setTimer(1_000, () => order.push(clock.now()))
      })
    })
    clock.advance(2_000)
    expect(order).toEqual([250, 750, 1_750])
    expect(clock.pending()).toBe(0)
  })

  test("independent deadlines: request 2s vs heartbeat 5s resolve in order", () => {
    const clock = createFakeClock()
    const events: string[] = []
    clock.setTimer(5_000, () => events.push("heartbeat-timeout"))
    const req = clock.setTimer(2_000, () => events.push("request-timeout"))
    clock.advance(1_500)
    expect(events).toEqual([])
    // simulate a response arriving before the request deadline: cancel it
    req.cancel()
    clock.advance(3_600) // now at 5_100
    expect(events).toEqual(["heartbeat-timeout"])
  })
})
