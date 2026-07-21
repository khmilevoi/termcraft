import crypto from "node:crypto";

import * as errore from "errore";

import type { ChatRecord } from "entities/chat";
import type { SessionCheckpoint } from "store/toml";

import type { Sha256Hex } from "../types";
import { JSONL_LF } from "./line-codec";
import { readChatJsonl } from "./reader";

// Session resume / checkpoint (storage-identity §6.2). A checkpoint records the exact
// durable prefix — `recordCount` complete records after the chat header — that a backend
// session is known to reflect, plus a SHA-256 over that prefix's exact bytes. Resume is
// granted only when the chat still has at least that many valid records AND the prefix
// hash is byte-identical; any additional valid records become the delta sent to the
// resumed session. Every other outcome is a mismatch: the caller starts a fresh backend
// session and seeds it with a bounded, whole-record excerpt of the chat instead.

/** Every valid resume gate mismatch this module can classify from the chat bytes alone.
 * ("SDK resume rejection" from §6.2 is a runtime outcome the caller observes after
 * actually attempting resume — it never reaches this module.) */
export type SessionResumeMismatchReason =
  | "shorter-file"
  | "changed-prefix"
  | "identity-mismatch"
  | "different-scope"
  | "corrupt-log";

/** The bounded fresh-session seed of §6.2: chronological, whole records only. */
export interface SessionSeed {
  readonly records: readonly ChatRecord[];
  readonly textBytes: number;
}

export type SessionResumeDecision =
  | { readonly kind: "resume"; readonly sessionId: string; readonly delta: readonly ChatRecord[] }
  | {
      readonly kind: "fresh";
      readonly reason: SessionResumeMismatchReason;
      readonly seed: SessionSeed;
    };

/** A requested `recordCount` could not be hashed: too few complete lines in the chat. */
export class SessionPrefixError extends errore.createTaggedError({
  name: "SessionPrefixError",
  message: "$reason",
}) {}

export interface SessionPrefixHash {
  readonly prefixHash: Sha256Hex;
  readonly recordCount: number;
}

/** §6.2's fresh-seed bound: at most 32 records... */
export const SESSION_SEED_MAX_RECORDS = 32;
/** ...and at most 64 KiB of UTF-8 record text. */
export const SESSION_SEED_MAX_TEXT_BYTES = 65_536;

/**
 * Hash exactly the header line plus `recordCount` record lines, each including its
 * terminating LF (storage-identity §6.2) — the raw physical bytes as they sit in the file,
 * never a re-serialization. Only LF-termination is checked here; schema validity is the
 * reader's job. Requesting more complete lines than the chat holds — including a final
 * line present but not yet LF-terminated — is a `SessionPrefixError`, never a short hash.
 */
export function computeSessionPrefixHash(input: {
  readonly chunks: Iterable<Uint8Array>;
  readonly recordCount: number;
}): SessionPrefixError | SessionPrefixHash {
  if (!Number.isInteger(input.recordCount) || input.recordCount < 0) {
    return new SessionPrefixError({
      reason: `recordCount must be a non-negative integer, got ${input.recordCount}`,
    });
  }

  const linesNeeded = input.recordCount + 1; // the header line, then each record line
  const hash = crypto.createHash("sha256");
  let linesHashed = 0;
  let pending: Uint8Array[] = [];

  for (const chunk of input.chunks) {
    let index = 0;
    while (index < chunk.byteLength) {
      const lf = chunk.indexOf(JSONL_LF, index);
      if (lf === -1) {
        pending.push(chunk.subarray(index));
        break;
      }
      pending.push(chunk.subarray(index, lf + 1));
      for (const piece of pending) hash.update(piece);
      pending = [];
      linesHashed += 1;
      index = lf + 1;
      if (linesHashed === linesNeeded)
        return { prefixHash: hash.digest("hex"), recordCount: input.recordCount };
    }
  }

  return new SessionPrefixError({
    reason: `chat has only ${linesHashed} complete line(s), need ${linesNeeded} (the header plus ${input.recordCount} record line(s))`,
  });
}

/**
 * Advance a checkpoint to the prefix a backend session is now known to reflect
 * (storage-identity §6.2 "termcraft atomically advances the checkpoint to the prefix known
 * by the backend session"). Refuses to advance past what the chat's own bytes support.
 */
export function advanceSessionCheckpoint(input: {
  readonly chatId: string;
  readonly sessionScopeId: string;
  readonly sessionId: string;
  readonly recordCount: number;
  readonly chunks: Iterable<Uint8Array>;
}): SessionPrefixError | SessionCheckpoint {
  const computed = computeSessionPrefixHash({
    chunks: input.chunks,
    recordCount: input.recordCount,
  });
  if (computed instanceof Error) return computed;
  return {
    chatId: input.chatId,
    sessionScopeId: input.sessionScopeId,
    sessionId: input.sessionId,
    recordCount: computed.recordCount,
    prefixHash: computed.prefixHash,
  };
}

function emptySeed(): SessionSeed {
  return { records: [], textBytes: 0 };
}

function fresh(reason: SessionResumeMismatchReason, seed: SessionSeed): SessionResumeDecision {
  return { kind: "fresh", reason, seed };
}

/** UTF-8 byte length of a record's displayed text; `system:restore` carries none. */
function recordTextBytes(record: ChatRecord): number {
  if (record.kind === "system:restore") return 0;
  return new TextEncoder().encode(record.text).byteLength;
}

/**
 * §6.2's fresh-session seed: the newest complete records, chronological order, up to
 * {@link SESSION_SEED_MAX_RECORDS} records and {@link SESSION_SEED_MAX_TEXT_BYTES} of UTF-8
 * text. Whole records only — the oldest are dropped first to fit the byte bound, and a
 * newest record that alone exceeds the bound yields an empty seed rather than a partial one.
 */
export function selectSeedRecords(records: readonly ChatRecord[]): SessionSeed {
  const capped =
    records.length > SESSION_SEED_MAX_RECORDS
      ? records.slice(records.length - SESSION_SEED_MAX_RECORDS)
      : records;

  const kept: ChatRecord[] = [];
  let textBytes = 0;
  for (let at = capped.length - 1; at >= 0; at -= 1) {
    const record = capped[at];
    if (record === undefined) break; // unreachable given the loop bounds; satisfies noUncheckedIndexedAccess
    const bytes = recordTextBytes(record);
    if (textBytes + bytes > SESSION_SEED_MAX_TEXT_BYTES) break;
    kept.unshift(record);
    textBytes += bytes;
  }

  return { records: kept, textBytes };
}

/** The eligible seed source: every record strictly before `currentUserRecordId` (§6.2 "the
 * current user message is sent normally and is not counted against the seed"). */
function buildSeed(
  records: readonly ChatRecord[],
  currentUserRecordId: string | null,
): SessionSeed {
  if (currentUserRecordId === null) return selectSeedRecords(records);
  const cutoff = records.findIndex((record) => record.recordId === currentUserRecordId);
  return selectSeedRecords(cutoff === -1 ? records : records.slice(0, cutoff));
}

/**
 * Evaluate the §6.2 resume gate for one chat against one checkpoint. `chunks` is read
 * twice — once to parse the chat, once to hash the checkpointed prefix — so it must support
 * more than one full iteration (an array of chunks, never a single-use generator).
 *
 * A trailing uncommitted or unresolved-corrupt suffix (storage-identity §11.3 case 2) does
 * NOT by itself force a mismatch: it contributes no records and cannot retroactively change
 * a valid checkpointed prefix, so a matching prefix still resumes with that suffix simply
 * excluded from the delta. Only a read that never yields a trustworthy document at all —
 * mid-file corruption (§11.3 case 3) or a missing/invalid header — is `corrupt-log`.
 */
export function evaluateSessionResume(input: {
  readonly checkpoint: SessionCheckpoint;
  readonly sessionScopeId: string;
  readonly chatId: string;
  readonly chunks: Iterable<Uint8Array>;
  readonly currentUserRecordId: string | null;
}): SessionResumeDecision {
  const { checkpoint } = input;

  const document = readChatJsonl({ path: input.chatId, chunks: input.chunks });
  if (document instanceof Error) {
    // Swallowed by design: §6.2 turns every gate failure into a `fresh` decision rather than
    // an error return. Log so the underlying corruption verdict is still diagnosable.
    console.warn("checkpoint: resume refused, chat log unreadable:", document.message);
    return fresh("corrupt-log", emptySeed());
  }
  if (document.header === null) return fresh("corrupt-log", emptySeed());
  if (document.header.chatId !== input.chatId) return fresh("identity-mismatch", emptySeed());

  const seed = () => buildSeed(document.records, input.currentUserRecordId);

  if (checkpoint.chatId !== input.chatId) return fresh("identity-mismatch", seed());
  if (checkpoint.sessionScopeId !== input.sessionScopeId) return fresh("different-scope", seed());
  if (document.records.length < checkpoint.recordCount) return fresh("shorter-file", seed());

  const computed = computeSessionPrefixHash({
    chunks: input.chunks,
    recordCount: checkpoint.recordCount,
  });
  if (computed instanceof Error) {
    // The record-count check above already passed, so too few complete lines here means the
    // decoded record count and the physical line count disagree — worth a trace, not an error.
    console.warn("checkpoint: resume refused, prefix not hashable:", computed.message);
    return fresh("changed-prefix", seed());
  }
  if (computed.prefixHash !== checkpoint.prefixHash) return fresh("changed-prefix", seed());

  return {
    kind: "resume",
    sessionId: checkpoint.sessionId,
    delta: document.records.slice(checkpoint.recordCount),
  };
}
