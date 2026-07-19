import { describe, expect, test } from "bun:test"

import { uuidv7 } from "infrastructure/uuid"
import { decodeCommentsHeader, decodePinEvent, foldPins, PinDecodeError } from "./decode"
import type { PinEvent } from "../types"

const TS = "2026-07-19T12:00:00.000Z"

function ok<T>(result: T | PinDecodeError): T {
  if (result instanceof PinDecodeError) throw new Error(`expected success, got ${result.message}`)
  return result
}

function created(pinId: string): PinEvent {
  return { kind: "pin:created", recordId: uuidv7(), pinId, element: "el", fx: 0.5, fy: 0.5, text: "note", ts: TS }
}

function status(pinId: string, s: "open" | "resolved"): PinEvent {
  return { kind: "pin:status", recordId: uuidv7(), pinId, status: s, turnId: uuidv7(), ts: TS }
}

describe("decodeCommentsHeader", () => {
  test("decodes a valid header", () => {
    const header = ok(decodeCommentsHeader({ kind: "pins", formatVersion: 1, projectId: uuidv7(), pageSlug: "home" }))
    expect(header.kind).toBe("pins")
  })

  test("rejects wrong kind, version, id, and slug", () => {
    expect(decodeCommentsHeader({ kind: "chat", formatVersion: 1, projectId: uuidv7(), pageSlug: "home" })).toBeInstanceOf(PinDecodeError)
    expect(decodeCommentsHeader({ kind: "pins", formatVersion: 2, projectId: uuidv7(), pageSlug: "home" })).toBeInstanceOf(PinDecodeError)
    expect(decodeCommentsHeader({ kind: "pins", formatVersion: 1, projectId: "x", pageSlug: "home" })).toBeInstanceOf(PinDecodeError)
    expect(decodeCommentsHeader({ kind: "pins", formatVersion: 1, projectId: uuidv7(), pageSlug: "BAD" })).toBeInstanceOf(PinDecodeError)
  })
})

describe("decodePinEvent", () => {
  test("decodes a pin:created event", () => {
    const ev = ok(decodePinEvent({ kind: "pin:created", recordId: uuidv7(), pinId: uuidv7(), element: "btn", fx: 0.25, fy: 0.75, text: "fix this", ts: TS }))
    expect(ev.kind).toBe("pin:created")
  })

  test("decodes a pin:status with actionId and one with turnId", () => {
    expect(ok(decodePinEvent({ kind: "pin:status", recordId: uuidv7(), pinId: uuidv7(), status: "resolved", actionId: uuidv7(), ts: TS })).kind).toBe("pin:status")
    expect(ok(decodePinEvent({ kind: "pin:status", recordId: uuidv7(), pinId: uuidv7(), status: "open", turnId: uuidv7(), ts: TS })).kind).toBe("pin:status")
  })

  test("rejects an unknown kind", () => {
    expect(decodePinEvent({ kind: "pin:deleted", recordId: uuidv7(), pinId: uuidv7(), ts: TS })).toBeInstanceOf(PinDecodeError)
  })

  test("rejects fx/fy out of [0,1] or non-finite", () => {
    expect(decodePinEvent({ kind: "pin:created", recordId: uuidv7(), pinId: uuidv7(), element: "e", fx: 1.5, fy: 0.5, text: "x", ts: TS })).toBeInstanceOf(PinDecodeError)
    expect(decodePinEvent({ kind: "pin:created", recordId: uuidv7(), pinId: uuidv7(), element: "e", fx: 0.5, fy: -0.1, text: "x", ts: TS })).toBeInstanceOf(PinDecodeError)
  })

  test("rejects pin:status with both actionId AND turnId, or neither", () => {
    expect(decodePinEvent({ kind: "pin:status", recordId: uuidv7(), pinId: uuidv7(), status: "open", actionId: uuidv7(), turnId: uuidv7(), ts: TS })).toBeInstanceOf(PinDecodeError)
    expect(decodePinEvent({ kind: "pin:status", recordId: uuidv7(), pinId: uuidv7(), status: "open", ts: TS })).toBeInstanceOf(PinDecodeError)
  })

  test("rejects a bad pinId and an invalid status", () => {
    expect(decodePinEvent({ kind: "pin:created", recordId: uuidv7(), pinId: "x", element: "e", fx: 0.5, fy: 0.5, text: "t", ts: TS })).toBeInstanceOf(PinDecodeError)
    expect(decodePinEvent({ kind: "pin:status", recordId: uuidv7(), pinId: uuidv7(), status: "closed", turnId: uuidv7(), ts: TS })).toBeInstanceOf(PinDecodeError)
  })
})

describe("foldPins", () => {
  test("folds open -> resolved -> open to a final status of open", () => {
    const id = uuidv7()
    const pins = ok(foldPins([created(id), status(id, "resolved"), status(id, "open")]))
    expect(pins.length).toBe(1)
    expect(pins[0]?.status).toBe("open")
  })

  test("preserves creation order across multiple pins", () => {
    const a = uuidv7()
    const b = uuidv7()
    const pins = ok(foldPins([created(a), created(b), status(a, "resolved")]))
    expect(pins.map((p) => p.pinId)).toEqual([a, b])
    expect(pins[0]?.status).toBe("resolved")
    expect(pins[1]?.status).toBe("open")
  })

  test("rejects a second pin:created for one pinId (corruption)", () => {
    const id = uuidv7()
    expect(foldPins([created(id), created(id)])).toBeInstanceOf(PinDecodeError)
  })

  test("rejects a pin:status before its pin:created (corruption)", () => {
    const id = uuidv7()
    expect(foldPins([status(id, "resolved")])).toBeInstanceOf(PinDecodeError)
  })
})
