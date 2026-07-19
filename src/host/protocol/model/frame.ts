import { z } from "zod"

import { encodeFrame } from "infrastructure/framing"
import type { FrameEnvelope } from "../types"
import { ProtocolError } from "./errors"
import {
  boundedStringSchema,
  decimalUint64Schema,
  lowercaseHexSchema,
  malformedFromZodError,
  positiveSafeIntegerSchema,
} from "./shape"
import { decodeJsonPayload } from "./strict-json"

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

const boundedAxisSchema = positiveSafeIntegerSchema.refine((value) => value <= FRAME_MAX_AXIS, {
  error: `must be a positive integer <= ${FRAME_MAX_AXIS}`,
})

// Shape-only at this stage — `rows` elements are deep-validated after the cheap
// height/cell-count bound checks below, so a huge bogus `rows` array never reaches
// per-run validation before those checks reject it.
const frameHeaderSchema = z.strictObject({
  protocolVersion: z.literal(1),
  kind: z.literal("frame"),
  sessionId: boundedStringSchema(SESSION_ID_MAX),
  nonce: lowercaseHexSchema(NONCE_HEX_LENGTH),
  sourceHash: lowercaseHexSchema(SOURCE_HASH_HEX_LENGTH),
  frameSeq: decimalUint64Schema,
  width: boundedAxisSchema,
  height: boundedAxisSchema,
  rows: z.array(z.unknown()),
})

const indexedColorSchema = z.strictObject({ indexed: z.number().int().min(0).max(255) })
const rgbColorSchema = z.strictObject({
  rgb: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, { error: "must be #RRGGBB" })
    .transform((value) => value as `#${string}`),
})
const colorSchema = z.union([z.literal("default"), indexedColorSchema, rgbColorSchema])

const styledRunSchema = z.strictObject({
  text: z.string(),
  fg: colorSchema,
  bg: colorSchema,
  // Explicit numeric bound, NOT `(attrs & ~MASK) !== 0`: JS bitwise `&` coerces to
  // Int32, so a safe integer >= 2^32 whose low 6 bits form a valid mask (e.g.
  // 4294967296) would wrongly pass a bitwise guard. A range check cannot wrap.
  attrs: z.number().int().min(0).max(FRAME_ATTR_MASK),
})

const rowsSchema = z.array(z.array(styledRunSchema))

export function decodeFrameEnvelope(payload: Uint8Array): ProtocolError | FrameEnvelope {
  const value = decodeJsonPayload(payload)
  if (value instanceof ProtocolError) return value

  const header = frameHeaderSchema.safeParse(value)
  if (!header.success) return malformedFromZodError(header.error)

  if (header.data.width * header.data.height > FRAME_MAX_CELLS) {
    return new ProtocolError({
      code: "FRAME_TOO_LARGE",
      reason: `frame has more than ${FRAME_MAX_CELLS} cells`,
    })
  }
  if (header.data.rows.length !== header.data.height) return malformed("rows length must equal height")

  const rows = rowsSchema.safeParse(header.data.rows)
  if (!rows.success) return malformedFromZodError(rows.error)

  return {
    protocolVersion: 1,
    kind: "frame",
    sessionId: header.data.sessionId,
    nonce: header.data.nonce,
    sourceHash: header.data.sourceHash,
    frameSeq: header.data.frameSeq,
    width: header.data.width,
    height: header.data.height,
    rows: rows.data,
  }
}
