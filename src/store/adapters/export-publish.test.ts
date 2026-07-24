import { afterEach, describe, expect, test } from "bun:test";

import type { ExportPublishPlanV1 } from "core/ports";
import { createFakeExportPublish } from "core/ports/fakes";
import { uuidv7 } from "infrastructure/uuid";
import { sha256Hex } from "store/jsonl";

import { createExportPublishAdapter } from "./export-publish";
import { createProjectWriteAdapter } from "./project-write";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";

afterEach(cleanupScratchRoots);

function emptyPlan(): ExportPublishPlanV1 {
  return {
    generationId: uuidv7(),
    pageCount: 0,
    createdAt: "2026-07-24T00:00:00.000Z",
    operations: [],
    payloads: new Map(),
  };
}

describe("createExportPublishAdapter — contract test (fake vs. real)", () => {
  test("publish() of an empty-operations plan commits exactly one transaction, echoing generationId/pageCount", async () => {
    const fake = createFakeExportPublish();
    const fakePlan = emptyPlan();
    const fakeResult = await fake.publish(fakePlan);
    if ("code" in fakeResult) throw new Error("fixture bug: fake publish() failed");
    expect(fakeResult.generationId).toBe(fakePlan.generationId);
    expect(fakeResult.pageCount).toBe(0);
    expect(fakeResult.recordedAt).toBe(fakePlan.createdAt);

    const { open, deps } = await createRealProjectFixture();
    try {
      const writeCoordinator = createProjectWriteAdapter({ mutex: open.writeMutex });
      const adapter = createExportPublishAdapter(deps);
      const plan = emptyPlan();

      // Design Q1: the caller holds the SAME writeMutex's permit across the whole
      // revalidate-then-publish window; publish() never acquires its own.
      const permit = await writeCoordinator.acquire();
      const result = await adapter.publish(plan);
      writeCoordinator.release(permit);

      if ("code" in result) throw new Error(`fixture bug: publish() failed: ${result.safeMessage}`);
      expect(result.generationId).toBe(plan.generationId);
      expect(result.pageCount).toBe(0);
      expect(result.recordedAt).toBe(plan.createdAt);
      expect(typeof result.transactionId).toBe("string");
    } finally {
      await open.close();
    }
  });

  test("publish() without an active permit fails EXPORT_PUBLICATION_FAILED rather than silently reacquiring a second mutex", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createExportPublishAdapter(deps);
      const result = await adapter.publish(emptyPlan());
      if (!("code" in result)) throw new Error("fixture bug: expected a failure");
      expect(result.code).toBe("EXPORT_PUBLICATION_FAILED");
    } finally {
      await open.close();
    }
  });

  test("publish() returns EXPORT_SNAPSHOT_STALE when an export-output target drifted from its planned old image", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const writeCoordinator = createProjectWriteAdapter({ mutex: open.writeMutex });
      const adapter = createExportPublishAdapter(deps);

      const payload = new Uint8Array([1]);
      const payloadId = uuidv7();
      const plan: ExportPublishPlanV1 = {
        generationId: uuidv7(),
        pageCount: 1,
        createdAt: "2026-07-24T00:00:00.000Z",
        operations: [
          {
            index: 0,
            target: "export/current.json",
            mode: "replace",
            // Claims the target is currently absent — true for the first publish below, but
            // stale by the time the SAME plan shape is replayed after that publish committed.
            oldImage: { state: "absent" },
            newImage: { state: "file", sha256: sha256Hex(payload), size: payload.byteLength },
            payloadId,
          },
        ],
        payloads: new Map([[payloadId, payload]]),
      };

      // `export/current.json` genuinely does not exist yet in a fresh project, so the
      // absent-vs-absent CAS matches and this first publish commits the file for real.
      const permit = await writeCoordinator.acquire();
      const result = await adapter.publish(plan);
      writeCoordinator.release(permit);
      if ("code" in result)
        throw new Error(`fixture bug: first publish() failed: ${result.safeMessage}`);

      const secondPlan: ExportPublishPlanV1 = { ...plan, generationId: uuidv7() };
      const secondPermit = await writeCoordinator.acquire();
      const secondResult = await adapter.publish(secondPlan);
      writeCoordinator.release(secondPermit);
      if (!("code" in secondResult)) throw new Error("fixture bug: expected a stale failure");
      expect(secondResult.code).toBe("EXPORT_SNAPSHOT_STALE");
    } finally {
      await open.close();
    }
  });
});
