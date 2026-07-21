import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sha256Hex } from "store/jsonl";
import { createSafeProjectFs, nodeSafeFsDeps, openManagedRoot } from "store/safe-fs";
import type { SafeProjectFs } from "store/safe-fs";

import type { TransactionBoundary, TransactionOperation, TransactionPlan } from "../types";
import {
  TransactionRecoveryConflictError,
  intentPath,
  nodeTransactionFsDeps,
  payloadPath,
  runTransaction,
} from "./engine";
import type { RunTransactionInput } from "./engine";
import { JournalCorruptError } from "./plan";
import {
  classifyTransaction,
  listTransactionIds,
  nodeRecoveryFsDeps,
  recoverTransactions,
} from "./recovery";
import { createWriteMutex } from "./write-mutex";

const PAYLOAD_A = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5da1";
const APPEND_PAYLOAD_A = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5da3";
const RECORD_A = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5db0";
const TS = "2026-07-20T10:00:00Z";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

let scratch = "";
let termcraftDir = "";

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tc-recovery-"));
  termcraftDir = path.join(scratch, ".termcraft");
  fs.mkdirSync(termcraftDir);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function openSafeFs(): SafeProjectFs {
  const deps = nodeSafeFsDeps();
  const root = openManagedRoot({ kind: "project", path: termcraftDir, deps });
  if (root instanceof Error) throw new Error(`openManagedRoot failed: ${root.message}`);
  return createSafeProjectFs(root, deps);
}

function replaceOp(
  target: string,
  bytes: Uint8Array,
  payloadId: string,
  oldImage: TransactionOperation["oldImage"] = { state: "absent" },
): TransactionOperation {
  return {
    index: 0,
    target,
    mode: "replace",
    oldImage,
    newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
    payloadId,
  };
}

function blankPlan(
  transactionId: string,
  operations: readonly TransactionOperation[],
): TransactionPlan {
  return {
    journalVersion: 1,
    transactionId,
    kind: "project-mutation",
    domain: {},
    createdAt: TS,
    operations,
  };
}

class SimulatedCrash extends Error {}

/**
 * Run a transaction that deliberately throws right after the named boundary lands durably —
 * everything up to that boundary is a completed synchronous fs write, so the on-disk state
 * afterward is exactly "the process died right here" (mirrors `engine.test.ts`'s own
 * crash-and-resume pattern; the real subprocess-crash harness lives in `crash-harness.ts`).
 */
async function crashAtBoundary(
  safeFs: SafeProjectFs,
  input: RunTransactionInput,
  boundary: TransactionBoundary,
): Promise<void> {
  const deps = {
    ...nodeTransactionFsDeps(safeFs),
    onBoundary: (name: TransactionBoundary) => {
      if (name === boundary) throw new SimulatedCrash(name);
    },
  };
  await expect(runTransaction(deps, input)).rejects.toBeInstanceOf(SimulatedCrash);
}

// ---- listTransactionIds ------------------------------------------------------------

describe("listTransactionIds", () => {
  test("returns an empty list when transactions.local/ does not exist yet", () => {
    const safeFs = openSafeFs();
    const deps = nodeRecoveryFsDeps(safeFs);
    expect(listTransactionIds(deps)).toEqual([]);
  });

  test("sorts entries in stable lexical order and skips a non-UUID stray entry", () => {
    fs.mkdirSync(
      path.join(termcraftDir, "transactions.local", "11111111-1111-7111-8111-111111111112"),
      { recursive: true },
    );
    fs.mkdirSync(
      path.join(termcraftDir, "transactions.local", "00000000-0000-7000-8000-000000000001"),
      { recursive: true },
    );
    fs.mkdirSync(path.join(termcraftDir, "transactions.local", "not-a-uuid"), { recursive: true });
    const safeFs = openSafeFs();
    const deps = nodeRecoveryFsDeps(safeFs);
    expect(listTransactionIds(deps)).toEqual([
      "00000000-0000-7000-8000-000000000001",
      "11111111-1111-7111-8111-111111111112",
    ]);
  });
});

// ---- classifyTransaction / recoverTransactions — the four §10.2 branches, plus conflict --

describe("recovery — discard: valid plan and payloads, no intent", () => {
  test("the prepared journal is deleted; targets are untouched by contract", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const bytes = bytesOf("discard payload\n");
    const plan = blankPlan(TX_ID, [replaceOp("cache/tx.bin", bytes, PAYLOAD_A)]);
    await crashAtBoundary(
      safeFs,
      { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) },
      "plan-installed",
    );

    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "plan.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "intent.json"))).toBe(
      false,
    );

    const deps = nodeRecoveryFsDeps(safeFs);
    expect(classifyTransaction(deps, TX_ID)).toEqual({ kind: "discard", transactionId: TX_ID });

    mutex.release(permit);
    const recoveryPermit = await mutex.acquire();
    const outcome = await recoverTransactions(deps, mutex, recoveryPermit);
    expect(outcome).toEqual({ ok: true, recovered: 0, discarded: 1, alreadyComplete: 0 });
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID))).toBe(false);
    expect(fs.existsSync(path.join(termcraftDir, "cache", "tx.bin"))).toBe(false);
  });

  test("a directory with only a stray payload and no plan.json degrades to discard", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11";
    fs.mkdirSync(path.join(termcraftDir, "transactions.local", TX_ID, "payloads"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(termcraftDir, "transactions.local", TX_ID, "payloads", `${PAYLOAD_A}.bin`),
      "orphan\n",
    );

    const safeFs = openSafeFs();
    const deps = nodeRecoveryFsDeps(safeFs);
    expect(classifyTransaction(deps, TX_ID)).toEqual({ kind: "discard", transactionId: TX_ID });

    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const outcome = await recoverTransactions(deps, mutex, permit);
    expect(outcome).toEqual({ ok: true, recovered: 0, discarded: 1, alreadyComplete: 0 });
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID))).toBe(false);
  });
});

describe("recovery — roll-forward: valid intent, no valid committed", () => {
  test("'before': target still equals the operation's old image — the planned new image is applied", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const bytes = bytesOf("fresh contents\n");
    const plan = blankPlan(TX_ID, [replaceOp("cache/tx.bin", bytes, PAYLOAD_A)]);
    await crashAtBoundary(
      safeFs,
      { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) },
      "intent-installed",
    );

    expect(fs.existsSync(path.join(termcraftDir, "cache", "tx.bin"))).toBe(false);

    const deps = nodeRecoveryFsDeps(safeFs);
    const classified = classifyTransaction(deps, TX_ID);
    expect(classified).toMatchObject({ kind: "roll-forward", transactionId: TX_ID });

    mutex.release(permit);
    const recoveryPermit = await mutex.acquire();
    const outcome = await recoverTransactions(deps, mutex, recoveryPermit);
    expect(outcome).toEqual({ ok: true, recovered: 1, discarded: 0, alreadyComplete: 0 });
    expect(fs.readFileSync(path.join(termcraftDir, "cache", "tx.bin"), "utf8")).toBe(
      "fresh contents\n",
    );
    expect(
      fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "committed.json")),
    ).toBe(true);
  });

  test("'after': target already equals the new image (ambiguous ack) — marked applied without rewriting", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d21";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const bytes = bytesOf("ambiguous ack contents\n");
    const plan = blankPlan(TX_ID, [replaceOp("cache/tx.bin", bytes, PAYLOAD_A)]);
    await crashAtBoundary(
      safeFs,
      { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) },
      "operation-target-applied",
    );

    expect(fs.readFileSync(path.join(termcraftDir, "cache", "tx.bin"), "utf8")).toBe(
      "ambiguous ack contents\n",
    );
    expect(
      fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "applied", "0000.json")),
    ).toBe(false);

    mutex.release(permit);
    const recoveryPermit = await mutex.acquire();
    const deps = nodeRecoveryFsDeps(safeFs);
    let durableWrites = 0;
    const spiedDeps = {
      ...deps,
      durableWrite: (absPath: string, content: Uint8Array) => {
        durableWrites += 1;
        return deps.durableWrite(absPath, content);
      },
    };

    const outcome = await recoverTransactions(spiedDeps, mutex, recoveryPermit);
    expect(outcome).toEqual({ ok: true, recovered: 1, discarded: 0, alreadyComplete: 0 });
    // The applied marker + committed.json each go through durableWrite once; a 3rd call
    // would mean the already-correct TARGET was rewritten (the ambiguous branch never does).
    expect(durableWrites).toBe(2);
    expect(fs.readFileSync(path.join(termcraftDir, "cache", "tx.bin"), "utf8")).toBe(
      "ambiguous ack contents\n",
    );
  });

  test("'empty-append': a fresh JSONL file (beforeLength 0) is fully written", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d22";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const appendBytes = bytesOf('{"kind":"chat","formatVersion":1}\n');
    const plan = blankPlan(TX_ID, [
      {
        index: 0,
        target: `chats/${TX_ID}.jsonl`,
        mode: "append-jsonl",
        oldImage: { state: "absent" },
        newImage: { state: "file", sha256: sha256Hex(appendBytes), size: appendBytes.byteLength },
        append: {
          beforeLength: 0,
          beforePrefixSha256: sha256Hex(new Uint8Array(0)),
          appendedPayloadId: APPEND_PAYLOAD_A,
          appendedSha256: sha256Hex(appendBytes),
          appendedLength: appendBytes.byteLength,
          recordIds: [RECORD_A],
        },
      },
    ]);
    await crashAtBoundary(
      safeFs,
      { mutex, permit, plan, payloads: new Map([[APPEND_PAYLOAD_A, appendBytes]]) },
      "intent-installed",
    );

    expect(fs.existsSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`))).toBe(false);

    mutex.release(permit);
    const recoveryPermit = await mutex.acquire();
    const deps = nodeRecoveryFsDeps(safeFs);
    const outcome = await recoverTransactions(deps, mutex, recoveryPermit);
    expect(outcome).toEqual({ ok: true, recovered: 1, discarded: 0, alreadyComplete: 0 });
    expect(fs.readFileSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`), "utf8")).toBe(
      '{"kind":"chat","formatVersion":1}\n',
    );
  });

  test("'exact-partial': a proven interrupted partial append (leading prefix) is truncated and completed", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d23";
    fs.mkdirSync(path.join(termcraftDir, "chats"));
    fs.writeFileSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`), "header\n");

    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const prefix = bytesOf("header\n");
    const appendBytes = bytesOf('{"kind":"user"}\n');
    const plan = blankPlan(TX_ID, [
      {
        index: 0,
        target: `chats/${TX_ID}.jsonl`,
        mode: "append-jsonl",
        oldImage: { state: "file", sha256: sha256Hex(prefix), size: prefix.byteLength },
        newImage: {
          state: "file",
          sha256: sha256Hex(new Uint8Array([...prefix, ...appendBytes])),
          size: prefix.byteLength + appendBytes.byteLength,
        },
        append: {
          beforeLength: prefix.byteLength,
          beforePrefixSha256: sha256Hex(prefix),
          appendedPayloadId: APPEND_PAYLOAD_A,
          appendedSha256: sha256Hex(appendBytes),
          appendedLength: appendBytes.byteLength,
          recordIds: [RECORD_A],
        },
      },
    ]);
    await crashAtBoundary(
      safeFs,
      { mutex, permit, plan, payloads: new Map([[APPEND_PAYLOAD_A, appendBytes]]) },
      "intent-installed",
    );

    // Simulate a real interrupted disk write: only a leading prefix of the append landed.
    const partial = new Uint8Array([...prefix, ...appendBytes.subarray(0, 5)]);
    fs.writeFileSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`), partial);

    mutex.release(permit);
    const recoveryPermit = await mutex.acquire();
    const deps = nodeRecoveryFsDeps(safeFs);
    const outcome = await recoverTransactions(deps, mutex, recoveryPermit);
    expect(outcome).toEqual({ ok: true, recovered: 1, discarded: 0, alreadyComplete: 0 });
    expect(fs.readFileSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`), "utf8")).toBe(
      'header\n{"kind":"user"}\n',
    );
  });

  test("'complete-without-ack': JSONL already shows the full appended bytes — marked applied without re-appending", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d24";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const appendBytes = bytesOf('{"kind":"chat"}\n');
    const plan = blankPlan(TX_ID, [
      {
        index: 0,
        target: `chats/${TX_ID}.jsonl`,
        mode: "append-jsonl",
        oldImage: { state: "absent" },
        newImage: { state: "file", sha256: sha256Hex(appendBytes), size: appendBytes.byteLength },
        append: {
          beforeLength: 0,
          beforePrefixSha256: sha256Hex(new Uint8Array(0)),
          appendedPayloadId: APPEND_PAYLOAD_A,
          appendedSha256: sha256Hex(appendBytes),
          appendedLength: appendBytes.byteLength,
          recordIds: [RECORD_A],
        },
      },
    ]);
    await crashAtBoundary(
      safeFs,
      { mutex, permit, plan, payloads: new Map([[APPEND_PAYLOAD_A, appendBytes]]) },
      "operation-target-applied",
    );

    expect(fs.readFileSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`), "utf8")).toBe(
      '{"kind":"chat"}\n',
    );

    mutex.release(permit);
    const recoveryPermit = await mutex.acquire();
    const deps = nodeRecoveryFsDeps(safeFs);
    let appends = 0;
    const spiedDeps = {
      ...deps,
      appendInPlace: (appendInput: Parameters<typeof deps.appendInPlace>[0]) => {
        appends += 1;
        return deps.appendInPlace(appendInput);
      },
    };

    const outcome = await recoverTransactions(spiedDeps, mutex, recoveryPermit);
    expect(outcome).toEqual({ ok: true, recovered: 1, discarded: 0, alreadyComplete: 0 });
    expect(appends).toBe(0); // no duplicate append — the file already showed the complete bytes
    expect(fs.readFileSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`), "utf8")).toBe(
      '{"kind":"chat"}\n',
    );
  });

  test("'changed-target': a fixed target matching neither old nor new image is a durable recovery conflict, never overwritten", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d25";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const oldBytes = bytesOf("expected old\n");
    const newBytes = bytesOf("expected new\n");
    const plan = blankPlan(TX_ID, [
      {
        index: 0,
        target: "cache/tx.bin",
        mode: "replace",
        oldImage: { state: "file", sha256: sha256Hex(oldBytes), size: oldBytes.byteLength },
        newImage: { state: "file", sha256: sha256Hex(newBytes), size: newBytes.byteLength },
        payloadId: PAYLOAD_A,
      },
    ]);
    await crashAtBoundary(
      safeFs,
      { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, newBytes]]) },
      "intent-installed",
    );

    fs.mkdirSync(path.join(termcraftDir, "cache"), { recursive: true });
    fs.writeFileSync(path.join(termcraftDir, "cache", "tx.bin"), "unrelated hostile content\n");

    mutex.release(permit);
    const recoveryPermit = await mutex.acquire();
    const deps = nodeRecoveryFsDeps(safeFs);
    const outcome = await recoverTransactions(deps, mutex, recoveryPermit);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("fixture bug");
    expect(outcome.error).toBeInstanceOf(TransactionRecoveryConflictError);
    expect(fs.readFileSync(path.join(termcraftDir, "cache", "tx.bin"), "utf8")).toBe(
      "unrelated hostile content\n",
    );
    expect(
      fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "conflict.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "committed.json")),
    ).toBe(false);
  });
});

describe("recovery — stop: invalid plan, payload, or marker (journal_corrupt; write nothing)", () => {
  test("'missing-payload': a payload absent from disk is journal_corrupt distinctly", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d30";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const bytes = bytesOf("payload contents\n");
    const plan = blankPlan(TX_ID, [replaceOp("cache/tx.bin", bytes, PAYLOAD_A)]);
    await crashAtBoundary(
      safeFs,
      { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) },
      "intent-installed",
    );

    fs.unlinkSync(path.join(termcraftDir, payloadPath(TX_ID, PAYLOAD_A)));

    mutex.release(permit);
    const recoveryPermit = await mutex.acquire();
    const deps = nodeRecoveryFsDeps(safeFs);
    const classified = classifyTransaction(deps, TX_ID);
    expect(classified).toBeInstanceOf(JournalCorruptError);
    expect(classified instanceof JournalCorruptError && classified.code).toBe("PAYLOAD_MISSING");

    const outcome = await recoverTransactions(deps, mutex, recoveryPermit);
    expect(outcome.ok).toBe(false);
    expect(fs.existsSync(path.join(termcraftDir, "cache", "tx.bin"))).toBe(false);
    expect(
      fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "conflict.json")),
    ).toBe(false);
  });

  test("'bad-hash': a payload whose bytes disagree with the declared hash is journal_corrupt distinctly", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d31";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const bytes = bytesOf("payload contents\n");
    const plan = blankPlan(TX_ID, [replaceOp("cache/tx.bin", bytes, PAYLOAD_A)]);
    await crashAtBoundary(
      safeFs,
      { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) },
      "intent-installed",
    );

    fs.writeFileSync(path.join(termcraftDir, payloadPath(TX_ID, PAYLOAD_A)), "tampered bytes\n");

    mutex.release(permit);
    const deps = nodeRecoveryFsDeps(safeFs);
    const classified = classifyTransaction(deps, TX_ID);
    expect(classified).toBeInstanceOf(JournalCorruptError);
    expect(classified instanceof JournalCorruptError && classified.code).toBe(
      "PAYLOAD_HASH_MISMATCH",
    );
  });

  test("'corrupt-intent': intent.json naming the wrong plan hash is journal_corrupt distinctly", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d32";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const bytes = bytesOf("payload contents\n");
    const plan = blankPlan(TX_ID, [replaceOp("cache/tx.bin", bytes, PAYLOAD_A)]);
    await crashAtBoundary(
      safeFs,
      { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) },
      "intent-installed",
    );

    fs.writeFileSync(
      path.join(termcraftDir, intentPath(TX_ID)),
      JSON.stringify({ planHash: "0".repeat(64) }),
    );

    mutex.release(permit);
    const deps = nodeRecoveryFsDeps(safeFs);
    const classified = classifyTransaction(deps, TX_ID);
    expect(classified).toBeInstanceOf(JournalCorruptError);
    expect(classified instanceof JournalCorruptError && classified.code).toBe("INTENT_PLAN_HASH");
  });

  test("'corrupt-intent' (malformed JSON) is journal_corrupt distinctly", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d33";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const bytes = bytesOf("payload contents\n");
    const plan = blankPlan(TX_ID, [replaceOp("cache/tx.bin", bytes, PAYLOAD_A)]);
    await crashAtBoundary(
      safeFs,
      { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) },
      "intent-installed",
    );

    fs.writeFileSync(path.join(termcraftDir, intentPath(TX_ID)), "not json at all");

    mutex.release(permit);
    const deps = nodeRecoveryFsDeps(safeFs);
    expect(classifyTransaction(deps, TX_ID)).toBeInstanceOf(JournalCorruptError);
  });
});

describe("recovery — complete: valid committed marker", () => {
  test("recognized complete without comparing targets — legitimate later drift is never treated as a conflict", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d40";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const bytes = bytesOf("original committed contents\n");
    const plan = blankPlan(TX_ID, [replaceOp("cache/tx.bin", bytes, PAYLOAD_A)]);
    const txDeps = nodeTransactionFsDeps(safeFs);
    const result = await runTransaction(txDeps, {
      mutex,
      permit,
      plan,
      payloads: new Map([[PAYLOAD_A, bytes]]),
    });
    if (result instanceof Error) throw new Error(`fixture bug: ${result.message}`);
    expect(
      fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "committed.json")),
    ).toBe(true);

    // A subsequent, unrelated, legitimate edit changes the target after commit.
    fs.writeFileSync(path.join(termcraftDir, "cache", "tx.bin"), "drifted after commit\n");

    mutex.release(permit);
    const recoveryPermit = await mutex.acquire();
    const deps = nodeRecoveryFsDeps(safeFs);
    const classified = classifyTransaction(deps, TX_ID);
    expect(classified).toMatchObject({ kind: "complete", transactionId: TX_ID });

    const outcome = await recoverTransactions(deps, mutex, recoveryPermit);
    expect(outcome).toEqual({ ok: true, recovered: 0, discarded: 0, alreadyComplete: 1 });
    // Recovery never touched the drifted target — "do not compare targets" (§10.2).
    expect(fs.readFileSync(path.join(termcraftDir, "cache", "tx.bin"), "utf8")).toBe(
      "drifted after commit\n",
    );
  });
});

describe("recovery — conflict marker exists", () => {
  test("a pre-existing conflict.json is re-presented as the same conflict, with no further write", async () => {
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d50";
    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const oldBytes = bytesOf("pre-existing on-disk state\n");
    const newBytes = bytesOf("planned new state\n");
    const plan = blankPlan(TX_ID, [
      {
        index: 0,
        target: "cache/tx.bin",
        mode: "replace",
        oldImage: { state: "file", sha256: sha256Hex(oldBytes), size: oldBytes.byteLength },
        newImage: { state: "file", sha256: sha256Hex(newBytes), size: newBytes.byteLength },
        payloadId: PAYLOAD_A,
      },
    ]);
    fs.mkdirSync(path.join(termcraftDir, "cache"), { recursive: true });
    fs.writeFileSync(
      path.join(termcraftDir, "cache", "tx.bin"),
      "already something else entirely\n",
    );

    const txDeps = nodeTransactionFsDeps(safeFs);
    const firstResult = await runTransaction(txDeps, {
      mutex,
      permit,
      plan,
      payloads: new Map([[PAYLOAD_A, newBytes]]),
    });
    expect(firstResult).toBeInstanceOf(TransactionRecoveryConflictError);
    expect(
      fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "conflict.json")),
    ).toBe(true);

    mutex.release(permit);
    const recoveryPermit = await mutex.acquire();
    const deps = nodeRecoveryFsDeps(safeFs);
    const classified = classifyTransaction(deps, TX_ID);
    expect(classified).toMatchObject({ kind: "conflict", transactionId: TX_ID });

    const outcome = await recoverTransactions(deps, mutex, recoveryPermit);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("fixture bug");
    expect(outcome.transactionId).toBe(TX_ID);
    expect(outcome.error).toBeInstanceOf(TransactionRecoveryConflictError);
    expect(fs.readFileSync(path.join(termcraftDir, "cache", "tx.bin"), "utf8")).toBe(
      "already something else entirely\n",
    );
  });
});

describe("recoverTransactions — startup ordering across several journals present at once", () => {
  test("resolves everything sorting before a conflict; halts before anything sorting after it", async () => {
    const ID_DISCARD = "00000000-0000-7000-8000-000000000001";
    const ID_ROLL = "11111111-1111-7111-8111-111111111112";
    const ID_COMPLETE = "22222222-2222-7222-8222-222222222223";
    const ID_CONFLICT = "33333333-3333-7333-8333-333333333334";
    const ID_UNREACHED = "44444444-4444-7444-8444-444444444445";

    const safeFs = openSafeFs();
    const mutex = createWriteMutex();
    const txDeps = nodeTransactionFsDeps(safeFs);
    fs.mkdirSync(path.join(termcraftDir, "cache"), { recursive: true });

    // ID_DISCARD: crash right after plan-installed — payload+plan durable, no intent.
    {
      const permit = await mutex.acquire();
      const bytes = bytesOf("discard payload\n");
      const plan = blankPlan(ID_DISCARD, [replaceOp("cache/discard.bin", bytes, PAYLOAD_A)]);
      await crashAtBoundary(
        safeFs,
        { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) },
        "plan-installed",
      );
      mutex.release(permit);
    }

    // ID_ROLL: crash right after intent-installed — must be rolled forward.
    {
      const permit = await mutex.acquire();
      const bytes = bytesOf("roll-forward payload\n");
      const plan = blankPlan(ID_ROLL, [replaceOp("cache/roll.bin", bytes, PAYLOAD_A)]);
      await crashAtBoundary(
        safeFs,
        { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) },
        "intent-installed",
      );
      mutex.release(permit);
    }

    // ID_COMPLETE: runs to a real committed.json.
    {
      const permit = await mutex.acquire();
      const bytes = bytesOf("already committed\n");
      const plan = blankPlan(ID_COMPLETE, [replaceOp("cache/complete.bin", bytes, PAYLOAD_A)]);
      const result = await runTransaction(txDeps, {
        mutex,
        permit,
        plan,
        payloads: new Map([[PAYLOAD_A, bytes]]),
      });
      if (result instanceof Error) throw new Error(`fixture bug: ${result.message}`);
      mutex.release(permit);
    }

    // ID_CONFLICT: the target is hostile-corrupted before the attempt, so roll-forward writes a real conflict.json.
    {
      const permit = await mutex.acquire();
      const oldBytes = bytesOf("expected old\n");
      const newBytes = bytesOf("expected new\n");
      fs.writeFileSync(path.join(termcraftDir, "cache", "conflict.bin"), "hostile\n");
      const plan = blankPlan(ID_CONFLICT, [
        {
          index: 0,
          target: "cache/conflict.bin",
          mode: "replace",
          oldImage: { state: "file", sha256: sha256Hex(oldBytes), size: oldBytes.byteLength },
          newImage: { state: "file", sha256: sha256Hex(newBytes), size: newBytes.byteLength },
          payloadId: PAYLOAD_A,
        },
      ]);
      const result = await runTransaction(txDeps, {
        mutex,
        permit,
        plan,
        payloads: new Map([[PAYLOAD_A, newBytes]]),
      });
      expect(result).toBeInstanceOf(TransactionRecoveryConflictError);
      mutex.release(permit);
    }

    // ID_UNREACHED: same shape as ID_DISCARD, but sorts LAST — proves the scan halts at ID_CONFLICT.
    {
      const permit = await mutex.acquire();
      const bytes = bytesOf("never reached\n");
      const plan = blankPlan(ID_UNREACHED, [replaceOp("cache/unreached.bin", bytes, PAYLOAD_A)]);
      await crashAtBoundary(
        safeFs,
        { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) },
        "plan-installed",
      );
      mutex.release(permit);
    }

    const recoveryPermit = await mutex.acquire();
    const recoveryDeps = nodeRecoveryFsDeps(safeFs);
    const outcome = await recoverTransactions(recoveryDeps, mutex, recoveryPermit);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("fixture bug");
    expect(outcome.transactionId).toBe(ID_CONFLICT);
    expect(outcome.error).toBeInstanceOf(TransactionRecoveryConflictError);

    // Everything lexically BEFORE the conflict was durably resolved.
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", ID_DISCARD))).toBe(false);
    expect(fs.existsSync(path.join(termcraftDir, "cache", "discard.bin"))).toBe(false);
    expect(fs.readFileSync(path.join(termcraftDir, "cache", "roll.bin"), "utf8")).toBe(
      "roll-forward payload\n",
    );
    expect(
      fs.existsSync(path.join(termcraftDir, "transactions.local", ID_ROLL, "committed.json")),
    ).toBe(true);
    expect(fs.readFileSync(path.join(termcraftDir, "cache", "complete.bin"), "utf8")).toBe(
      "already committed\n",
    );

    // Everything lexically AFTER the conflict was never reached.
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", ID_UNREACHED))).toBe(true);
    expect(fs.existsSync(path.join(termcraftDir, "cache", "unreached.bin"))).toBe(false);
  });
});
