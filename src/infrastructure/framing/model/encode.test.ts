import { describe, expect, test } from "bun:test";

import { CONTROL_PAYLOAD_LIMIT_BYTES, FRAME_HEADER_BYTES, FRAMING_VERSION } from "./constants";
import { encodeFrame } from "./encode";
import { FramingError } from "./errors";

describe("encodeFrame", () => {
  test("lays out the 8-byte header per host-supervision §5", () => {
    const payload = new TextEncoder().encode(`{"kind":"hello"}`);
    const encoded = encodeFrame({ messageClass: "control", payload });
    if (encoded instanceof Error) throw encoded;

    expect(encoded.byteLength).toBe(FRAME_HEADER_BYTES + payload.byteLength);
    const view = new DataView(encoded.buffer, encoded.byteOffset);
    expect(view.getUint32(0, false)).toBe(payload.byteLength); // big-endian N
    expect(view.getUint8(4)).toBe(FRAMING_VERSION);
    expect(view.getUint8(5)).toBe(1); // control class code
    expect(view.getUint16(6, false)).toBe(0); // flags must be zero
    expect(encoded.slice(FRAME_HEADER_BYTES)).toEqual(payload);
  });

  test("data class encodes class code 2", () => {
    const encoded = encodeFrame({
      messageClass: "data",
      payload: new Uint8Array([1, 2, 3]),
    });
    if (encoded instanceof Error) throw encoded;
    expect(encoded[5]).toBe(2);
  });

  test("an empty payload is a FramingError (N = 0 is fatal, §5)", () => {
    const result = encodeFrame({
      messageClass: "control",
      payload: new Uint8Array(0),
    });
    expect(result).toBeInstanceOf(FramingError);
  });

  test("control payload at exactly the limit is accepted", () => {
    const encoded = encodeFrame({
      messageClass: "control",
      payload: new Uint8Array(CONTROL_PAYLOAD_LIMIT_BYTES),
    });
    expect(encoded).not.toBeInstanceOf(Error);
  });

  test("control payload above the limit is a FramingError", () => {
    const result = encodeFrame({
      messageClass: "control",
      payload: new Uint8Array(CONTROL_PAYLOAD_LIMIT_BYTES + 1),
    });
    expect(result).toBeInstanceOf(FramingError);
  });
});
