import { describe, expect, test } from "bun:test"
import type { PreviewFrame } from "../../types"
import { createPreviewRelay } from "./preview-relay"

function makeFrame(overrides: Partial<PreviewFrame> = {}): PreviewFrame {
  return {
    sessionId: "s-1",
    sourceHash: "b".repeat(64),
    frameSeq: "1",
    width: 80,
    height: 24,
    rows: Array.from({ length: 24 }, () => []),
    ...overrides,
  }
}

describe("createPreviewRelay", () => {
  test("publish then consume yields that exact PreviewFrame value verbatim", async () => {
    const relay = createPreviewRelay()
    const frame = makeFrame({ frameSeq: "7" })
    relay.publish(frame)
    const iterator = relay.frames[Symbol.asyncIterator]()
    const { value, done } = await iterator.next()
    expect(done).toBe(false)
    expect(value).toBe(frame) // no guard, no rebuild — the already-built value is held as-is
  })

  test("capacity-1 latest-wins: publishing A, B, C before consumption yields only C", async () => {
    const relay = createPreviewRelay()
    const a = makeFrame({ frameSeq: "1" })
    const b = makeFrame({ frameSeq: "2" })
    const c = makeFrame({ frameSeq: "3" })
    relay.publish(a)
    relay.publish(b)
    relay.publish(c)
    const iterator = relay.frames[Symbol.asyncIterator]()
    const { value } = await iterator.next()
    expect(value).toBe(c) // only the newest survives the single slot
  })

  test("close() ends a parked consumer's next() with { done: true } (§10.1)", async () => {
    const relay = createPreviewRelay()
    const iterator = relay.frames[Symbol.asyncIterator]()
    const pending = iterator.next() // parks: no frame yet
    relay.close()
    const { done } = await pending
    expect(done).toBe(true)
  })

  test("close() is idempotent", () => {
    const relay = createPreviewRelay()
    relay.close()
    expect(() => relay.close()).not.toThrow()
  })

  test("publish after close() is a no-op: a later consumer sees done, not the frame", async () => {
    const relay = createPreviewRelay()
    relay.close()
    relay.publish(makeFrame({ frameSeq: "1" }))
    const iterator = relay.frames[Symbol.asyncIterator]()
    const { done } = await iterator.next()
    expect(done).toBe(true)
  })

  test("a second concurrent parked consumer is rejected loudly instead of silently clobbering the first's resolver", async () => {
    const relay = createPreviewRelay()
    const iteratorA = relay.frames[Symbol.asyncIterator]()
    const iteratorB = relay.frames[Symbol.asyncIterator]()
    const pA = iteratorA.next() // parks: no pending frame, wake is now A's resolver
    const pB = iteratorB.next() // parks concurrently: must NOT overwrite A's resolver
    await expect(pB).rejects.toThrow(/single-consumer/)
    // The first consumer must still be alive and get woken by a publish.
    const frame = makeFrame({ frameSeq: "1" })
    relay.publish(frame)
    const { value, done } = await pA
    expect(done).toBe(false)
    expect(value).toBe(frame)
  })

  test("no monotonic guard: a new incarnation's lower frameSeq is still yielded across a simulated restart", async () => {
    const relay = createPreviewRelay()
    const iterator = relay.frames[Symbol.asyncIterator]()

    // Old incarnation: stable sessionId X, seq 5.
    const old = makeFrame({ sessionId: "s-x", frameSeq: "5" })
    relay.publish(old)
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toBe(old)

    // New incarnation after restart: same stable sessionId, frameSeq restarts at 1.
    const fresh = makeFrame({ sessionId: "s-x", frameSeq: "1" })
    relay.publish(fresh)
    const second = await iterator.next()
    expect(second.done).toBe(false)
    expect(second.value).toBe(fresh) // the per-incarnation broker would reject "1" <= "5"; the relay does not
  })
})
