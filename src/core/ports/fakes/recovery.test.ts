import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";

import { createFakeRecoveryService } from "./recovery";

const FAILURE: FailureDtoV1 = {
  code: "TRANSACTION_RECOVERY_CONFLICT",
  retryable: false,
  safeMessage: "conflicting transaction",
  details: {},
};

describe("createFakeRecoveryService", () => {
  test("recover() defaults to a clean, empty pass", async () => {
    const service = createFakeRecoveryService();
    expect(await service.recover()).toEqual({
      ok: true,
      recovered: 0,
      discarded: 0,
      alreadyComplete: 0,
    });
  });

  test("scriptRecoverOutcome() queues the next recover() outcome, one shot", async () => {
    const service = createFakeRecoveryService();
    service.scriptRecoverOutcome({ ok: false, transactionId: "tx-1", error: FAILURE });
    const first = await service.recover();
    expect(first).toEqual({ ok: false, transactionId: "tx-1", error: FAILURE });
    const second = await service.recover();
    expect(second).toEqual({ ok: true, recovered: 0, discarded: 0, alreadyComplete: 0 });
  });

  test("classify() defaults to 'complete' unless configured otherwise", async () => {
    const service = createFakeRecoveryService();
    const result = await service.classify("tx-1");
    expect(result).toEqual({ kind: "complete", transactionId: "tx-1" });
  });

  test("classify() honors a configured classification per transactionId", async () => {
    const service = createFakeRecoveryService({
      classifications: new Map([
        ["tx-1", { kind: "conflict", transactionId: "tx-1", reason: "manifest drift" }],
      ]),
    });
    const result = await service.classify("tx-1");
    expect(result).toEqual({ kind: "conflict", transactionId: "tx-1", reason: "manifest drift" });
  });

  test("hasIntentRecord() defaults to false — no intent proof without configuration", async () => {
    const service = createFakeRecoveryService();
    expect(await service.hasIntentRecord("tx-1")).toBe(false);
  });

  test("setIntentRecord() lets a test prove the failBeforeIntent edge", async () => {
    const service = createFakeRecoveryService();
    service.setIntentRecord("tx-1", true);
    expect(await service.hasIntentRecord("tx-1")).toBe(true);
  });

  test("scanOrphanTurns() defaults to no orphans", async () => {
    const service = createFakeRecoveryService();
    expect(await service.scanOrphanTurns()).toEqual([]);
  });

  test("failNext() queues one failure for classify()", async () => {
    const service = createFakeRecoveryService();
    service.failNext("classify", FAILURE);
    const first = await service.classify("tx-1");
    expect(first).toEqual(FAILURE);
    const second = await service.classify("tx-1");
    expect(second).toEqual({ kind: "complete", transactionId: "tx-1" });
  });

  test("records calls in order", async () => {
    const service = createFakeRecoveryService();
    await service.recover();
    await service.classify("tx-1");
    await service.hasIntentRecord("tx-1");
    await service.scanOrphanTurns();
    expect(service.calls.map((c) => c.method)).toEqual([
      "recover",
      "classify",
      "hasIntentRecord",
      "scanOrphanTurns",
    ]);
  });
});
