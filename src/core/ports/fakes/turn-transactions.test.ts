import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";
import type { ChatAgentRecord, ChatSystemCancelledRecord, ChatUserRecord } from "entities/chat";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import type {
  ResolvedPinAppendV1,
  TurnAdmissionInputV1,
  TurnFinalizeInputV1,
  TurnTerminalizeInputV1,
} from "../turn-transactions";
import { createFakeTurnTransactionService } from "./turn-transactions";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const FAILURE: FailureDtoV1 = {
  code: "APPLY_STALE",
  retryable: true,
  safeMessage: "chat moved on",
  details: { part: "chat" },
};

const userRecord: ChatUserRecord = {
  kind: "user",
  recordId: "u1",
  turnId: "t1",
  text: "hi",
  ts: "2024-01-01T00:00:00.000Z",
};
const agentRecord: ChatAgentRecord = {
  kind: "agent",
  recordId: "a1",
  turnId: "t1",
  text: "done",
  changedPages: [slug("home")],
  warnings: [],
  ts: "2024-01-01T00:01:00.000Z",
};
const cancelledRecord: ChatSystemCancelledRecord = {
  kind: "system:cancelled",
  recordId: "c1",
  turnId: "t1",
  text: "cancelled",
  ts: "2024-01-01T00:02:00.000Z",
};

const admission: TurnAdmissionInputV1 = {
  turnId: "t1",
  targetChatId: "chat-1",
  userRecord,
  createdAt: "2024-01-01T00:00:00.000Z",
};

function finalize(resolvedPins: readonly ResolvedPinAppendV1[]): TurnFinalizeInputV1 {
  return {
    turnId: "t1",
    targetChatId: "chat-1",
    changedPages: [{ pageSlug: slug("home"), change: "replace", newBytes: new Uint8Array([1]) }],
    validatedPageSlugs: [slug("home")],
    agentRecord,
    resolvedPins,
    readSet: {
      manifest: { state: "absent" },
      canonicalPages: new Map(),
      chat: { length: 0, prefixSha256: "a".repeat(64) },
      pins: new Map(),
    },
    createdAt: "2024-01-01T00:01:00.000Z",
  };
}

const terminalize: TurnTerminalizeInputV1 = {
  turnId: "t1",
  targetChatId: "chat-1",
  record: cancelledRecord,
  createdAt: "2024-01-01T00:02:00.000Z",
};

describe("createFakeTurnTransactionService", () => {
  test("admit() mints a distinct transactionId per call and records the input", async () => {
    const service = createFakeTurnTransactionService();
    const first = await service.admit(admission);
    const second = await service.admit({ ...admission, turnId: "t2" });
    if ("code" in first || "code" in second) throw new Error("unexpected failure");
    expect(first.transactionId).not.toBe(second.transactionId);
  });

  test("finalize() filters resolvedPins down to pages present in changedPages (§7.4 item 5)", async () => {
    const service = createFakeTurnTransactionService();
    const onChangedPage: ResolvedPinAppendV1 = {
      pageSlug: slug("home"),
      event: {
        kind: "pin:status",
        recordId: "r1",
        pinId: "p1",
        status: "resolved",
        turnId: "t1",
        ts: "2024-01-01T00:01:00.000Z",
      },
    };
    const offChangedPage: ResolvedPinAppendV1 = {
      pageSlug: slug("about"),
      event: {
        kind: "pin:status",
        recordId: "r2",
        pinId: "p2",
        status: "resolved",
        turnId: "t1",
        ts: "2024-01-01T00:01:00.000Z",
      },
    };
    await service.finalize(finalize([onChangedPage, offChangedPage]));
    const call = service.calls.find((c) => c.method === "finalize");
    if (call === undefined || call.method !== "finalize")
      throw new Error("finalize was not recorded");
    expect(call.appliedResolvedPins).toEqual([onChangedPage]);
  });

  test("finalize() with an empty changedPages diff resolves no pin", async () => {
    const service = createFakeTurnTransactionService();
    const pin: ResolvedPinAppendV1 = {
      pageSlug: slug("home"),
      event: {
        kind: "pin:status",
        recordId: "r1",
        pinId: "p1",
        status: "resolved",
        turnId: "t1",
        ts: "2024-01-01T00:01:00.000Z",
      },
    };
    await service.finalize({ ...finalize([pin]), changedPages: [] });
    const call = service.calls.find((c) => c.method === "finalize");
    if (call === undefined || call.method !== "finalize")
      throw new Error("finalize was not recorded");
    expect(call.appliedResolvedPins).toEqual([]);
  });

  test("terminalize() succeeds and is idempotent-shaped (always returns a commit)", async () => {
    const service = createFakeTurnTransactionService();
    const result = await service.terminalize(terminalize);
    expect("code" in result).toBe(false);
  });

  test("failNext() queues a typed CAS-mismatch failure for finalize()", async () => {
    const service = createFakeTurnTransactionService();
    service.failNext("finalize", FAILURE);
    const result = await service.finalize(finalize([]));
    expect(result).toEqual(FAILURE);
  });

  test("records admit/finalize/terminalize in call order", async () => {
    const service = createFakeTurnTransactionService();
    await service.admit(admission);
    await service.finalize(finalize([]));
    await service.terminalize(terminalize);
    expect(service.calls.map((c) => c.method)).toEqual(["admit", "finalize", "terminalize"]);
  });
});
