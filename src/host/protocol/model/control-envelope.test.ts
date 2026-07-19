import { describe, expect, test } from "bun:test"

import { FrameDecoder } from "infrastructure/framing"
import { decodeControlEnvelope, encodeControlEnvelope } from "./control-envelope"
import { ProtocolError } from "./errors"
import type { ControlEnvelope } from "../types"

const base: ControlEnvelope = {
  protocolVersion: 1,
  kind: "ready",
  sessionId: "0198b1c2-0000-7000-8000-000000000000",
  nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  messageId: "1",
  body: { effectiveInteractionMode: "static" },
}

const request: ControlEnvelope = {
  ...base,
  kind: "query-hit",
  messageId: "7",
  requestId: "7",
  body: { x: 3, y: 4 },
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function controlPayload(encoded: Uint8Array): Uint8Array {
  const frames = new FrameDecoder().feed(encoded)
  if (frames instanceof Error) throw frames
  const frame = frames[0]
  if (!frame) throw new Error("no frame")
  expect(frame.messageClass).toBe("control")
  return frame.payload
}

describe("control envelope", () => {
  test("round-trips a minimal envelope", () => {
    const encoded = encodeControlEnvelope(base)
    if (encoded instanceof Error) throw encoded
    expect(decodeControlEnvelope(controlPayload(encoded))).toEqual(base)
  })

  test("round-trips an envelope with requestId", () => {
    const encoded = encodeControlEnvelope(request)
    if (encoded instanceof Error) throw encoded
    expect(decodeControlEnvelope(controlPayload(encoded))).toEqual(request)
  })

  test("rejects a wrong protocolVersion", () => {
    expect(decodeControlEnvelope(encode({ ...base, protocolVersion: 2 }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a messageId that is not a decimal uint string", () => {
    expect(decodeControlEnvelope(encode({ ...base, messageId: "01" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a numeric messageId", () => {
    expect(decodeControlEnvelope(encode({ ...base, messageId: 1 }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a non-object body", () => {
    expect(decodeControlEnvelope(encode({ ...base, body: 5 }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects an unknown field", () => {
    expect(decodeControlEnvelope(encode({ ...base, surprise: 1 }))).toBeInstanceOf(ProtocolError)
  })

  test("round-trips an envelope with responseTo", () => {
    const response: ControlEnvelope = { ...base, kind: "set-mode-result", messageId: "9", responseTo: "7", body: {} }
    const encoded = encodeControlEnvelope(response)
    if (encoded instanceof Error) throw encoded
    expect(decodeControlEnvelope(controlPayload(encoded))).toEqual(response)
  })

  test("rejects a bad requestId", () => {
    expect(decodeControlEnvelope(encode({ ...request, requestId: "0" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a bad responseTo", () => {
    expect(decodeControlEnvelope(encode({ ...base, responseTo: "x" }))).toBeInstanceOf(ProtocolError)
  })

  test("maps an oversized control payload to OVERSIZED_MESSAGE", () => {
    const huge: ControlEnvelope = { ...base, body: { blob: "x".repeat(300_000) } }
    const result = encodeControlEnvelope(huge)
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("OVERSIZED_MESSAGE")
  })
})
