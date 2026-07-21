import type { WireFrame } from "../types";
import {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  DATA_PAYLOAD_LIMIT_BYTES,
  FRAME_HEADER_BYTES,
  FRAMING_VERSION,
} from "./constants";
import { FramingError } from "./errors";

const CLASS_CODES = { control: 1, data: 2 } as const;

const CLASS_LIMITS = {
  control: CONTROL_PAYLOAD_LIMIT_BYTES,
  data: DATA_PAYLOAD_LIMIT_BYTES,
} as const;

export function encodeFrame(frame: WireFrame): FramingError | Uint8Array {
  // §5: a length of zero is a fatal framing condition — every payload is
  // UTF-8 JSON, and empty bytes cannot be valid JSON. Refuse to produce one.
  if (frame.payload.byteLength === 0) {
    return new FramingError({
      reason: "payload of zero bytes is not a valid frame",
    });
  }

  const limit = CLASS_LIMITS[frame.messageClass];
  if (frame.payload.byteLength > limit) {
    return new FramingError({
      reason: `${frame.messageClass} payload of ${frame.payload.byteLength} bytes exceeds the ${limit}-byte class limit`,
    });
  }

  const encoded = new Uint8Array(FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(encoded.buffer);
  view.setUint32(0, frame.payload.byteLength, false);
  view.setUint8(4, FRAMING_VERSION);
  view.setUint8(5, CLASS_CODES[frame.messageClass]);
  // Bytes 6–7 stay zero: flags must be zero in framing version 1.
  encoded.set(frame.payload, FRAME_HEADER_BYTES);
  return encoded;
}
