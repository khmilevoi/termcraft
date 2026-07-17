import { describe, expect, test } from "bun:test"

import { FrameDecoder } from "../../../infrastructure/framing"
import { decodeControlEnvelope, encodeControlEnvelope } from "./control-envelope"
import { decodeFrameEnvelope, encodeFrameEnvelope } from "./frame"
import { decodeClientHello, encodeClientHello } from "./hello"
import type { ClientHelloV1, ControlEnvelope, FrameEnvelope } from "../types"

const hello: ClientHelloV1 = {
  framingVersion: 1,
  kind: "client.hello",
  sessionId: "0198b1c2-0000-7000-8000-000000000000",
  nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  offeredFramingVersions: [1],
  offeredProtocolVersions: [1],
  mode: "smoke",
  pageSlug: "dashboard",
  sourceHash: "b".repeat(64),
  sourceKitApiVersion: 1,
  runtimeDeclaration: {
    module: "@termcraft/runtime",
    currentKitApiVersion: 1,
    supportedKitApiVersions: [1],
    publicCapabilityIds: ["nav"],
  },
  limits: {
    controlPayloadBytes: 262144,
    framePayloadBytes: 16777216,
    maxFrameWidth: 2048,
    maxFrameHeight: 2048,
    maxFrameCells: 262144,
  },
}

const envelope: ControlEnvelope = {
  protocolVersion: 1,
  kind: "heartbeat",
  sessionId: hello.sessionId,
  nonce: hello.nonce,
  messageId: "2",
  body: { tick: "42", lastFrameSeq: "5" },
}

const frame: FrameEnvelope = {
  protocolVersion: 1,
  kind: "frame",
  sessionId: hello.sessionId,
  nonce: hello.nonce,
  sourceHash: hello.sourceHash,
  frameSeq: "5",
  width: 2,
  height: 1,
  rows: [[{ text: "hi", fg: "default", bg: "default", attrs: 0 }]],
}

function encodeAll(): Uint8Array {
  const parts = [
    encodeClientHello(hello),
    encodeControlEnvelope(envelope),
    encodeFrameEnvelope(frame),
  ]
  const bytes: Uint8Array[] = []
  for (const part of parts) {
    if (part instanceof Error) throw part
    bytes.push(part)
  }
  const total = bytes.reduce((sum, part) => sum + part.byteLength, 0)
  const joined = new Uint8Array(total)
  bytes.reduce((offset, part) => {
    joined.set(part, offset)
    return offset + part.byteLength
  }, 0)
  return joined
}

describe("protocol wire integration", () => {
  test("decodes a hello + control + frame stream delivered one byte at a time", () => {
    const stream = encodeAll()
    const decoder = new FrameDecoder()
    const collected = []
    for (const byte of stream) {
      const frames = decoder.feed(new Uint8Array([byte]))
      if (frames instanceof Error) throw frames
      collected.push(...frames)
    }
    expect(collected).toHaveLength(3)

    const helloFrame = collected[0]
    const controlFrame = collected[1]
    const dataFrame = collected[2]
    if (!helloFrame || !controlFrame || !dataFrame) throw new Error("missing frame")

    expect(helloFrame.messageClass).toBe("control")
    expect(controlFrame.messageClass).toBe("control")
    expect(dataFrame.messageClass).toBe("data")

    expect(decodeClientHello(helloFrame.payload)).toEqual(hello)
    expect(decodeControlEnvelope(controlFrame.payload)).toEqual(envelope)
    expect(decodeFrameEnvelope(dataFrame.payload)).toEqual(frame)
  })
})
