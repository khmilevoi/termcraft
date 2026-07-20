import { describe, expect, test } from "bun:test"

import type { ChatRecord } from "entities/chat"
import type { PinEvent } from "entities/pin"
import type { AppendBuilderDeps } from "../types"
import { buildChatAppend, buildPinAppend, computeAfterImage } from "./append-builder"
import { encodeChatHeaderLine, encodeChatRecordLine, sha256Hex } from "./line-codec"

const PROJECT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10"
const CHAT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11"
const TURN_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20"
const PAYLOAD_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d99"
const TS = "2026-07-19T10:00:00Z"

function recordId(n: number): string {
  return `0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d3${n.toString(16)}`
}

/** Strips the error arm of an errore union in a test, failing loudly if one is present. */
function unwrap<T>(value: T): Exclude<T, Error> {
  if (value instanceof Error) throw new Error(`unexpected error: ${value.message}`)
  return value as Exclude<T, Error>
}

function userRecord(n: number, text = `message ${n}`): ChatRecord {
  return { kind: "user", recordId: recordId(n), turnId: TURN_ID, text, ts: TS }
}

/** A deterministic payload-id mint — the impure UUIDv7 seam is injected, never called for real in tests. */
function fakeDeps(id = PAYLOAD_ID): AppendBuilderDeps {
  return { newPayloadId: () => id }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

const prefix = concat([
  unwrap(encodeChatHeaderLine({ kind: "chat", formatVersion: 1, projectId: PROJECT_ID, chatId: CHAT_ID, createdAt: TS })),
  unwrap(encodeChatRecordLine(userRecord(1))),
])

const before = { length: prefix.byteLength, prefixSha256: sha256Hex(prefix) }

describe("buildChatAppend", () => {
  test("produces the §4.4 descriptor and the exact append bytes", () => {
    const built = unwrap(buildChatAppend({ before, records: [userRecord(2), userRecord(3)], deps: fakeDeps() }))
    const expected = concat([unwrap(encodeChatRecordLine(userRecord(2))), unwrap(encodeChatRecordLine(userRecord(3)))])

    expect(built.bytes).toEqual(expected)
    expect(built.descriptor).toEqual({
      beforeLength: prefix.byteLength,
      beforePrefixSha256: sha256Hex(prefix),
      appendedPayloadId: PAYLOAD_ID,
      appendedSha256: sha256Hex(expected),
      appendedLength: expected.byteLength,
      recordIds: [recordId(2), recordId(3)],
    })
  })

  test("carries an optional domain identity when one is supplied", () => {
    const built = unwrap(buildChatAppend({ before, records: [userRecord(2)], domainIdentity: TURN_ID, deps: fakeDeps() }))
    expect(built.descriptor.domainIdentity).toBe(TURN_ID)
  })

  test("every appended line ends with exactly one LF", () => {
    const built = unwrap(buildChatAppend({ before, records: [userRecord(2), userRecord(3)], deps: fakeDeps() }))
    const lfCount = built.bytes.reduce((count, byte) => (byte === 0x0a ? count + 1 : count), 0)
    expect(lfCount).toBe(2)
    expect(built.bytes[built.bytes.length - 1]).toBe(0x0a)
  })

  test("an empty batch is refused — an append operation must append something", () => {
    expect(buildChatAppend({ before, records: [], deps: fakeDeps() })).toBeInstanceOf(Error)
  })

  test("a duplicate recordId inside one batch is refused before any preparation", () => {
    const rejected = buildChatAppend({ before, records: [userRecord(2), userRecord(2, "again")], deps: fakeDeps() })
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).toContain("duplicate recordId")
  })

  test("an oversized record is refused before any mutation, reporting measured vs allowed", () => {
    const huge = userRecord(2, "x".repeat(1_048_576))
    const rejected = buildChatAppend({ before, records: [huge], deps: fakeDeps() })
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).name).toBe("JsonlLineTooLongError")
  })

  test("a schema-invalid record is refused by the entity decoder", () => {
    const rejected = buildChatAppend({ before, records: [{ ...userRecord(2), ts: "yesterday" } as ChatRecord], deps: fakeDeps() })
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).name).toBe("ChatDecodeError")
  })

  test("a malformed before-state is refused", () => {
    expect(buildChatAppend({ before: { length: -1, prefixSha256: before.prefixSha256 }, records: [userRecord(2)], deps: fakeDeps() })).toBeInstanceOf(Error)
    expect(buildChatAppend({ before: { length: 10, prefixSha256: "NOTAHASH" }, records: [userRecord(2)], deps: fakeDeps() })).toBeInstanceOf(Error)
  })
})

describe("buildPinAppend", () => {
  test("prepares pin events through the pin decoder", () => {
    const event: PinEvent = { kind: "pin:status", recordId: recordId(5), pinId: recordId(6), status: "resolved", turnId: TURN_ID, ts: TS }
    const built = unwrap(buildPinAppend({ before, events: [event], deps: fakeDeps() }))
    expect(built.descriptor.recordIds).toEqual([recordId(5)])
    expect(built.descriptor.appendedLength).toBe(built.bytes.byteLength)
  })

  test("a pin event missing both actionId and turnId is refused", () => {
    const event = { kind: "pin:status", recordId: recordId(5), pinId: recordId(6), status: "resolved", ts: TS } as PinEvent
    expect(buildPinAppend({ before, events: [event], deps: fakeDeps() })).toBeInstanceOf(Error)
  })
})

describe("computeAfterImage", () => {
  test("hashes the recorded before prefix followed by the append", () => {
    const built = unwrap(buildChatAppend({ before, records: [userRecord(2)], deps: fakeDeps() }))
    const image = unwrap(computeAfterImage({ chunks: [prefix], beforeLength: before.length, append: built.bytes }))
    expect(image.size).toBe(prefix.byteLength + built.bytes.byteLength)
    expect(image.sha256).toBe(sha256Hex(concat([prefix, built.bytes])))
  })

  test("ignores bytes beyond the recorded before length", () => {
    const built = unwrap(buildChatAppend({ before, records: [userRecord(2)], deps: fakeDeps() }))
    const withGarbage = concat([prefix, new TextEncoder().encode("uncommitted")])
    const image = unwrap(computeAfterImage({ chunks: [withGarbage], beforeLength: before.length, append: built.bytes }))
    expect(image.sha256).toBe(sha256Hex(concat([prefix, built.bytes])))
  })

  test("refuses a source shorter than the recorded before length", () => {
    const built = unwrap(buildChatAppend({ before, records: [userRecord(2)], deps: fakeDeps() }))
    expect(computeAfterImage({ chunks: [prefix.subarray(0, 4)], beforeLength: before.length, append: built.bytes })).toBeInstanceOf(Error)
  })
})
