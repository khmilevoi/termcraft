import { describe, expect, test } from "bun:test"

import type { ChatUserRecord } from "entities/chat"
import type { PinCreatedEvent } from "entities/pin"
import type { PageSlug } from "entities/page"
import {
  JSONL_MAX_PHYSICAL_LINE_BYTES,
  JSONL_MAX_SERIALIZED_OBJECT_BYTES,
  decodeChatHeaderLine,
  decodeChatRecordLine,
  decodeCommentsHeaderLine,
  decodeJsonlLine,
  decodePinEventLine,
  encodeChatHeaderLine,
  encodeChatRecordLine,
  encodeCommentsHeaderLine,
  encodeJsonlLine,
  encodePinEventLine,
  sha256Hex,
} from "./line-codec"

const PROJECT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10"
const CHAT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11"
const RECORD_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d12"
const TURN_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d13"
const PIN_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d14"
const TS = "2026-07-19T10:00:00Z"

function userRecord(text: string): ChatUserRecord {
  return { kind: "user", recordId: RECORD_ID, turnId: TURN_ID, text, ts: TS }
}

/** Strips the error arm of an errore union in a test, failing loudly if one is present. */
function unwrap<T>(value: T): Exclude<T, Error> {
  if (value instanceof Error) throw new Error(`unexpected error: ${value.message}`)
  return value as Exclude<T, Error>
}

describe("physical line format", () => {
  test("a line is UTF-8, has no BOM, and ends with exactly one LF", () => {
    const line = unwrap(encodeChatHeaderLine({ kind: "chat", formatVersion: 1, projectId: PROJECT_ID, chatId: CHAT_ID, createdAt: TS }))
    expect(line[line.length - 1]).toBe(0x0a)
    expect(line.subarray(0, 3)).not.toEqual(new Uint8Array([0xef, 0xbb, 0xbf]))
    expect(new TextDecoder("utf-8", { fatal: true }).decode(line.subarray(0, -1))).toContain('"kind":"chat"')
  })

  test("no raw LF or CR can hide inside a serialized value", () => {
    const line = unwrap(encodeJsonlLine({ text: "a\nb\r\nc" }))
    const lfCount = line.reduce((count, byte) => (byte === 0x0a ? count + 1 : count), 0)
    expect(lfCount).toBe(1)
    expect(line.includes(0x0d)).toBe(false)
  })
})

describe("the 1 MiB physical line bound (storage-identity §11.1)", () => {
  /** Pad `text` so the serialized object measures exactly `target` bytes (the JSON is ASCII). */
  function recordOfSerializedSize(target: number): ChatUserRecord {
    const base = JSON.stringify(userRecord("")).length
    return userRecord("x".repeat(target - base))
  }

  test("a physical line of exactly 1 MiB passes", () => {
    const record = recordOfSerializedSize(JSONL_MAX_SERIALIZED_OBJECT_BYTES)
    const line = unwrap(encodeChatRecordLine(record))
    expect(line.byteLength).toBe(JSONL_MAX_PHYSICAL_LINE_BYTES)
    expect(unwrap(decodeChatRecordLine(line))).toEqual(record)
  })

  test("one byte over is rejected, reporting measured vs allowed", () => {
    const record = recordOfSerializedSize(JSONL_MAX_SERIALIZED_OBJECT_BYTES + 1)
    const rejected = encodeChatRecordLine(record)
    expect(rejected).toBeInstanceOf(Error)
    if (!(rejected instanceof Error)) return
    expect(rejected.name).toBe("JsonlLineTooLongError")
    expect((rejected as unknown as { measured: number }).measured).toBe(JSONL_MAX_PHYSICAL_LINE_BYTES + 1)
    expect((rejected as unknown as { allowed: number }).allowed).toBe(JSONL_MAX_PHYSICAL_LINE_BYTES)
  })

  test("decoding rejects an oversized physical line the same way", () => {
    const oversized = new Uint8Array(JSONL_MAX_PHYSICAL_LINE_BYTES + 1)
    oversized.fill(0x20)
    oversized[oversized.length - 1] = 0x0a
    const rejected = decodeJsonlLine(oversized)
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).name).toBe("JsonlLineTooLongError")
  })
})

describe("decodeJsonlLine rejections", () => {
  const cases: ReadonlyArray<readonly [string, Uint8Array]> = [
    ["a line without its terminating LF", new TextEncoder().encode('{"a":1}')],
    ["a blank line", new Uint8Array([0x0a])],
    ["a whitespace-only line", new TextEncoder().encode("   \n")],
    ["a CRLF line ending", new TextEncoder().encode('{"a":1}\r\n')],
    ["a BOM", new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a])],
    ["invalid UTF-8", new Uint8Array([0xff, 0xfe, 0x0a])],
    ["malformed JSON", new TextEncoder().encode('{"a":\n')],
    ["a non-object JSON value", new TextEncoder().encode("123\n")],
    ["a JSON array", new TextEncoder().encode("[]\n")],
    ["JSON null", new TextEncoder().encode("null\n")],
  ]

  for (const [label, bytes] of cases) {
    test(`${label} is corruption`, () => {
      expect(decodeJsonlLine(bytes)).toBeInstanceOf(Error)
    })
  }

  test("a well-formed object line yields its parsed value", () => {
    const parsed = decodeJsonlLine(new TextEncoder().encode('{"a":1}\n'))
    expect(parsed).not.toBeInstanceOf(Error)
    if (parsed instanceof Error) return
    expect(parsed.value).toEqual({ a: 1 })
  })
})

describe("validation is delegated to the entity decoders", () => {
  test("a chat record with a non-canonical recordId is refused before serialization", () => {
    const rejected = encodeChatRecordLine({ ...userRecord("hi"), recordId: "NOT-A-UUID" })
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).name).toBe("ChatDecodeError")
  })

  test("a schema-invalid chat record line decodes to a ChatDecodeError", () => {
    const line = unwrap(encodeJsonlLine({ kind: "user", recordId: RECORD_ID, turnId: TURN_ID, text: "hi", ts: "yesterday" }))
    const rejected = decodeChatRecordLine(line)
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).name).toBe("ChatDecodeError")
  })

  test("a pin event with both actionId and turnId is refused", () => {
    const rejected = encodePinEventLine({
      kind: "pin:status",
      recordId: RECORD_ID,
      pinId: PIN_ID,
      status: "resolved",
      actionId: TURN_ID,
      turnId: TURN_ID,
      ts: TS,
    })
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).name).toBe("PinDecodeError")
  })
})

describe("round trips", () => {
  test("every chat record kind survives encode → decode", () => {
    const records = [
      userRecord("hello"),
      {
        kind: "agent" as const,
        recordId: RECORD_ID,
        turnId: TURN_ID,
        text: "done",
        changedPages: ["home" as PageSlug],
        warnings: [{ kind: "lint", message: "unused import" }],
        ts: TS,
      },
      { kind: "system:error" as const, recordId: RECORD_ID, turnId: TURN_ID, outcome: "stale" as const, text: "stale", ts: TS },
      { kind: "system:cancelled" as const, recordId: RECORD_ID, turnId: TURN_ID, text: "cancelled", ts: TS },
    ]
    for (const record of records) {
      expect(unwrap(decodeChatRecordLine(unwrap(encodeChatRecordLine(record))))).toEqual(record)
    }
  })

  test("the comments header and pin events survive encode → decode", () => {
    const header = { kind: "pins" as const, formatVersion: 1 as const, projectId: PROJECT_ID, pageSlug: "home" as PageSlug }
    expect(unwrap(decodeCommentsHeaderLine(unwrap(encodeCommentsHeaderLine(header))))).toEqual(header)

    const created: PinCreatedEvent = {
      kind: "pin:created",
      recordId: RECORD_ID,
      pinId: PIN_ID,
      element: "title",
      fx: 0.25,
      fy: 0.5,
      text: "tighten the spacing",
      ts: TS,
    }
    expect(unwrap(decodePinEventLine(unwrap(encodePinEventLine(created))))).toEqual(created)
  })

  test("a chat header round trips and a pins header is not accepted as one", () => {
    const header = { kind: "chat" as const, formatVersion: 1 as const, projectId: PROJECT_ID, chatId: CHAT_ID, createdAt: TS }
    expect(unwrap(decodeChatHeaderLine(unwrap(encodeChatHeaderLine(header))))).toEqual(header)
    const pins = unwrap(encodeCommentsHeaderLine({ kind: "pins", formatVersion: 1, projectId: PROJECT_ID, pageSlug: "home" as PageSlug }))
    expect(decodeChatHeaderLine(pins)).toBeInstanceOf(Error)
  })
})

describe("sha256Hex", () => {
  test("digests the empty input to the canonical lowercase hex value", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  })
})
