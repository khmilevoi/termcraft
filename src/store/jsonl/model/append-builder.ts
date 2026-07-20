import crypto from "node:crypto"
import * as errore from "errore"

import type { ChatDecodeError, ChatRecord } from "entities/chat"
import type { PinDecodeError, PinEvent } from "entities/pin"
import { uuidv7 } from "infrastructure/uuid"
import type { AppendBuilderDeps, JsonlRecordIdentity, PreparedAppendPayload, Sha256Hex } from "../types"
import { type JsonlLineError, encodeChatRecordLine, encodePinEventLine, sha256Hex } from "./line-codec"

/**
 * A prepared append could not be built. Preparation happens BEFORE any target changes
 * (turn-durability §4.3 step 2), so every rejection here costs nothing on disk.
 */
export class PreparedAppendError extends errore.createTaggedError({
  name: "PreparedAppendError",
  message: "prepared append rejected: $reason",
}) {}

const SHA256_HEX = /^[0-9a-f]{64}$/

/** The validated prefix a prepared append is built against — the reader's own output. */
export interface AppendBase {
  readonly length: number
  readonly prefixSha256: Sha256Hex
}

/** The real binding for the injected UUIDv7 seam. */
export function defaultAppendBuilderDeps(): AppendBuilderDeps {
  return { newPayloadId: uuidv7 }
}

export interface BuildPreparedAppendInput<R extends JsonlRecordIdentity, E extends Error> {
  readonly before: AppendBase
  readonly records: readonly R[]
  /**
   * Serialize one record as a physical line, delegating schema validation to `entities/`.
   * `E` is that entity's decode error, so the builder's own return type names every way the
   * preparation can fail.
   */
  readonly encodeLine: (record: R) => JsonlLineError | E | Uint8Array
  readonly domainIdentity?: string
  readonly deps: AppendBuilderDeps
}

/**
 * Build the prepared append of turn-durability §4.4: serialize complete bounded records with
 * their terminating LF, record the exact before length and prefix hash the append is bound
 * to, and hash the resulting payload. The descriptor plus these bytes are what recovery
 * later replays — and the only thing that can prove an interrupted append (§11.3 case 1).
 *
 * Every rejection is returned as a value before a single byte is written: an oversized line,
 * a schema-invalid record, a duplicate `recordId` inside the batch, or a malformed
 * before-state. Duplicate ids ACROSS the file are not checkable here (the batch does not see
 * the file); the streaming reader enforces file-wide uniqueness on the prefix it validates.
 */
export function buildPreparedAppend<R extends JsonlRecordIdentity, E extends Error>(
  input: BuildPreparedAppendInput<R, E>,
): PreparedAppendError | JsonlLineError | E | PreparedAppendPayload {
  if (!Number.isSafeInteger(input.before.length) || input.before.length < 0) {
    return new PreparedAppendError({ reason: `before length ${input.before.length} is not a non-negative integer` })
  }
  if (!SHA256_HEX.test(input.before.prefixSha256)) {
    return new PreparedAppendError({ reason: "before prefix hash is not a lowercase-hex SHA-256" })
  }
  if (input.records.length === 0) {
    return new PreparedAppendError({ reason: "an append operation must append at least one record" })
  }

  const recordIds: string[] = []
  const lines: Uint8Array[] = []
  let appendedLength = 0

  for (const record of input.records) {
    if (recordIds.includes(record.recordId)) {
      return new PreparedAppendError({ reason: `duplicate recordId ${record.recordId} in one prepared append` })
    }
    const line = input.encodeLine(record)
    if (line instanceof Error) return line
    recordIds.push(record.recordId)
    lines.push(line)
    appendedLength += line.byteLength
  }

  const bytes = new Uint8Array(appendedLength)
  let at = 0
  for (const line of lines) {
    bytes.set(line, at)
    at += line.byteLength
  }

  return {
    bytes,
    descriptor: {
      beforeLength: input.before.length,
      beforePrefixSha256: input.before.prefixSha256,
      appendedPayloadId: input.deps.newPayloadId(),
      appendedSha256: sha256Hex(bytes),
      appendedLength,
      recordIds,
      ...(input.domainIdentity === undefined ? {} : { domainIdentity: input.domainIdentity }),
    },
  }
}

/** Prepare a chat append (storage-identity §11.2 chat schemas). */
export function buildChatAppend(input: {
  before: AppendBase
  records: readonly ChatRecord[]
  domainIdentity?: string
  deps: AppendBuilderDeps
}): PreparedAppendError | JsonlLineError | ChatDecodeError | PreparedAppendPayload {
  return buildPreparedAppend({ ...input, encodeLine: encodeChatRecordLine })
}

/** Prepare a comments append (storage-identity §11.2 pin events). */
export function buildPinAppend(input: {
  before: AppendBase
  events: readonly PinEvent[]
  domainIdentity?: string
  deps: AppendBuilderDeps
}): PreparedAppendError | JsonlLineError | PinDecodeError | PreparedAppendPayload {
  return buildPreparedAppend({ ...input, records: input.events, encodeLine: encodePinEventLine })
}

/**
 * turn-durability §4.4: "computes the exact full-file after image". Streams the target's
 * first `beforeLength` bytes and the prepared append through one digest, so the after image
 * costs no more memory than a chunk — a 64 MiB chat is never materialized.
 */
export function computeAfterImage(input: {
  chunks: Iterable<Uint8Array>
  beforeLength: number
  append: Uint8Array
}): PreparedAppendError | { size: number; sha256: Sha256Hex } {
  const hash = crypto.createHash("sha256")
  let consumed = 0
  for (const chunk of input.chunks) {
    if (consumed >= input.beforeLength) break
    const take = Math.min(chunk.byteLength, input.beforeLength - consumed)
    hash.update(chunk.subarray(0, take))
    consumed += take
  }
  if (consumed < input.beforeLength) {
    return new PreparedAppendError({ reason: `the source holds ${consumed} bytes but the append is bound to ${input.beforeLength}` })
  }

  hash.update(input.append)
  return { size: input.beforeLength + input.append.byteLength, sha256: hash.digest("hex") }
}
