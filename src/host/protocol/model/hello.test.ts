import { describe, expect, test } from "bun:test"

import { FrameDecoder } from "infrastructure/framing"
import { ProtocolError } from "./errors"
import {
  decodeClientHello,
  decodeHostHello,
  encodeClientHello,
  encodeHostHello,
} from "./hello"
import type { ClientHelloV1, HostHelloV1 } from "../types"

const runtimeDeclaration = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["nav"],
} as const

const limits = {
  controlPayloadBytes: 262144,
  framePayloadBytes: 16777216,
  maxFrameWidth: 2048,
  maxFrameHeight: 2048,
  maxFrameCells: 262144,
} as const

const clientHello: ClientHelloV1 = {
  framingVersion: 1,
  kind: "client.hello",
  sessionId: "0198b1c2-0000-7000-8000-000000000000",
  nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  offeredFramingVersions: [1],
  offeredProtocolVersions: [1],
  mode: "preview",
  pageSlug: "dashboard",
  sourceHash: "a".repeat(64),
  sourceKitApiVersion: 1,
  runtimeDeclaration: { ...runtimeDeclaration, supportedKitApiVersions: [1], publicCapabilityIds: ["nav"] },
  limits: { ...limits },
}

const hostHello: HostHelloV1 = {
  framingVersion: 1,
  kind: "host.hello",
  sessionId: "0198b1c2-0000-7000-8000-000000000000",
  nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  selectedFramingVersion: 1,
  selectedProtocolVersion: 1,
  runtimeDeclaration: { ...runtimeDeclaration, supportedKitApiVersions: [1], publicCapabilityIds: ["nav"] },
  limits: { ...limits },
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function controlPayload(encoded: Uint8Array): Uint8Array {
  const frames = new FrameDecoder().feed(encoded)
  if (frames instanceof Error) throw frames
  const frame = frames[0]
  if (!frame) throw new Error("no frame decoded")
  expect(frame.messageClass).toBe("control")
  return frame.payload
}

describe("client hello", () => {
  test("round-trips through the framing layer", () => {
    const encoded = encodeClientHello(clientHello)
    if (encoded instanceof Error) throw encoded
    expect(decodeClientHello(controlPayload(encoded))).toEqual(clientHello)
  })

  test("rejects a wrong framingVersion literal", () => {
    expect(decodeClientHello(encode({ ...clientHello, framingVersion: 2 }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a wrong kind", () => {
    expect(decodeClientHello(encode({ ...clientHello, kind: "host.hello" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a non-[1] offered array", () => {
    expect(decodeClientHello(encode({ ...clientHello, offeredProtocolVersions: [1, 2] }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects an unknown mode", () => {
    expect(decodeClientHello(encode({ ...clientHello, mode: "weird" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a malformed nonce", () => {
    expect(decodeClientHello(encode({ ...clientHello, nonce: "SHORT" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a source hash of the wrong length", () => {
    expect(decodeClientHello(encode({ ...clientHello, sourceHash: "abc" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects an unknown field", () => {
    expect(decodeClientHello(encode({ ...clientHello, extra: true }))).toBeInstanceOf(ProtocolError)
  })
})

describe("host hello", () => {
  test("round-trips through the framing layer", () => {
    const encoded = encodeHostHello(hostHello)
    if (encoded instanceof Error) throw encoded
    expect(decodeHostHello(controlPayload(encoded))).toEqual(hostHello)
  })

  test("rejects a wrong selected framing version", () => {
    expect(decodeHostHello(encode({ ...hostHello, selectedFramingVersion: 2 }))).toBeInstanceOf(ProtocolError)
  })
})
