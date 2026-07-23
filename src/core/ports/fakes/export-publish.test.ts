import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";

import type { ExportPublishPlanV1 } from "../export-publish";
import { createFakeExportPublish } from "./export-publish";

const FAILURE: FailureDtoV1 = {
  code: "EXPORT_PUBLICATION_FAILED",
  retryable: true,
  safeMessage: "publish transaction failed",
  details: {},
};

function plan(overrides?: Partial<ExportPublishPlanV1>): ExportPublishPlanV1 {
  return {
    generationId: "gen-1",
    pageCount: 1,
    createdAt: "2024-01-01T00:00:00.000Z",
    operations: [
      {
        index: 0,
        target: "export/generations/gen-1/pages/home.tsx",
        mode: "replace",
        oldImage: { state: "absent" },
        newImage: { state: "file", sha256: "a".repeat(64), size: 10 },
        payloadId: "payload-1",
      },
      {
        index: 1,
        target: "export/current.json",
        mode: "replace",
        oldImage: { state: "file", sha256: "b".repeat(64), size: 20 },
        newImage: { state: "file", sha256: "c".repeat(64), size: 21 },
        payloadId: "payload-2",
      },
      {
        index: 2,
        target: "export/generations/gen-0/pages/home.tsx",
        mode: "delete",
        oldImage: { state: "file", sha256: "d".repeat(64), size: 9 },
        newImage: { state: "absent" },
      },
    ],
    payloads: new Map([
      ["payload-1", new Uint8Array([1, 2, 3])],
      ["payload-2", new Uint8Array([4, 5, 6])],
    ]),
    ...overrides,
  };
}

describe("createFakeExportPublish", () => {
  test("publish() returns a synthetic ExportPublicationV1 echoing the plan's own facts", async () => {
    const port = createFakeExportPublish();
    const result = await port.publish(plan());
    if ("code" in result) throw new Error("unexpected failure");
    expect(result.generationId).toBe("gen-1");
    expect(result.pageCount).toBe(1);
    expect(result.recordedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  test("publish() mints a distinct transactionId per call", async () => {
    const port = createFakeExportPublish();
    const first = await port.publish(plan());
    const second = await port.publish(plan({ generationId: "gen-2" }));
    if ("code" in first || "code" in second) throw new Error("unexpected failure");
    expect(first.transactionId).not.toBe(second.transactionId);
  });

  test("failNext() queues a typed EXPORT_PUBLICATION_FAILED failure", async () => {
    const port = createFakeExportPublish();
    port.failNext(FAILURE);
    const result = await port.publish(plan());
    expect(result).toEqual(FAILURE);
    const next = await port.publish(plan());
    expect("code" in next).toBe(false);
  });

  test("records every publish() call with its full plan", async () => {
    const port = createFakeExportPublish();
    await port.publish(plan());
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.plan.generationId).toBe("gen-1");
    expect(port.calls[0]?.plan.operations).toHaveLength(3);
  });
});
