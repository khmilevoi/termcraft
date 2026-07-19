import { encodeFrame } from "infrastructure/framing"
import type { Color, FrameEnvelope, StyledRun } from "../types"
import { ProtocolError } from "./errors"
import {
  asArray,
  asObject,
  expectExactKeys,
  isDecimalUint64String,
  isLowercaseHex,
  isPositiveSafeInteger,
} from "./shape"
import { decodeJsonPayload } from "./strict-json"
import type { JsonValue } from "./strict-json"

export const FRAME_MAX_AXIS = 2048
export const FRAME_MAX_CELLS = 262144
/** All six defined attribute bits set: 1|2|4|8|16|32. */
export const FRAME_ATTR_MASK = 63

const SESSION_ID_MAX = 64
const NONCE_HEX_LENGTH = 32
const SOURCE_HASH_HEX_LENGTH = 64

const malformed = (reason: string) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })

export function encodeFrameEnvelope(frame: FrameEnvelope): ProtocolError | Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(frame))
  const framed = encodeFrame({ messageClass: "data", payload })
  if (framed instanceof Error) {
    return new ProtocolError({
      code: "OVERSIZED_MESSAGE",
      reason: "frame payload exceeds the framing limit",
      cause: framed,
    })
  }
  return framed
}

export function decodeFrameEnvelope(payload: Uint8Array): ProtocolError | FrameEnvelope {
  const value = decodeJsonPayload(payload)
  if (value instanceof ProtocolError) return value
  const object = asObject(value, "frame")
  if (object instanceof ProtocolError) return object

  const keyError = expectExactKeys(object, [
    "protocolVersion",
    "kind",
    "sessionId",
    "nonce",
    "sourceHash",
    "frameSeq",
    "width",
    "height",
    "rows",
  ])
  if (keyError instanceof ProtocolError) return keyError

  if (object.protocolVersion !== 1) return malformed("protocolVersion must be 1")
  if (object.kind !== "frame") return malformed('kind must be "frame"')
  if (
    typeof object.sessionId !== "string" ||
    object.sessionId.length === 0 ||
    object.sessionId.length > SESSION_ID_MAX
  ) {
    return malformed("sessionId must be a bounded non-empty string")
  }
  if (!isLowercaseHex(object.nonce, NONCE_HEX_LENGTH)) {
    return malformed("nonce must be 32 lowercase hex characters")
  }
  if (!isLowercaseHex(object.sourceHash, SOURCE_HASH_HEX_LENGTH)) {
    return malformed("sourceHash must be 64 lowercase hex characters")
  }
  if (!isDecimalUint64String(object.frameSeq)) {
    return malformed("frameSeq must be a decimal uint64 string")
  }
  if (!isPositiveSafeInteger(object.width) || object.width > FRAME_MAX_AXIS) {
    return malformed(`width must be a positive integer <= ${FRAME_MAX_AXIS}`)
  }
  if (!isPositiveSafeInteger(object.height) || object.height > FRAME_MAX_AXIS) {
    return malformed(`height must be a positive integer <= ${FRAME_MAX_AXIS}`)
  }
  if (object.width * object.height > FRAME_MAX_CELLS) {
    return new ProtocolError({
      code: "FRAME_TOO_LARGE",
      reason: `frame has more than ${FRAME_MAX_CELLS} cells`,
    })
  }

  const rows = asArray(object.rows, "rows")
  if (rows instanceof ProtocolError) return rows
  if (rows.length !== object.height) return malformed("rows length must equal height")

  const parsedRows: StyledRun[][] = []
  for (const rawRow of rows) {
    const row = asArray(rawRow, "row")
    if (row instanceof ProtocolError) return row
    const parsedRow: StyledRun[] = []
    for (const rawRun of row) {
      const run = validateStyledRun(rawRun)
      if (run instanceof ProtocolError) return run
      parsedRow.push(run)
    }
    parsedRows.push(parsedRow)
  }

  return {
    protocolVersion: 1,
    kind: "frame",
    sessionId: object.sessionId,
    nonce: object.nonce,
    sourceHash: object.sourceHash,
    frameSeq: object.frameSeq,
    width: object.width,
    height: object.height,
    rows: parsedRows,
  }
}

function validateStyledRun(value: JsonValue): ProtocolError | StyledRun {
  const object = asObject(value, "run")
  if (object instanceof ProtocolError) return object
  const keyError = expectExactKeys(object, ["text", "fg", "bg", "attrs"])
  if (keyError instanceof ProtocolError) return keyError

  if (typeof object.text !== "string") return malformed("run.text must be a string")
  const fg = validateColor(object.fg, "fg")
  if (fg instanceof ProtocolError) return fg
  const bg = validateColor(object.bg, "bg")
  if (bg instanceof ProtocolError) return bg
  if (
    typeof object.attrs !== "number" ||
    !Number.isInteger(object.attrs) ||
    object.attrs < 0 ||
    object.attrs > FRAME_ATTR_MASK
  ) {
    // Explicit numeric bound, NOT `(attrs & ~MASK) !== 0`: JS bitwise `&` coerces
    // to Int32, so a safe integer >= 2^32 whose low 6 bits form a valid mask (e.g.
    // 4294967296) would wrongly pass a bitwise guard. A range check cannot wrap.
    return malformed("run.attrs must be a 6-bit attribute mask")
  }

  return { text: object.text, fg, bg, attrs: object.attrs }
}

function validateColor(value: JsonValue | undefined, label: string): ProtocolError | Color {
  if (value === "default") return "default"
  const object = asObject(value, label)
  if (object instanceof ProtocolError) {
    return malformed(`${label} must be "default", {indexed}, or {rgb}`)
  }
  if ("indexed" in object) {
    const keyError = expectExactKeys(object, ["indexed"])
    if (keyError instanceof ProtocolError) return keyError
    if (
      typeof object.indexed !== "number" ||
      !Number.isInteger(object.indexed) ||
      object.indexed < 0 ||
      object.indexed > 255
    ) {
      return malformed(`${label}.indexed must be an integer 0..255`)
    }
    return { indexed: object.indexed }
  }
  if ("rgb" in object) {
    const keyError = expectExactKeys(object, ["rgb"])
    if (keyError instanceof ProtocolError) return keyError
    if (typeof object.rgb !== "string" || !/^#[0-9a-fA-F]{6}$/.test(object.rgb)) {
      return malformed(`${label}.rgb must be #RRGGBB`)
    }
    return { rgb: object.rgb as `#${string}` }
  }
  return malformed(`${label} must be "default", {indexed}, or {rgb}`)
}
