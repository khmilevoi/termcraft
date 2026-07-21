import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import type { ChatHeader, ChatRecord } from "entities/chat";
import type { SessionCheckpoint } from "store/toml";

import {
  SESSION_SEED_MAX_RECORDS,
  SESSION_SEED_MAX_TEXT_BYTES,
  SessionPrefixError,
  advanceSessionCheckpoint,
  computeSessionPrefixHash,
  evaluateSessionResume,
  selectSeedRecords,
} from "./checkpoint";
import { encodeChatHeaderLine, encodeChatRecordLine } from "./line-codec";

const PROJECT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10";
const CHAT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11";
const OTHER_CHAT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d12";
const TURN_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20";
const SESSION_ID = "sess_01H9Z";
const SCOPE_ID = "claude-code:opus:acct-7:ws-1";
const TS = "2026-07-19T10:00:00Z";

/** Distinct canonical record ids: only the trailing three hex digits vary. */
function recordId(n: number): string {
  return `0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5${n.toString(16).padStart(3, "0")}`;
}

function unwrap<T>(value: T): Exclude<T, Error> {
  if (value instanceof Error) throw new Error(`unexpected error: ${value.message}`);
  return value as Exclude<T, Error>;
}

function header(chatId = CHAT_ID): ChatHeader {
  return { kind: "chat", formatVersion: 1, projectId: PROJECT_ID, chatId, createdAt: TS };
}

function userRecord(n: number, text = `message ${n}`): ChatRecord {
  return { kind: "user", recordId: recordId(n), turnId: TURN_ID, text, ts: TS };
}

function headerBytes(chatId = CHAT_ID): Uint8Array {
  return unwrap(encodeChatHeaderLine(header(chatId)));
}

function recordBytes(record: ChatRecord): Uint8Array {
  return unwrap(encodeChatRecordLine(record));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Chunk boundaries deliberately fall inside lines and multi-byte code points. */
function chunksOf(bytes: Uint8Array, size = 7): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += size)
    chunks.push(bytes.subarray(at, Math.min(at + size, bytes.byteLength)));
  return chunks;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** A chat file: header line plus `records` record lines. */
function chatBytes(records: readonly ChatRecord[], chatId = CHAT_ID): Uint8Array {
  return concat([headerBytes(chatId), ...records.map(recordBytes)]);
}

function checkpointFor(
  records: readonly ChatRecord[],
  recordCount: number,
  overrides: Partial<SessionCheckpoint> = {},
): SessionCheckpoint {
  const prefix = concat([headerBytes(), ...records.slice(0, recordCount).map(recordBytes)]);
  return {
    chatId: CHAT_ID,
    sessionScopeId: SCOPE_ID,
    sessionId: SESSION_ID,
    recordCount,
    prefixHash: sha256(prefix),
    ...overrides,
  };
}

function resume(input: {
  bytes: Uint8Array;
  checkpoint: SessionCheckpoint;
  scopeId?: string;
  chatId?: string;
  currentUserRecordId?: string | null;
}) {
  return evaluateSessionResume({
    checkpoint: input.checkpoint,
    sessionScopeId: input.scopeId ?? SCOPE_ID,
    chatId: input.chatId ?? CHAT_ID,
    chunks: chunksOf(input.bytes),
    currentUserRecordId: input.currentUserRecordId ?? null,
  });
}

describe("computeSessionPrefixHash", () => {
  test("hashes the header line plus exactly recordCount record lines, each including its LF", () => {
    const records = [userRecord(1), userRecord(2), userRecord(3)];
    const prefix = concat([headerBytes(), recordBytes(records[0]!), recordBytes(records[1]!)]);

    const computed = unwrap(
      computeSessionPrefixHash({ chunks: chunksOf(chatBytes(records)), recordCount: 2 }),
    );

    expect(computed.prefixHash).toBe(sha256(prefix));
    expect(computed.recordCount).toBe(2);
  });

  test("a recordCount of zero hashes the header line alone", () => {
    const computed = unwrap(
      computeSessionPrefixHash({ chunks: chunksOf(chatBytes([userRecord(1)])), recordCount: 0 }),
    );

    expect(computed.prefixHash).toBe(sha256(headerBytes()));
  });

  test("a prefix longer than the file is an error, not a short hash", () => {
    const computed = computeSessionPrefixHash({
      chunks: chunksOf(chatBytes([userRecord(1)])),
      recordCount: 4,
    });

    expect(computed).toBeInstanceOf(SessionPrefixError);
  });

  test("an unterminated final line is not a record", () => {
    const partial = recordBytes(userRecord(2));
    const bytes = concat([
      headerBytes(),
      recordBytes(userRecord(1)),
      partial.subarray(0, partial.byteLength - 1),
    ]);

    expect(computeSessionPrefixHash({ chunks: chunksOf(bytes), recordCount: 2 })).toBeInstanceOf(
      SessionPrefixError,
    );
  });

  test("a negative or fractional recordCount is rejected", () => {
    const bytes = chatBytes([userRecord(1)]);

    expect(computeSessionPrefixHash({ chunks: chunksOf(bytes), recordCount: -1 })).toBeInstanceOf(
      SessionPrefixError,
    );
    expect(computeSessionPrefixHash({ chunks: chunksOf(bytes), recordCount: 1.5 })).toBeInstanceOf(
      SessionPrefixError,
    );
  });
});

describe("advanceSessionCheckpoint", () => {
  test("advances to the durable prefix the backend session reflects", () => {
    const records = [userRecord(1), userRecord(2)];

    const advanced = unwrap(
      advanceSessionCheckpoint({
        chatId: CHAT_ID,
        sessionScopeId: SCOPE_ID,
        sessionId: SESSION_ID,
        recordCount: 2,
        chunks: chunksOf(chatBytes(records)),
      }),
    );

    expect(advanced).toEqual(checkpointFor(records, 2));
  });

  test("refuses to advance past the durable prefix", () => {
    const advanced = advanceSessionCheckpoint({
      chatId: CHAT_ID,
      sessionScopeId: SCOPE_ID,
      sessionId: SESSION_ID,
      recordCount: 3,
      chunks: chunksOf(chatBytes([userRecord(1)])),
    });

    expect(advanced).toBeInstanceOf(SessionPrefixError);
  });
});

describe("evaluateSessionResume", () => {
  test("an unchanged prefix plus extra records resumes with the extra records as the delta", () => {
    const records = [userRecord(1), userRecord(2), userRecord(3), userRecord(4)];

    const decision = resume({ bytes: chatBytes(records), checkpoint: checkpointFor(records, 2) });

    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.sessionId).toBe(SESSION_ID);
    expect(decision.delta.map((record) => record.recordId)).toEqual([recordId(3), recordId(4)]);
  });

  test("an exact prefix with no extra records resumes with an empty delta", () => {
    const records = [userRecord(1), userRecord(2)];

    const decision = resume({ bytes: chatBytes(records), checkpoint: checkpointFor(records, 2) });

    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.delta).toEqual([]);
  });

  test("an uncommitted final line is excluded from the delta and does not block resume", () => {
    const records = [userRecord(1), userRecord(2)];
    const partial = recordBytes(userRecord(3));
    const bytes = concat([chatBytes(records), partial.subarray(0, partial.byteLength - 1)]);

    const decision = resume({ bytes, checkpoint: checkpointFor(records, 1) });

    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.delta.map((record) => record.recordId)).toEqual([recordId(2)]);
  });

  test("a shorter file is a mismatch", () => {
    const records = [userRecord(1), userRecord(2), userRecord(3)];

    const decision = resume({
      bytes: chatBytes(records.slice(0, 2)),
      checkpoint: checkpointFor(records, 3),
    });

    expect(decision.kind).toBe("fresh");
    if (decision.kind !== "fresh") return;
    expect(decision.reason).toBe("shorter-file");
  });

  test("a changed prefix is a mismatch even at the same record count", () => {
    const records = [userRecord(1), userRecord(2)];
    const rewritten = [userRecord(1, "tampered"), userRecord(2)];

    const decision = resume({ bytes: chatBytes(rewritten), checkpoint: checkpointFor(records, 2) });

    expect(decision.kind).toBe("fresh");
    if (decision.kind !== "fresh") return;
    expect(decision.reason).toBe("changed-prefix");
  });

  test("a header naming a different chat is an identity mismatch", () => {
    const records = [userRecord(1)];

    const decision = resume({
      bytes: chatBytes(records, OTHER_CHAT_ID),
      checkpoint: checkpointFor(records, 1),
    });

    expect(decision.kind).toBe("fresh");
    if (decision.kind !== "fresh") return;
    expect(decision.reason).toBe("identity-mismatch");
  });

  test("a checkpoint for another chat is an identity mismatch", () => {
    const records = [userRecord(1)];

    const decision = resume({
      bytes: chatBytes(records),
      checkpoint: checkpointFor(records, 1, { chatId: OTHER_CHAT_ID }),
    });

    expect(decision.kind).toBe("fresh");
    if (decision.kind !== "fresh") return;
    expect(decision.reason).toBe("identity-mismatch");
  });

  test("a different session scope is a mismatch", () => {
    const records = [userRecord(1)];

    const decision = resume({
      bytes: chatBytes(records),
      checkpoint: checkpointFor(records, 1),
      scopeId: "claude-code:opus:acct-9:ws-1",
    });

    expect(decision.kind).toBe("fresh");
    if (decision.kind !== "fresh") return;
    expect(decision.reason).toBe("different-scope");
  });

  test("a corrupt line inside the log is a mismatch even when the checkpointed prefix still matches", () => {
    const records = [userRecord(1), userRecord(2)];
    const bytes = concat([
      headerBytes(),
      recordBytes(records[0]!),
      new TextEncoder().encode("{not json\n"),
      recordBytes(records[1]!),
    ]);

    const decision = resume({ bytes, checkpoint: checkpointFor(records, 1) });

    expect(decision.kind).toBe("fresh");
    if (decision.kind !== "fresh") return;
    expect(decision.reason).toBe("corrupt-log");
  });

  test("a missing or invalid header is a mismatch", () => {
    const decision = resume({ bytes: new Uint8Array(0), checkpoint: checkpointFor([], 0) });

    expect(decision.kind).toBe("fresh");
    if (decision.kind !== "fresh") return;
    expect(decision.reason).toBe("corrupt-log");
  });

  test("a mismatch carries the bounded fresh seed built from the valid prefix", () => {
    const records = [userRecord(1), userRecord(2), userRecord(3)];

    const decision = resume({
      bytes: chatBytes(records),
      checkpoint: checkpointFor(records, 3, { prefixHash: "0".repeat(64) }),
    });

    expect(decision.kind).toBe("fresh");
    if (decision.kind !== "fresh") return;
    expect(decision.seed.records.map((record) => record.recordId)).toEqual([
      recordId(1),
      recordId(2),
      recordId(3),
    ]);
  });

  test("the current user record and everything after it stay out of the seed", () => {
    const records = [userRecord(1), userRecord(2), userRecord(3)];

    const decision = resume({
      bytes: chatBytes(records),
      checkpoint: checkpointFor(records, 3, { prefixHash: "0".repeat(64) }),
      currentUserRecordId: recordId(3),
    });

    expect(decision.kind).toBe("fresh");
    if (decision.kind !== "fresh") return;
    expect(decision.seed.records.map((record) => record.recordId)).toEqual([
      recordId(1),
      recordId(2),
    ]);
  });
});

describe("selectSeedRecords", () => {
  test("keeps every record in chronological order when both bounds allow", () => {
    const records = [userRecord(1), userRecord(2), userRecord(3)];

    const seed = selectSeedRecords(records);

    expect(seed.records.map((record) => record.recordId)).toEqual([
      recordId(1),
      recordId(2),
      recordId(3),
    ]);
  });

  test("keeps exactly the newest 32 records and drops the oldest first", () => {
    const records = Array.from({ length: 40 }, (_unused, at) => userRecord(at + 1));

    const seed = selectSeedRecords(records);

    expect(seed.records).toHaveLength(SESSION_SEED_MAX_RECORDS);
    expect(seed.records[0]?.recordId).toBe(recordId(9));
    expect(seed.records.at(-1)?.recordId).toBe(recordId(40));
  });

  test("drops whole records oldest-first to stay within the 64 KiB text bound", () => {
    const records = Array.from({ length: 20 }, (_unused, at) =>
      userRecord(at + 1, "x".repeat(10_000)),
    );

    const seed = selectSeedRecords(records);

    // Six whole records use 60,000 bytes; a seventh would reach 70,000 > 65,536.
    expect(seed.records).toHaveLength(6);
    expect(seed.textBytes).toBe(60_000);
    expect(seed.records[0]?.recordId).toBe(recordId(15));
    expect(seed.records.at(-1)?.recordId).toBe(recordId(20));
  });

  test("the bound is measured in UTF-8 bytes, not code units, and the exact bound fits", () => {
    // Each "é" is two UTF-8 bytes: 16,384 of them are 32,768 bytes, so exactly two records
    // reach the bound. Counting code units would have let four through.
    const records = [
      userRecord(1, "é".repeat(16_384)),
      userRecord(2, "é".repeat(16_384)),
      userRecord(3, "é".repeat(16_384)),
    ];

    const seed = selectSeedRecords(records);

    expect(seed.records.map((record) => record.recordId)).toEqual([recordId(2), recordId(3)]);
    expect(seed.textBytes).toBe(SESSION_SEED_MAX_TEXT_BYTES);
  });

  test("a newest record that alone exceeds the byte bound yields an empty seed", () => {
    const records = [
      userRecord(1, "small"),
      userRecord(2, "x".repeat(SESSION_SEED_MAX_TEXT_BYTES + 1)),
    ];

    const seed = selectSeedRecords(records);

    expect(seed.records).toEqual([]);
    expect(seed.textBytes).toBe(0);
  });

  test("an empty history yields an empty seed", () => {
    expect(selectSeedRecords([]).records).toEqual([]);
  });
});
