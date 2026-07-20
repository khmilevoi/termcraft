import crypto from "node:crypto"
import * as errore from "errore"

import type { ChatHeader, ChatRecord } from "entities/chat"
import { type ChatDecodeError, decodeChatHeader, decodeChatRecord } from "entities/chat"
import type { CommentsHeader, PinEvent } from "entities/pin"
import { type PinDecodeError, decodeCommentsHeader, decodePinEvent } from "entities/pin"
import { JSONL_MAX_PHYSICAL_LINE_BYTES, JSONL_MAX_SERIALIZED_OBJECT_BYTES } from "store/safe-fs"
import type { Sha256Hex } from "../types"

export { JSONL_MAX_PHYSICAL_LINE_BYTES, JSONL_MAX_SERIALIZED_OBJECT_BYTES }

/** The only line terminator termcraft JSONL uses (storage-identity §11.1). */
export const JSONL_LF = 0x0a
const CR = 0x0d
const BOM = [0xef, 0xbb, 0xbf] as const

/**
 * storage-identity §11.1: a physical line, INCLUDING its terminating LF, may use at most
 * 1,048,576 bytes. The measured and allowed counts are both reported because an oversized
 * write must fail before any file change with those two numbers in hand.
 */
export class JsonlLineTooLongError extends errore.createTaggedError({
  name: "JsonlLineTooLongError",
  message: "jsonl physical line exceeds the bound: measured $measured bytes, allowed $allowed",
}) {}

/**
 * A physical line that is not one UTF-8, BOM-free, LF-terminated JSON object
 * (storage-identity §11.1). Blank lines, invalid UTF-8, invalid JSON, and a non-object
 * JSON value are all corruption — this is the value the streaming reader classifies on.
 */
export class JsonlLineFormatError extends errore.createTaggedError({
  name: "JsonlLineFormatError",
  message: "invalid jsonl line: $reason",
}) {}

export type JsonlLineError = JsonlLineTooLongError | JsonlLineFormatError

/** Lowercase-hex SHA-256 — the digest every storage identity and prefix hash uses. */
export function sha256Hex(bytes: Uint8Array): Sha256Hex {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

/** A parsed line's value, boxed so the union with `Error` cannot collapse to `unknown`. */
export interface JsonlLineValue {
  readonly value: unknown
}

const encoder = new TextEncoder()
// `fatal: true` is what makes invalid UTF-8 corruption rather than U+FFFD; the BOM is
// rejected explicitly below, because `ignoreBOM: false` would silently strip it.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * Serialize one value as a physical JSONL line: canonical JSON, UTF-8, no BOM, one
 * terminating LF. `JSON.stringify` escapes every control character, so no raw LF or CR can
 * appear inside the payload. An oversized line is rejected BEFORE the caller can write
 * anything, reporting the measured and allowed byte counts (storage-identity §11.1).
 */
export function encodeJsonlLine(value: unknown): JsonlLineError | Uint8Array {
  const json = errore.try({
    try: () => JSON.stringify(value),
    catch: (cause) => new JsonlLineFormatError({ reason: "value is not JSON-serializable", cause }),
  })
  if (json instanceof Error) return json
  if (json === undefined) return new JsonlLineFormatError({ reason: "value serializes to nothing" })

  const content = encoder.encode(json)
  if (content.byteLength > JSONL_MAX_SERIALIZED_OBJECT_BYTES) {
    return new JsonlLineTooLongError({ measured: content.byteLength + 1, allowed: JSONL_MAX_PHYSICAL_LINE_BYTES })
  }

  const line = new Uint8Array(content.byteLength + 1)
  line.set(content, 0)
  line[content.byteLength] = JSONL_LF
  return line
}

/**
 * Decode one COMPLETE physical line — the terminating LF included — into its parsed JSON
 * value. An unterminated final line is never passed here: storage-identity §11.1 makes a
 * syntactically valid final object without LF an uncommitted suffix, not a record.
 */
export function decodeJsonlLine(physicalLine: Uint8Array): JsonlLineError | JsonlLineValue {
  if (physicalLine.byteLength > JSONL_MAX_PHYSICAL_LINE_BYTES) {
    return new JsonlLineTooLongError({ measured: physicalLine.byteLength, allowed: JSONL_MAX_PHYSICAL_LINE_BYTES })
  }
  if (physicalLine.byteLength === 0 || physicalLine[physicalLine.byteLength - 1] !== JSONL_LF) {
    return new JsonlLineFormatError({ reason: "the physical line is not LF-terminated" })
  }

  const content = physicalLine.subarray(0, physicalLine.byteLength - 1)
  if (content.byteLength === 0) return new JsonlLineFormatError({ reason: "blank line" })
  // LF is the only terminator, so a CR anywhere (including a CRLF ending) is corruption —
  // JSON.parse would otherwise accept a trailing CR as insignificant whitespace.
  if (content.includes(CR)) return new JsonlLineFormatError({ reason: "carriage return in a line" })
  if (content.byteLength >= 3 && BOM.every((byte, at) => content[at] === byte)) {
    return new JsonlLineFormatError({ reason: "byte order mark" })
  }

  const text = errore.try({
    try: () => decoder.decode(content),
    catch: (cause) => new JsonlLineFormatError({ reason: "invalid UTF-8", cause }),
  })
  if (text instanceof Error) return text

  // Boxed inside the `try` on purpose: a bare `unknown | Error` union collapses to
  // `unknown`, which would erase the error arm the caller has to narrow on.
  const parsed = errore.try({
    try: (): JsonlLineValue => ({ value: JSON.parse(text) as unknown }),
    catch: (cause) => new JsonlLineFormatError({ reason: "malformed JSON", cause }),
  })
  if (parsed instanceof Error) return parsed

  const value = parsed.value
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new JsonlLineFormatError({ reason: "a JSONL line must be a JSON object" })
  }
  return { value }
}

/**
 * Encode a chat JSONL header line. Validation is DELEGATED to `entities/chat` — the codec
 * owns bytes, the entity owns schema — so an invalid header can never be serialized.
 */
export function encodeChatHeaderLine(header: ChatHeader): ChatDecodeError | JsonlLineError | Uint8Array {
  const validated = decodeChatHeader(header)
  if (validated instanceof Error) return validated
  return encodeJsonlLine(validated)
}

/** Encode one chat record line, validated through `entities/chat` first. */
export function encodeChatRecordLine(record: ChatRecord): ChatDecodeError | JsonlLineError | Uint8Array {
  const validated = decodeChatRecord(record)
  if (validated instanceof Error) return validated
  return encodeJsonlLine(validated)
}

/** Encode a comments JSONL header line, validated through `entities/pin` first. */
export function encodeCommentsHeaderLine(header: CommentsHeader): PinDecodeError | JsonlLineError | Uint8Array {
  const validated = decodeCommentsHeader(header)
  if (validated instanceof Error) return validated
  return encodeJsonlLine(validated)
}

/** Encode one pin event line, validated through `entities/pin` first. */
export function encodePinEventLine(event: PinEvent): PinDecodeError | JsonlLineError | Uint8Array {
  const validated = decodePinEvent(event)
  if (validated instanceof Error) return validated
  return encodeJsonlLine(validated)
}

export function decodeChatHeaderLine(physicalLine: Uint8Array): JsonlLineError | ChatDecodeError | ChatHeader {
  const parsed = decodeJsonlLine(physicalLine)
  if (parsed instanceof Error) return parsed
  return decodeChatHeader(parsed.value)
}

export function decodeChatRecordLine(physicalLine: Uint8Array): JsonlLineError | ChatDecodeError | ChatRecord {
  const parsed = decodeJsonlLine(physicalLine)
  if (parsed instanceof Error) return parsed
  return decodeChatRecord(parsed.value)
}

export function decodeCommentsHeaderLine(physicalLine: Uint8Array): JsonlLineError | PinDecodeError | CommentsHeader {
  const parsed = decodeJsonlLine(physicalLine)
  if (parsed instanceof Error) return parsed
  return decodeCommentsHeader(parsed.value)
}

export function decodePinEventLine(physicalLine: Uint8Array): JsonlLineError | PinDecodeError | PinEvent {
  const parsed = decodeJsonlLine(physicalLine)
  if (parsed instanceof Error) return parsed
  return decodePinEvent(parsed.value)
}
