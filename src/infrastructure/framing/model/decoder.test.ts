import { describe, expect, test } from "bun:test"

import {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  FRAME_HEADER_BYTES,
  GLOBAL_PAYLOAD_CEILING_BYTES,
} from "./constants"
import { FrameDecoder } from "./decoder"
import { encodeFrame } from "./encode"
import { FramingError } from "./errors"

function mustEncode(
  messageClass: "control" | "data",
  payload: Uint8Array,
): Uint8Array {
  const encoded = encodeFrame({ messageClass, payload })
  if (encoded instanceof Error) throw encoded
  return encoded
}

describe("FrameDecoder", () => {
  test("round-trips a single control frame", () => {
    const payload = new TextEncoder().encode(`{"kind":"hello"}`)
    const decoder = new FrameDecoder()
    const frames = decoder.feed(mustEncode("control", payload))
    if (frames instanceof Error) throw frames
    expect(frames).toHaveLength(1)
    expect(frames[0]?.messageClass).toBe("control")
    expect(frames[0]?.payload).toEqual(payload)
  })

  test("tolerates byte-at-a-time delivery", () => {
    const payload = new TextEncoder().encode(`{"seq":1}`)
    const encoded = mustEncode("data", payload)
    const decoder = new FrameDecoder()
    const collected: unknown[] = []
    for (const [index, byte] of encoded.entries()) {
      const frames = decoder.feed(new Uint8Array([byte]))
      if (frames instanceof Error) throw frames
      if (index < encoded.byteLength - 1) expect(frames).toHaveLength(0)
      collected.push(...frames)
    }
    expect(collected).toHaveLength(1)
  })

  test("emits several frames arriving in one chunk", () => {
    const parts = [
      mustEncode("control", new TextEncoder().encode(`{"a":1}`)),
      mustEncode("data", new Uint8Array([1, 2, 3])),
      mustEncode("control", new TextEncoder().encode(`{"z":9}`)),
    ]
    const joined = new Uint8Array(
      parts.reduce((total, part) => total + part.byteLength, 0),
    )
    parts.reduce((offset, part) => {
      joined.set(part, offset)
      return offset + part.byteLength
    }, 0)

    const decoder = new FrameDecoder()
    const frames = decoder.feed(joined)
    if (frames instanceof Error) throw frames
    expect(frames.map((frame) => frame.messageClass)).toEqual([
      "control",
      "data",
      "control",
    ])
    expect(frames[2]?.payload).toEqual(new TextEncoder().encode(`{"z":9}`))
  })

  test("rejects a zero-length frame from the length prefix alone (§5)", () => {
    const header = new Uint8Array(4) // N = 0
    const decoder = new FrameDecoder()
    expect(decoder.feed(header)).toBeInstanceOf(FramingError)
  })

  test("a length header containing 0x0A / 0x0D bytes survives (Spike E)", () => {
    // N = 10 → length bytes 00 00 00 0A; N = 13 → 00 00 00 0D.
    for (const size of [10, 13]) {
      const payload = new Uint8Array(size).fill(0x61)
      const decoder = new FrameDecoder()
      const frames = decoder.feed(mustEncode("data", payload))
      if (frames instanceof Error) throw frames
      expect(frames[0]?.payload).toEqual(payload)
    }
  })

  test("rejects N above the global ceiling from the length prefix alone", () => {
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(
      0,
      GLOBAL_PAYLOAD_CEILING_BYTES + 1,
      false,
    )
    const decoder = new FrameDecoder()
    expect(decoder.feed(header)).toBeInstanceOf(FramingError)
  })

  test("rejects a control frame above its class limit", () => {
    const header = new Uint8Array(FRAME_HEADER_BYTES)
    const view = new DataView(header.buffer)
    view.setUint32(0, CONTROL_PAYLOAD_LIMIT_BYTES + 1, false)
    view.setUint8(4, 1)
    view.setUint8(5, 1)
    const decoder = new FrameDecoder()
    expect(decoder.feed(header)).toBeInstanceOf(FramingError)
  })

  test.each([
    ["version", (view: DataView) => view.setUint8(4, 2)],
    ["class", (view: DataView) => view.setUint8(5, 3)],
    ["flags", (view: DataView) => view.setUint16(6, 1, false)],
  ] as const)("rejects a corrupt %s byte", (_name, corrupt) => {
    const encoded = mustEncode("control", new Uint8Array([0x7b, 0x7d]))
    const view = new DataView(encoded.buffer, encoded.byteOffset)
    corrupt(view)
    const decoder = new FrameDecoder()
    expect(decoder.feed(encoded)).toBeInstanceOf(FramingError)
  })

  test("stays poisoned after a violation", () => {
    const bad = new Uint8Array(4)
    new DataView(bad.buffer).setUint32(
      0,
      GLOBAL_PAYLOAD_CEILING_BYTES + 1,
      false,
    )
    const decoder = new FrameDecoder()
    const first = decoder.feed(bad)
    expect(first).toBeInstanceOf(FramingError)

    const fine = mustEncode("control", new Uint8Array([0x7b, 0x7d]))
    const second = decoder.feed(fine)
    expect(second).toBe(first)
  })

  test("copies payload bytes out of the fed chunk", () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const encoded = mustEncode("data", payload)
    const decoder = new FrameDecoder()
    const frames = decoder.feed(encoded)
    if (frames instanceof Error) throw frames
    encoded.fill(0)
    expect(frames[0]?.payload).toEqual(new Uint8Array([1, 2, 3, 4]))
  })
})
