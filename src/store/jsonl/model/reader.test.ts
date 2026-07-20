import { describe, expect, test } from "bun:test"

import type { ChatRecord } from "entities/chat"
import type { PageSlug } from "entities/page"
import type { PinEvent } from "entities/pin"
import type { PreparedAppend, PreparedAppendPayload } from "../types"
import {
  encodeChatHeaderLine,
  encodeChatRecordLine,
  encodeCommentsHeaderLine,
  encodeJsonlLine,
  encodePinEventLine,
  sha256Hex,
} from "./line-codec"
import { readChatJsonl, readPinsJsonl } from "./reader"

const PROJECT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10"
const CHAT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11"
const TURN_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20"
const TS = "2026-07-19T10:00:00Z"
const PATH = "chats/0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11.jsonl"

/** Distinct canonical record ids: `...d1<n>` for a single-hex `n`. */
function recordId(n: number): string {
  return `0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d3${n.toString(16)}`
}

function pinId(n: number): string {
  return `0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d4${n.toString(16)}`
}

/** Strips the error arm of an errore union in a test, failing loudly if one is present. */
function unwrap<T>(value: T): Exclude<T, Error> {
  if (value instanceof Error) throw new Error(`unexpected error: ${value.message}`)
  return value as Exclude<T, Error>
}

function chatHeaderBytes(): Uint8Array {
  return unwrap(encodeChatHeaderLine({ kind: "chat", formatVersion: 1, projectId: PROJECT_ID, chatId: CHAT_ID, createdAt: TS }))
}

function userRecord(n: number, text = `message ${n}`): ChatRecord {
  return { kind: "user", recordId: recordId(n), turnId: TURN_ID, text, ts: TS }
}

function recordBytes(record: ChatRecord): Uint8Array {
  return unwrap(encodeChatRecordLine(record))
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

/** Split `bytes` into fixed-size chunks so chunk boundaries fall inside lines and code points. */
function chunksOf(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let at = 0; at < bytes.byteLength; at += size) chunks.push(bytes.subarray(at, Math.min(at + size, bytes.byteLength)))
  return chunks
}

function readChat(bytes: Uint8Array, prepared: PreparedAppendPayload | null = null, chunkSize = 7) {
  return readChatJsonl({ path: PATH, chunks: chunksOf(bytes, chunkSize), prepared })
}

/** A prepared-append descriptor + payload built directly from the intended before/after bytes. */
function preparedAppend(input: { prefix: Uint8Array; append: Uint8Array; recordIds: readonly string[] }): PreparedAppendPayload {
  const descriptor: PreparedAppend = {
    beforeLength: input.prefix.byteLength,
    beforePrefixSha256: sha256Hex(input.prefix),
    appendedPayloadId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d99",
    appendedSha256: sha256Hex(input.append),
    appendedLength: input.append.byteLength,
    recordIds: input.recordIds,
  }
  return { descriptor, bytes: input.append }
}

describe("valid streaming", () => {
  test("a clean chat exposes its header, records, offsets, and prefix hash", () => {
    const bytes = concat([chatHeaderBytes(), recordBytes(userRecord(1)), recordBytes(userRecord(2))])
    const doc = unwrap(readChat(bytes))

    expect(doc.header?.chatId).toBe(CHAT_ID)
    expect(doc.records.map((record) => record.recordId)).toEqual([recordId(1), recordId(2)])
    expect(doc.recordCount).toBe(2)
    expect(doc.validPrefixBytes).toBe(bytes.byteLength)
    expect(doc.totalBytes).toBe(bytes.byteLength)
    expect(doc.prefixSha256).toBe(sha256Hex(bytes))
    expect(doc.tail.kind).toBe("clean")
    expect(doc.mutationLocked).toBe(false)
  })

  test("an empty log is clean and headerless", () => {
    const doc = unwrap(readChatJsonl({ path: PATH, chunks: [], prepared: null }))
    expect(doc.header).toBeNull()
    expect(doc.records).toEqual([])
    expect(doc.totalBytes).toBe(0)
    expect(doc.tail.kind).toBe("clean")
  })

  test("a header-only log is clean", () => {
    const doc = unwrap(readChat(chatHeaderBytes()))
    expect(doc.header).not.toBeNull()
    expect(doc.recordCount).toBe(0)
    expect(doc.tail.kind).toBe("clean")
  })

  test("multibyte UTF-8 split across chunk boundaries decodes correctly", () => {
    const text = "héllo — 🌈 ✨ ünïcodé"
    const bytes = concat([chatHeaderBytes(), recordBytes(userRecord(1, text))])
    for (const chunkSize of [1, 2, 3, 5, 13]) {
      const doc = unwrap(readChatJsonl({ path: PATH, chunks: chunksOf(bytes, chunkSize), prepared: null }))
      const record = doc.records[0]
      expect(record?.kind).toBe("user")
      expect(record !== undefined && record.kind === "user" ? record.text : null).toBe(text)
      expect(doc.tail.kind).toBe("clean")
    }
  })
})

describe("the 1 MiB physical line bound while streaming (§16.4)", () => {
  /** A user record whose serialized object measures exactly `target` bytes (the JSON is ASCII). */
  function recordOfSerializedSize(target: number): ChatRecord {
    const base = JSON.stringify(userRecord(2, "")).length
    return userRecord(2, "x".repeat(target - base))
  }

  test("a record line of exactly 1 MiB streams as a valid record", () => {
    const record = recordOfSerializedSize(1_048_575)
    const bytes = concat([chatHeaderBytes(), recordBytes(record)])
    expect(bytes.byteLength).toBe(chatHeaderBytes().byteLength + 1_048_576)

    const doc = unwrap(readChatJsonl({ path: PATH, chunks: chunksOf(bytes, 64 * 1024), prepared: null }))
    expect(doc.records).toHaveLength(1)
    expect(doc.tail.kind).toBe("clean")
    expect(doc.validPrefixBytes).toBe(bytes.byteLength)
  })

  /** Hand-built, because the encoder refuses to produce an over-bound line at all. */
  function overlongLine(): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify(recordOfSerializedSize(1_048_576)))
    return concat([json, new Uint8Array([0x0a])])
  }

  test("the encoder refuses to produce an over-bound line in the first place", () => {
    expect(encodeJsonlLine(recordOfSerializedSize(1_048_576))).toBeInstanceOf(Error)
  })

  test("a line one byte over the bound is corruption, not a record", () => {
    const overlong = overlongLine()
    expect(overlong.byteLength).toBe(1_048_577)
    const bytes = concat([chatHeaderBytes(), overlong])

    const doc = unwrap(readChatJsonl({ path: PATH, chunks: chunksOf(bytes, 64 * 1024), prepared: null }))
    expect(doc.records).toEqual([])
    expect(doc.tail.kind).toBe("unproven-corrupt-suffix")
    expect(doc.validPrefixBytes).toBe(chatHeaderBytes().byteLength)
  })

  test("an over-bound line followed by a valid record is mid-file corruption", () => {
    const bytes = concat([chatHeaderBytes(), overlongLine(), recordBytes(userRecord(3))])
    expect(readChatJsonl({ path: PATH, chunks: chunksOf(bytes, 64 * 1024), prepared: null })).toBeInstanceOf(Error)
  })
})

describe("unproven corrupt suffix (§11.3 case 2)", () => {
  function expectCorruptSuffix(bytes: Uint8Array, expectedValidPrefix: number, expectedLastRecordId: string | null) {
    const doc = unwrap(readChat(bytes))
    expect(doc.tail.kind).toBe("unproven-corrupt-suffix")
    expect(doc.mutationLocked).toBe(true)
    expect(doc.validPrefixBytes).toBe(expectedValidPrefix)
    if (doc.tail.kind !== "unproven-corrupt-suffix") return
    expect(doc.tail.report.path).toBe(PATH)
    expect(doc.tail.report.lastValidOffset).toBe(expectedValidPrefix)
    expect(doc.tail.report.lastValidRecordId).toBe(expectedLastRecordId)
    expect(doc.tail.report.suffixByteLength).toBe(bytes.byteLength - expectedValidPrefix)
    expect(doc.tail.report.suffixSha256).toBe(sha256Hex(bytes.subarray(expectedValidPrefix)))
  }

  test("valid JSON without a final LF is an uncommitted suffix, not a record", () => {
    const prefix = concat([chatHeaderBytes(), recordBytes(userRecord(1))])
    const partial = recordBytes(userRecord(2)).subarray(0, -1)
    const doc = unwrap(readChat(concat([prefix, partial])))
    expect(doc.records).toHaveLength(1)
    expectCorruptSuffix(concat([prefix, partial]), prefix.byteLength, recordId(1))
  })

  test("a truncated final line is an uncommitted suffix", () => {
    const prefix = concat([chatHeaderBytes(), recordBytes(userRecord(1))])
    const partial = recordBytes(userRecord(2)).subarray(0, 20)
    expectCorruptSuffix(concat([prefix, partial]), prefix.byteLength, recordId(1))
  })

  test("invalid UTF-8 in the final line is a corrupt suffix", () => {
    const prefix = concat([chatHeaderBytes(), recordBytes(userRecord(1))])
    expectCorruptSuffix(concat([prefix, new Uint8Array([0xff, 0xfe, 0x0a])]), prefix.byteLength, recordId(1))
  })

  test("malformed final JSON is a corrupt suffix", () => {
    const prefix = concat([chatHeaderBytes(), recordBytes(userRecord(1))])
    expectCorruptSuffix(concat([prefix, new TextEncoder().encode('{"kind":"user"\n')]), prefix.byteLength, recordId(1))
  })

  test("a trailing blank line is a corrupt suffix", () => {
    const prefix = concat([chatHeaderBytes(), recordBytes(userRecord(1))])
    expectCorruptSuffix(concat([prefix, new Uint8Array([0x0a])]), prefix.byteLength, recordId(1))
  })

  test("several corrupt suffix lines are one suffix", () => {
    const prefix = concat([chatHeaderBytes(), recordBytes(userRecord(1))])
    const junk = new TextEncoder().encode("not json\nstill not json\n{\n")
    expectCorruptSuffix(concat([prefix, junk]), prefix.byteLength, recordId(1))
  })

  test("an oversized suffix line is a corrupt suffix and never grows the line buffer", () => {
    const prefix = concat([chatHeaderBytes(), recordBytes(userRecord(1))])
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1)
    oversized.fill(0x78)
    oversized[oversized.length - 1] = 0x0a
    expectCorruptSuffix(concat([prefix, oversized]), prefix.byteLength, recordId(1))
  })

  test("an invalid header alone leaves a zero-length valid prefix", () => {
    const bytes = new TextEncoder().encode('{"kind":"chat","formatVersion":2}\n')
    const doc = unwrap(readChat(bytes))
    expect(doc.header).toBeNull()
    expect(doc.validPrefixBytes).toBe(0)
    expect(doc.tail.kind).toBe("unproven-corrupt-suffix")
    if (doc.tail.kind !== "unproven-corrupt-suffix") return
    expect(doc.tail.report.lastValidRecordId).toBeNull()
  })
})

describe("mid-file corruption (§11.3 case 3)", () => {
  test("a valid record after corrupt bytes is a hard error", () => {
    const bytes = concat([chatHeaderBytes(), recordBytes(userRecord(1)), new TextEncoder().encode("garbage\n"), recordBytes(userRecord(2))])
    const failed = readChat(bytes)
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).name).toBe("JsonlMidFileCorruptionError")
  })

  test("a blank line followed by a valid record is a hard error", () => {
    const bytes = concat([chatHeaderBytes(), recordBytes(userRecord(1)), new Uint8Array([0x0a]), recordBytes(userRecord(2))])
    expect(readChat(bytes)).toBeInstanceOf(Error)
  })

  test("an invalid header followed by valid records is a hard error", () => {
    const bytes = concat([new TextEncoder().encode('{"kind":"chat"}\n'), recordBytes(userRecord(1))])
    expect(readChat(bytes)).toBeInstanceOf(Error)
  })

  test("a duplicate recordId in one file is an identity violation", () => {
    const bytes = concat([chatHeaderBytes(), recordBytes(userRecord(1)), recordBytes(userRecord(1, "again"))])
    const failed = readChat(bytes)
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toContain("duplicate recordId")
  })

  test("a duplicate recordId is a hard error even under a matching prepared plan", () => {
    const prefix = concat([chatHeaderBytes(), recordBytes(userRecord(1))])
    const append = recordBytes(userRecord(1, "again"))
    const prepared = preparedAppend({ prefix, append, recordIds: [recordId(1)] })
    expect(readChat(concat([prefix, append]), prepared)).toBeInstanceOf(Error)
  })

  test("a mid-file corrupt store is never exposed as a writable prefix", () => {
    const bytes = concat([chatHeaderBytes(), new TextEncoder().encode("garbage\n"), recordBytes(userRecord(2))])
    expect(readChat(bytes)).toBeInstanceOf(Error)
  })
})

describe("transaction-proven append interruption (§11.3 case 1 / §4.4)", () => {
  const prefix = concat([chatHeaderBytes(), recordBytes(userRecord(1))])
  const append = concat([recordBytes(userRecord(2)), recordBytes(userRecord(3))])
  const plan = preparedAppend({ prefix, append, recordIds: [recordId(2), recordId(3)] })

  test("an empty remainder proves the append never started", () => {
    const doc = unwrap(readChat(prefix, plan))
    expect(doc.tail.kind).toBe("transaction-proven-append-interruption")
    if (doc.tail.kind !== "transaction-proven-append-interruption") return
    expect(doc.tail.append.state).toBe("empty")
    expect(doc.tail.append.truncateTo).toBeNull()
    expect(doc.mutationLocked).toBe(false)
  })

  test("the complete planned append proves success before acknowledgement", () => {
    const doc = unwrap(readChat(concat([prefix, append]), plan))
    expect(doc.tail.kind).toBe("transaction-proven-append-interruption")
    if (doc.tail.kind !== "transaction-proven-append-interruption") return
    expect(doc.tail.append.state).toBe("complete")
    expect(doc.tail.append.truncateTo).toBeNull()
    expect(doc.records).toHaveLength(3)
  })

  test("an exact leading prefix of the planned append authorizes the sole automatic truncation", () => {
    const partial = append.subarray(0, append.byteLength - 12)
    const doc = unwrap(readChat(concat([prefix, partial]), plan))
    expect(doc.tail.kind).toBe("transaction-proven-append-interruption")
    if (doc.tail.kind !== "transaction-proven-append-interruption") return
    expect(doc.tail.append.state).toBe("leading-prefix")
    expect(doc.tail.append.truncateTo).toBe(prefix.byteLength)
    expect(doc.tail.append.observedSuffixBytes).toBe(partial.byteLength)
  })

  test("a single-byte leading prefix still proves a partial append", () => {
    const doc = unwrap(readChat(concat([prefix, append.subarray(0, 1)]), plan))
    expect(doc.tail.kind).toBe("transaction-proven-append-interruption")
  })
})

describe("only an exactly matching prepared plan can trigger truncation (§16.4)", () => {
  const prefix = concat([chatHeaderBytes(), recordBytes(userRecord(1))])
  const append = concat([recordBytes(userRecord(2)), recordBytes(userRecord(3))])
  const partial = append.subarray(0, append.byteLength - 12)
  const file = concat([prefix, partial])

  function expectRefusal(prepared: PreparedAppendPayload) {
    const doc = unwrap(readChatJsonl({ path: PATH, chunks: chunksOf(file, 7), prepared }))
    expect(doc.tail.kind).toBe("unproven-corrupt-suffix")
    expect(doc.mutationLocked).toBe(true)
  }

  test("a wrong base length refuses to truncate, even with a self-consistent prefix hash", () => {
    expectRefusal(preparedAppend({ prefix: prefix.subarray(0, prefix.byteLength - 1), append, recordIds: [recordId(2)] }))
  })

  test("a wrong prefix hash refuses to truncate", () => {
    const plan = preparedAppend({ prefix, append, recordIds: [recordId(2)] })
    expectRefusal({ ...plan, descriptor: { ...plan.descriptor, beforePrefixSha256: sha256Hex(new Uint8Array([1, 2, 3])) } })
  })

  test("a wrong append hash refuses to truncate", () => {
    const plan = preparedAppend({ prefix, append, recordIds: [recordId(2)] })
    expectRefusal({ ...plan, descriptor: { ...plan.descriptor, appendedSha256: sha256Hex(new Uint8Array([4, 5, 6])) } })
  })

  test("a declared length that disagrees with the payload refuses to truncate", () => {
    const plan = preparedAppend({ prefix, append, recordIds: [recordId(2)] })
    expectRefusal({ ...plan, descriptor: { ...plan.descriptor, appendedLength: append.byteLength + 1 } })
  })

  test("trailing bytes that are not a leading prefix refuse to truncate", () => {
    const flipped = new Uint8Array(partial)
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff
    const plan = preparedAppend({ prefix, append, recordIds: [recordId(2)] })
    const doc = unwrap(readChatJsonl({ path: PATH, chunks: chunksOf(concat([prefix, flipped]), 7), prepared: plan }))
    expect(doc.tail.kind).toBe("unproven-corrupt-suffix")
  })

  test("trailing bytes longer than the planned append refuse to truncate", () => {
    const longer = concat([append, new TextEncoder().encode("extra\n")])
    const plan = preparedAppend({ prefix, append, recordIds: [recordId(2)] })
    const doc = unwrap(readChatJsonl({ path: PATH, chunks: chunksOf(concat([prefix, longer]), 7), prepared: plan }))
    expect(doc.tail.kind).toBe("unproven-corrupt-suffix")
  })

  test("a file truncated before the recorded base length refuses to truncate", () => {
    const plan = preparedAppend({ prefix, append, recordIds: [recordId(2)] })
    const short = prefix.subarray(0, prefix.byteLength - 5)
    const doc = unwrap(readChatJsonl({ path: PATH, chunks: chunksOf(short, 7), prepared: plan }))
    expect(doc.tail.kind).toBe("unproven-corrupt-suffix")
  })
})

describe("pins", () => {
  function pinsHeaderBytes(): Uint8Array {
    return unwrap(encodeCommentsHeaderLine({ kind: "pins", formatVersion: 1, projectId: PROJECT_ID, pageSlug: "home" as PageSlug }))
  }

  function eventBytes(event: PinEvent): Uint8Array {
    return unwrap(encodePinEventLine(event))
  }

  const created: PinEvent = {
    kind: "pin:created",
    recordId: recordId(1),
    pinId: pinId(1),
    element: "title",
    fx: 0.1,
    fy: 0.2,
    text: "tighten",
    ts: TS,
  }
  const resolved: PinEvent = { kind: "pin:status", recordId: recordId(2), pinId: pinId(1), status: "resolved", turnId: TURN_ID, ts: TS }

  test("a valid comments log streams its events", () => {
    const doc = unwrap(readPinsJsonl({ path: "pages/home/comments.jsonl", chunks: [concat([pinsHeaderBytes(), eventBytes(created), eventBytes(resolved)])], prepared: null }))
    expect(doc.header?.pageSlug).toBe("home" as PageSlug)
    expect(doc.records).toHaveLength(2)
    expect(doc.tail.kind).toBe("clean")
  })

  test("a status event before its create event is a reference violation in the prefix", () => {
    const orphan: PinEvent = { kind: "pin:status", recordId: recordId(3), pinId: pinId(2), status: "open", turnId: TURN_ID, ts: TS }
    const failed = readPinsJsonl({ path: "pages/home/comments.jsonl", chunks: [concat([pinsHeaderBytes(), eventBytes(orphan)])], prepared: null })
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).name).toBe("JsonlMidFileCorruptionError")
  })

  test("a second create event for one pinId is a reference violation in the prefix", () => {
    const again: PinEvent = { ...created, recordId: recordId(4) }
    const failed = readPinsJsonl({ path: "pages/home/comments.jsonl", chunks: [concat([pinsHeaderBytes(), eventBytes(created), eventBytes(again)])], prepared: null })
    expect(failed).toBeInstanceOf(Error)
  })
})
