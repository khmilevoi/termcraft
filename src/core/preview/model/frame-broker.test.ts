import { describe, expect, test } from "bun:test"

import type { PreviewFrameV1 } from "core/ports"

import { createFrameBroker } from "./frame-broker"

/**
 * `FrameBroker` (host-supervision §8: "Preview frame broker | 1 complete frame |
 * Atomically replace the pending frame; increment framesCoalesced"). Every test here is
 * synchronous — `publish` never returns a promise and never touches a consumer, matching
 * kernel-command-contract §7.6's "frames do not pass through the control-event stream".
 */

function frame(frameSeq: string): PreviewFrameV1 {
  return {
    sessionId: "session-1",
    sourceHash: "a".repeat(64),
    frameSeq,
    width: 80,
    height: 24,
    rows: [],
  }
}

describe("createFrameBroker", () => {
  test("starts empty: no current frame, zero coalesced", () => {
    const broker = createFrameBroker()
    expect(broker.current()).toBeNull()
    expect(broker.framesCoalesced()).toBe(0)
  })

  test("the first publish becomes current without counting as coalesced", () => {
    const broker = createFrameBroker()
    broker.publish(frame("1"))
    expect(broker.current()).toEqual(frame("1"))
    expect(broker.framesCoalesced()).toBe(0)
  })

  test("publishing over a pending frame replaces it and counts one coalesce", () => {
    const broker = createFrameBroker()
    broker.publish(frame("1"))
    broker.publish(frame("2"))
    expect(broker.current()).toEqual(frame("2"))
    expect(broker.framesCoalesced()).toBe(1)
  })

  test("three publishes with no read between them coalesce twice, latest wins", () => {
    const broker = createFrameBroker()
    broker.publish(frame("1"))
    broker.publish(frame("2"))
    broker.publish(frame("3"))
    expect(broker.current()).toEqual(frame("3"))
    expect(broker.framesCoalesced()).toBe(2)
  })

  test("current() is a non-consuming peek: reading twice returns the same frame and does not itself coalesce", () => {
    const broker = createFrameBroker()
    broker.publish(frame("1"))
    expect(broker.current()).toEqual(frame("1"))
    expect(broker.current()).toEqual(frame("1"))
    expect(broker.framesCoalesced()).toBe(0)
  })

  test("clear() drops the pending frame without touching the coalesce count", () => {
    const broker = createFrameBroker()
    broker.publish(frame("1"))
    broker.publish(frame("2"))
    broker.clear()
    expect(broker.current()).toBeNull()
    expect(broker.framesCoalesced()).toBe(1)
  })

  test("publishing again after clear() becomes current without counting as coalesced", () => {
    const broker = createFrameBroker()
    broker.publish(frame("1"))
    broker.clear()
    broker.publish(frame("2"))
    expect(broker.current()).toEqual(frame("2"))
    expect(broker.framesCoalesced()).toBe(0)
  })
})
