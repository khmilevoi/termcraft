import { describe, expect, test } from "bun:test";

import { FrameDecoder } from "infrastructure/framing";

import type { FrameEnvelope } from "../types";
import { ProtocolError } from "./errors";
import { decodeFrameEnvelope, encodeFrameEnvelope } from "./frame";

const frame: FrameEnvelope = {
  protocolVersion: 1,
  kind: "frame",
  sessionId: "0198b1c2-0000-7000-8000-000000000000",
  nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  sourceHash: "a".repeat(64),
  frameSeq: "1",
  width: 3,
  height: 2,
  rows: [
    [
      { text: "ab", fg: "default", bg: { indexed: 0 }, attrs: 0 },
      { text: "c", fg: { rgb: "#ff8800" }, bg: "default", attrs: 1 },
    ],
    [{ text: "xyz", fg: "default", bg: "default", attrs: 63 }],
  ],
};

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function dataPayload(encoded: Uint8Array): Uint8Array {
  const frames = new FrameDecoder().feed(encoded);
  if (frames instanceof Error) throw frames;
  const first = frames[0];
  if (!first) throw new Error("no frame");
  expect(first.messageClass).toBe("data");
  return first.payload;
}

describe("frame envelope", () => {
  test("round-trips through the framing layer as a data-class frame", () => {
    const encoded = encodeFrameEnvelope(frame);
    if (encoded instanceof Error) throw encoded;
    expect(decodeFrameEnvelope(dataPayload(encoded))).toEqual(frame);
  });

  test("rejects rows whose count differs from height", () => {
    expect(decodeFrameEnvelope(encode({ ...frame, height: 3 }))).toBeInstanceOf(ProtocolError);
  });

  test("rejects a frameSeq that is not a decimal uint string", () => {
    expect(decodeFrameEnvelope(encode({ ...frame, frameSeq: "0" }))).toBeInstanceOf(ProtocolError);
  });

  test("rejects an attrs value outside the 6-bit mask", () => {
    const bad = {
      ...frame,
      rows: [[{ text: "abc", fg: "default", bg: "default", attrs: 64 }], frame.rows[1]],
    };
    expect(decodeFrameEnvelope(encode(bad))).toBeInstanceOf(ProtocolError);
  });

  test("rejects an out-of-mask attrs that is a safe integer >= 2^32", () => {
    // 4294967296 = 2^32: a bitwise `& ~63` guard wraps to 0 and would wrongly
    // accept this; the numeric range check rejects it.
    const bad = {
      ...frame,
      rows: [[{ text: "abc", fg: "default", bg: "default", attrs: 4294967296 }], frame.rows[1]],
    };
    expect(decodeFrameEnvelope(encode(bad))).toBeInstanceOf(ProtocolError);
  });

  test("rejects an unknown color shape", () => {
    const bad = {
      ...frame,
      rows: [[{ text: "abc", fg: { hsl: 1 }, bg: "default", attrs: 0 }], frame.rows[1]],
    };
    expect(decodeFrameEnvelope(encode(bad))).toBeInstanceOf(ProtocolError);
  });

  test("rejects an indexed color out of 0..255", () => {
    const bad = {
      ...frame,
      rows: [[{ text: "abc", fg: { indexed: 256 }, bg: "default", attrs: 0 }], frame.rows[1]],
    };
    expect(decodeFrameEnvelope(encode(bad))).toBeInstanceOf(ProtocolError);
  });

  test("rejects a malformed rgb color", () => {
    const bad = {
      ...frame,
      rows: [[{ text: "abc", fg: { rgb: "#fff" }, bg: "default", attrs: 0 }], frame.rows[1]],
    };
    expect(decodeFrameEnvelope(encode(bad))).toBeInstanceOf(ProtocolError);
  });

  test("rejects a width above the per-axis cap", () => {
    expect(decodeFrameEnvelope(encode({ ...frame, width: 2049 }))).toBeInstanceOf(ProtocolError);
  });

  test("rejects a cell count above the total cap", () => {
    const result = decodeFrameEnvelope(encode({ ...frame, width: 2048, height: 2048 }));
    expect(result).toBeInstanceOf(ProtocolError);
    if (result instanceof ProtocolError) expect(result.code).toBe("FRAME_TOO_LARGE");
  });
});
