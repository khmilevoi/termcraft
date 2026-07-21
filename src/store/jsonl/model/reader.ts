import crypto from "node:crypto";

import * as errore from "errore";

import type { ChatHeader, ChatRecord } from "entities/chat";
import { decodeChatHeader, decodeChatRecord } from "entities/chat";
import type { CommentsHeader, PinEvent } from "entities/pin";
import { decodeCommentsHeader, decodePinEvent, foldPins } from "entities/pin";

import type {
  AppendInterruption,
  JsonlDocument,
  JsonlRecordIdentity,
  PreparedAppendPayload,
  TailClassification,
} from "../types";
import {
  JSONL_LF,
  JSONL_MAX_PHYSICAL_LINE_BYTES,
  JsonlLineTooLongError,
  decodeJsonlLine,
  sha256Hex,
} from "./line-codec";

/**
 * storage-identity §11.3 case 3: at least one complete schema-valid record occurs after the
 * corruption, or an identity/reference violation occurs inside the otherwise valid prefix.
 * This is a HARD error — the store is not partially opened and termcraft offers no truncate
 * operation, because truncation would discard known valid records.
 */
export class JsonlMidFileCorruptionError extends errore.createTaggedError({
  name: "JsonlMidFileCorruptionError",
  message: "mid-file corruption in $path at byte $offset: $reason",
}) {}

/**
 * A decoder pair for one JSONL document kind. The reader owns bytes, offsets, and the repair
 * classification; schema and identity validation stay in `entities/`.
 */
export interface JsonlCodec<H extends object, R extends JsonlRecordIdentity> {
  readonly decodeHeader: (value: unknown) => H | Error;
  readonly decodeRecord: (value: unknown) => R | Error;
  /**
   * An optional whole-prefix integrity rule (pins: the §11.2 fold rules). A violation is
   * §11.3 case 3, because it sits inside the otherwise valid prefix.
   */
  readonly checkPrefix?: (records: readonly R[]) => Error | null;
}

export interface ReadJsonlInput<H extends object, R extends JsonlRecordIdentity> {
  readonly path: string;
  /** The file's bytes from byte zero, in arbitrary chunking — a boundary may split a code point. */
  readonly chunks: Iterable<Uint8Array>;
  readonly codec: JsonlCodec<H, R>;
  /**
   * The prepared append that names this file, when a transaction journal holds one. It is the
   * ONLY thing that can classify a tail as an append interruption, and therefore the only
   * thing that can authorize truncation (§11.3 case 1).
   */
  readonly prepared?: PreparedAppendPayload | null;
}

/** One complete physical line lifted out of the stream. */
interface RawLine {
  readonly start: number;
  /** Offset just past the terminating LF. */
  readonly end: number;
  /** `null` when the line exceeded the physical bound and its bytes were dropped unread. */
  readonly bytes: Uint8Array | null;
  readonly length: number;
}

function concatBytes(pieces: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.byteLength;
  }
  return out;
}

/**
 * Assembles one physical line from arbitrary chunk slices. Retained bytes are capped at the
 * §11.1 bound: a line one byte over is dropped rather than buffered, so an oversized or
 * hostile suffix can never grow the reader's memory (§16.4 "fails without allocation
 * growth"). A dropped line is corruption by definition, so nothing is lost by not keeping it.
 */
class LineBuffer {
  private pieces: Uint8Array[] = [];
  private retained = 0;
  private logical = 0;
  private dropped = false;

  push(slice: Uint8Array): void {
    this.logical += slice.byteLength;
    if (this.dropped) return;
    if (this.retained + slice.byteLength > JSONL_MAX_PHYSICAL_LINE_BYTES) {
      this.dropped = true;
      this.pieces = [];
      this.retained = 0;
      return;
    }
    this.pieces.push(slice);
    this.retained += slice.byteLength;
  }

  get pending(): number {
    return this.logical;
  }

  take(start: number, end: number): RawLine {
    const line: RawLine = {
      start,
      end,
      length: this.logical,
      bytes: this.dropped ? null : concatBytes(this.pieces, this.retained),
    };
    this.pieces = [];
    this.retained = 0;
    this.logical = 0;
    this.dropped = false;
    return line;
  }
}

/** Everything the scan mutates, kept in one object so no narrowing spans a closure. */
interface ScanState<H, R> {
  offset: number;
  lineStart: number;
  lineIndex: number;
  header: H | null;
  records: R[];
  validPrefixBytes: number;
  lastValidRecordId: string | null;
  firstCorruption: { offset: number; reason: string } | null;
  validRecordAfterCorruption: { offset: number } | null;
  /** Reset at every accepted line, so at end of stream it covers exactly the §11.3 suffix. */
  tailHash: crypto.Hash;
  trailingRetained: number;
  trailingTotal: number;
}

/**
 * Stream one JSONL file from byte zero, exposing only complete LF-terminated valid records,
 * and classify its tail into exactly the three cases of storage-identity §11.3. Case 3
 * (mid-file corruption) is returned as a hard error rather than a document, because it must
 * never yield a partially opened store.
 */
export function readJsonlDocument<H extends object, R extends JsonlRecordIdentity>(
  input: ReadJsonlInput<H, R>,
): JsonlMidFileCorruptionError | JsonlDocument<H, R> {
  const prepared = input.prepared ?? null;
  const descriptor = prepared?.descriptor ?? null;

  const prefixHash = crypto.createHash("sha256");
  // Hashes exactly the first `beforeLength` bytes, independently of where the valid prefix
  // ends — §11.3 case 1 is decided on raw offsets, not on the reader's record boundaries.
  const planHash = descriptor === null ? null : crypto.createHash("sha256");
  // Retains at most one byte more than the planned append: enough to prove "longer than
  // planned" without ever holding an unbounded tail.
  const trailingCap = descriptor === null ? 0 : descriptor.appendedLength + 1;
  const trailingPieces: Uint8Array[] = [];

  const seenRecordIds = new Set<string>();
  const line = new LineBuffer();
  const state: ScanState<H, R> = {
    offset: 0,
    lineStart: 0,
    lineIndex: 0,
    header: null,
    records: [],
    validPrefixBytes: 0,
    lastValidRecordId: null,
    firstCorruption: null,
    validRecordAfterCorruption: null,
    tailHash: crypto.createHash("sha256"),
    trailingRetained: 0,
    trailingTotal: 0,
  };

  function captureTrailing(slice: Uint8Array): void {
    state.trailingTotal += slice.byteLength;
    if (state.trailingRetained >= trailingCap) return;
    const take = Math.min(slice.byteLength, trailingCap - state.trailingRetained);
    trailingPieces.push(slice.subarray(0, take));
    state.trailingRetained += take;
  }

  /** Feed one slice through every raw-byte consumer, then advance the stream offset. */
  function consumeRaw(slice: Uint8Array): void {
    state.tailHash.update(slice);
    if (planHash !== null && descriptor !== null) {
      const take = Math.max(0, Math.min(slice.byteLength, descriptor.beforeLength - state.offset));
      if (take > 0) planHash.update(slice.subarray(0, take));
      if (take < slice.byteLength) captureTrailing(slice.subarray(take));
    }
    state.offset += slice.byteLength;
  }

  function accept(raw: RawLine): void {
    if (raw.bytes !== null) prefixHash.update(raw.bytes);
    state.validPrefixBytes = raw.end;
    // Every byte consumed so far now belongs to the valid prefix, so the tail restarts empty.
    state.tailHash = crypto.createHash("sha256");
  }

  function decodeLine(raw: RawLine, isHeaderLine: boolean): H | R | Error {
    if (raw.bytes === null) {
      return new JsonlLineTooLongError({
        measured: raw.length,
        allowed: JSONL_MAX_PHYSICAL_LINE_BYTES,
      });
    }
    const parsed = decodeJsonlLine(raw.bytes);
    if (parsed instanceof Error) return parsed;
    return isHeaderLine
      ? input.codec.decodeHeader(parsed.value)
      : input.codec.decodeRecord(parsed.value);
  }

  function handleLine(raw: RawLine): JsonlMidFileCorruptionError | null {
    const isHeaderLine = state.lineIndex === 0;
    state.lineIndex += 1;
    const decoded = decodeLine(raw, isHeaderLine);

    if (state.firstCorruption !== null) {
      // Past the first invalid line the reader only classifies: a complete schema-valid
      // record here is §11.3 case 3, and nothing after it can ever be indexed.
      if (!(decoded instanceof Error) && state.validRecordAfterCorruption === null) {
        state.validRecordAfterCorruption = { offset: raw.start };
      }
      return null;
    }

    if (decoded instanceof Error) {
      state.firstCorruption = { offset: raw.start, reason: decoded.message };
      return null;
    }

    if (isHeaderLine) {
      state.header = decoded as H;
      accept(raw);
      return null;
    }

    const record = decoded as R;
    // A duplicate `recordId` in one file is an identity violation inside the valid prefix
    // (§11.1; §4.4 item 5) — hard corruption regardless of any prepared plan.
    if (seenRecordIds.has(record.recordId)) {
      return new JsonlMidFileCorruptionError({
        path: input.path,
        offset: raw.start,
        reason: `duplicate recordId ${record.recordId}`,
      });
    }
    seenRecordIds.add(record.recordId);
    state.records.push(record);
    state.lastValidRecordId = record.recordId;
    accept(raw);
    return null;
  }

  for (const chunk of input.chunks) {
    let index = 0;
    while (index < chunk.byteLength) {
      const lf = chunk.indexOf(JSONL_LF, index);
      const end = lf === -1 ? chunk.byteLength : lf + 1;
      const slice = chunk.subarray(index, end);
      consumeRaw(slice);
      line.push(slice);
      if (lf !== -1) {
        const hard = handleLine(line.take(state.lineStart, state.offset));
        if (hard instanceof Error) return hard;
        state.lineStart = state.offset;
      }
      index = end;
    }
  }

  // An unterminated remainder is never decoded: a syntactically valid final object without
  // its LF is an uncommitted suffix, not a record (§11.1).
  if (state.firstCorruption === null && line.pending > 0) {
    state.firstCorruption = { offset: state.lineStart, reason: "unterminated final line" };
  }

  const integrity = input.codec.checkPrefix?.(state.records) ?? null;
  if (integrity instanceof Error) {
    return new JsonlMidFileCorruptionError({
      path: input.path,
      offset: state.validPrefixBytes,
      reason: integrity.message,
    });
  }

  const document = (tail: TailClassification, mutationLocked: boolean): JsonlDocument<H, R> => ({
    path: input.path,
    header: state.header,
    records: state.records,
    recordCount: state.records.length,
    validPrefixBytes: state.validPrefixBytes,
    prefixSha256: prefixHash.digest("hex"),
    totalBytes: state.offset,
    tail,
    mutationLocked,
  });

  const proven = classifyPreparedAppend({
    prepared,
    totalBytes: state.offset,
    planPrefixSha256: planHash === null ? null : planHash.digest("hex"),
    trailing: concatBytes(trailingPieces, state.trailingRetained),
    trailingTotal: state.trailingTotal,
  });
  if (proven !== null)
    return document({ kind: "transaction-proven-append-interruption", append: proven }, false);

  if (state.validRecordAfterCorruption !== null) {
    return new JsonlMidFileCorruptionError({
      path: input.path,
      offset: state.validRecordAfterCorruption.offset,
      reason: "a complete valid record occurs after corrupt bytes",
    });
  }

  if (state.firstCorruption === null) return document({ kind: "clean" }, false);

  return document(
    {
      kind: "unproven-corrupt-suffix",
      report: {
        path: input.path,
        lastValidOffset: state.validPrefixBytes,
        lastValidRecordId: state.lastValidRecordId,
        suffixByteLength: state.offset - state.validPrefixBytes,
        suffixSha256: state.tailHash.digest("hex"),
      },
    },
    true,
  );
}

/**
 * turn-durability §4.4 / storage-identity §11.3 case 1: decide whether the target's trailing
 * bytes are proven by the prepared plan. EVERY field must match — a wrong base length, a
 * wrong prefix hash, a payload that disagrees with its declared hash or length, trailing
 * bytes that are not an exact leading prefix, or trailing bytes longer than the plan all
 * return `null`, which refuses the classification and leaves the tail unproven. Refusal is
 * the safe direction: it costs an explicit repair, while a false positive truncates data.
 */
function classifyPreparedAppend(input: {
  prepared: PreparedAppendPayload | null;
  totalBytes: number;
  planPrefixSha256: string | null;
  trailing: Uint8Array;
  trailingTotal: number;
}): AppendInterruption | null {
  const prepared = input.prepared;
  if (prepared === null || input.planPrefixSha256 === null) return null;
  const { descriptor, bytes } = prepared;

  if (descriptor.appendedLength <= 0) return null;
  if (bytes.byteLength !== descriptor.appendedLength) return null;
  if (sha256Hex(bytes) !== descriptor.appendedSha256) return null;
  // Truncation before the recorded base length is a recovery conflict, never a proof.
  if (input.totalBytes < descriptor.beforeLength) return null;
  if (input.planPrefixSha256 !== descriptor.beforePrefixSha256) return null;

  const base = {
    beforeLength: descriptor.beforeLength,
    appendedLength: descriptor.appendedLength,
    observedSuffixBytes: input.trailingTotal,
    recordIds: descriptor.recordIds,
  };

  if (input.trailingTotal === 0) return { ...base, state: "empty", truncateTo: null };
  if (input.trailingTotal > descriptor.appendedLength) return null;

  const observed = input.trailing.subarray(0, input.trailingTotal);
  for (let at = 0; at < observed.byteLength; at += 1) {
    if (observed[at] !== bytes[at]) return null;
  }

  // A complete match means the append landed before acknowledgement; the byte equality just
  // proven is what §4.4 item 2 asks for ("each prepared recordId occurs exactly once with the
  // prepared bytes") — file-wide uniqueness is enforced by the duplicate-id check above.
  if (input.trailingTotal === descriptor.appendedLength)
    return { ...base, state: "complete", truncateTo: null };
  return { ...base, state: "leading-prefix", truncateTo: descriptor.beforeLength };
}

/** Stream a chat JSONL file (storage-identity §11.2 chat schemas). */
export function readChatJsonl(input: {
  path: string;
  chunks: Iterable<Uint8Array>;
  prepared?: PreparedAppendPayload | null;
}): JsonlMidFileCorruptionError | JsonlDocument<ChatHeader, ChatRecord> {
  return readJsonlDocument<ChatHeader, ChatRecord>({
    path: input.path,
    chunks: input.chunks,
    prepared: input.prepared ?? null,
    codec: { decodeHeader: decodeChatHeader, decodeRecord: decodeChatRecord },
  });
}

/**
 * Stream a comments JSONL file. The §11.2 fold rules — a second `pin:created` for one
 * `pinId`, or a `pin:status` before its `pin:created` — are reference violations inside the
 * valid prefix, so they are checked here and surface as §11.3 case 3.
 */
export function readPinsJsonl(input: {
  path: string;
  chunks: Iterable<Uint8Array>;
  prepared?: PreparedAppendPayload | null;
}): JsonlMidFileCorruptionError | JsonlDocument<CommentsHeader, PinEvent> {
  return readJsonlDocument<CommentsHeader, PinEvent>({
    path: input.path,
    chunks: input.chunks,
    prepared: input.prepared ?? null,
    codec: {
      decodeHeader: decodeCommentsHeader,
      decodeRecord: decodePinEvent,
      checkPrefix: (events) => {
        const folded = foldPins(events);
        return folded instanceof Error ? folded : null;
      },
    },
  });
}
