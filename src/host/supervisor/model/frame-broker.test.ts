import { describe, expect, test } from "bun:test"
import type { FrameEnvelope } from "../../protocol"
import { createFrameBroker } from "./frame-broker"

const GUARD = { sessionId: "s-1", nonce: "a".repeat(32), sourceHash: "b".repeat(64) }

function makeFrame(overrides: Partial<FrameEnvelope> = {}): FrameEnvelope {
  return {
    protocolVersion: 1,
    kind: "frame",
    sessionId: GUARD.sessionId,
    nonce: GUARD.nonce,
    sourceHash: GUARD.sourceHash,
    frameSeq: "1",
    width: 80,
    height: 24,
    rows: Array.from({ length: 24 }, () => []),
    ...overrides,
  }
}

describe("createFrameBroker", () => {
  test("accepts a valid frame and yields it as a PreviewFrame without the nonce", async () => {
    const broker = createFrameBroker(GUARD)
    expect(broker.publish(makeFrame({ frameSeq: "1" }))).toBe("accepted")
    const iterator = broker.frames[Symbol.asyncIterator]()
    const { value, done } = await iterator.next()
    expect(done).toBe(false)
    expect(value).toEqual({
      sessionId: GUARD.sessionId,
      sourceHash: GUARD.sourceHash,
      frameSeq: "1",
      width: 80,
      height: 24,
      rows: Array.from({ length: 24 }, () => []),
    })
    expect(value).not.toHaveProperty("nonce")
  })

  test("capacity-1 latest-wins: replacing an unconsumed frame counts a coalesce", async () => {
    const broker = createFrameBroker(GUARD)
    expect(broker.publish(makeFrame({ frameSeq: "1" }))).toBe("accepted")
    expect(broker.publish(makeFrame({ frameSeq: "2" }))).toBe("accepted")
    expect(broker.publish(makeFrame({ frameSeq: "3" }))).toBe("accepted")
    expect(broker.framesCoalesced()).toBe(2) // two pending frames were replaced before consumption
    const iterator = broker.frames[Symbol.asyncIterator]()
    const { value } = await iterator.next()
    expect(value?.frameSeq).toBe("3") // only the newest survives
  })

  test("rejects a frame whose nonce, sessionId, or sourceHash does not match the guard (§10.1)", () => {
    const broker = createFrameBroker(GUARD)
    expect(broker.publish(makeFrame({ nonce: "f".repeat(32) }))).toBe("stale")
    expect(broker.publish(makeFrame({ sessionId: "s-2" }))).toBe("stale")
    expect(broker.publish(makeFrame({ sourceHash: "c".repeat(64) }))).toBe("stale")
  })

  test("rejects a non-monotonic frameSeq (compared as a uint64, not lexically)", () => {
    const broker = createFrameBroker(GUARD)
    expect(broker.publish(makeFrame({ frameSeq: "9" }))).toBe("accepted")
    expect(broker.publish(makeFrame({ frameSeq: "9" }))).toBe("stale") // equal is not greater
    expect(broker.publish(makeFrame({ frameSeq: "8" }))).toBe("stale") // earlier
    expect(broker.publish(makeFrame({ frameSeq: "10" }))).toBe("accepted") // "10" > "9" numerically, not lexically
  })

  test("close() ends the frame iterator for a parked consumer (§10.1)", async () => {
    const broker = createFrameBroker(GUARD)
    const iterator = broker.frames[Symbol.asyncIterator]()
    const pending = iterator.next() // parks: no frame yet
    broker.close()
    const { done } = await pending
    expect(done).toBe(true)
  })

  test("slow-consumer memory bound: 240 producer frames, 1 pending, 239 coalesced (§8/§14.2)", async () => {
    const broker = createFrameBroker(GUARD)
    for (let seq = 1; seq <= 240; seq += 1) {
      expect(broker.publish(makeFrame({ frameSeq: String(seq) }))).toBe("accepted")
    }
    expect(broker.framesCoalesced()).toBe(239) // only one slot ever retained
    const iterator = broker.frames[Symbol.asyncIterator]()
    const { value } = await iterator.next()
    expect(value?.frameSeq).toBe("240")
  })

  test("publish after close() is stale", () => {
    const broker = createFrameBroker(GUARD)
    broker.close()
    expect(broker.publish(makeFrame({ frameSeq: "1" }))).toBe("stale")
  })
})
