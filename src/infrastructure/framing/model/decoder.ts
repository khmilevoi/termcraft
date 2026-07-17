import type { MessageClass, WireFrame } from "../types"
import {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  DATA_PAYLOAD_LIMIT_BYTES,
  FRAME_HEADER_BYTES,
  FRAMING_VERSION,
  GLOBAL_PAYLOAD_CEILING_BYTES,
} from "./constants"
import { FramingError } from "./errors"

const CLASS_BY_CODE: Record<number, MessageClass> = {
  1: "control",
  2: "data",
}

const CLASS_LIMITS: Record<MessageClass, number> = {
  control: CONTROL_PAYLOAD_LIMIT_BYTES,
  data: DATA_PAYLOAD_LIMIT_BYTES,
}

/**
 * Buffering push parser for the §5 outer frame layout. Fragmentation is the
 * normal case (Spike E measured 5 stdio events for 3 logical frames), so
 * `feed` buffers partial prefixes, headers, and payloads. A violation
 * poisons the decoder permanently — the transport must be torn down.
 */
export class FrameDecoder {
  // Bare `Uint8Array` (i.e. `Uint8Array<ArrayBufferLike>`) so reassignment
  // from `appendBytes` and `.slice()` — whose results are also bare — type-
  // checks; the initializer alone would narrow this to `Uint8Array<ArrayBuffer>`.
  private buffered: Uint8Array = new Uint8Array(0)
  private failure: FramingError | null = null

  feed(chunk: Uint8Array): FramingError | WireFrame[] {
    if (this.failure !== null) return this.failure

    this.buffered = appendBytes(this.buffered, chunk)
    const frames: WireFrame[] = []
    while (true) {
      if (this.buffered.byteLength < 4) return frames
      const view = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset,
        this.buffered.byteLength,
      )

      // §5: a length of zero is a fatal framing error, and N above the
      // global ceiling is rejected before allocating a payload buffer —
      // both detectable from the 4-byte length prefix alone.
      const payloadLength = view.getUint32(0, false)
      if (payloadLength === 0) {
        return this.poison("payload length of zero is not a valid frame")
      }
      if (payloadLength > GLOBAL_PAYLOAD_CEILING_BYTES) {
        return this.poison(
          `payload length ${payloadLength} exceeds the global ${GLOBAL_PAYLOAD_CEILING_BYTES}-byte ceiling`,
        )
      }

      if (this.buffered.byteLength < FRAME_HEADER_BYTES) return frames
      const version = view.getUint8(4)
      if (version !== FRAMING_VERSION) {
        return this.poison(
          `framing version ${version} is not the supported version ${FRAMING_VERSION}`,
        )
      }
      const classCode = view.getUint8(5)
      const messageClass = CLASS_BY_CODE[classCode] ?? null
      if (messageClass === null) {
        return this.poison(`unknown message class code ${classCode}`)
      }
      const flags = view.getUint16(6, false)
      if (flags !== 0) {
        return this.poison(`flags ${flags} must be zero in framing version 1`)
      }
      const classLimit = CLASS_LIMITS[messageClass]
      if (payloadLength > classLimit) {
        return this.poison(
          `${messageClass} payload of ${payloadLength} bytes exceeds the ${classLimit}-byte class limit`,
        )
      }

      if (this.buffered.byteLength < FRAME_HEADER_BYTES + payloadLength) {
        return frames
      }
      // slice() copies, so emitted payloads never alias the fed chunk.
      const payload = this.buffered.slice(
        FRAME_HEADER_BYTES,
        FRAME_HEADER_BYTES + payloadLength,
      )
      frames.push({ messageClass, payload })
      this.buffered = this.buffered.slice(FRAME_HEADER_BYTES + payloadLength)
    }
  }

  private poison(reason: string): FramingError {
    this.failure = new FramingError({ reason })
    this.buffered = new Uint8Array(0)
    return this.failure
  }
}

function appendBytes(current: Uint8Array, next: Uint8Array): Uint8Array {
  if (next.byteLength === 0) return current
  const joined = new Uint8Array(current.byteLength + next.byteLength)
  joined.set(current, 0)
  joined.set(next, current.byteLength)
  return joined
}
