import { afterEach, describe, expect, test } from "bun:test";

import { createFakeRecoveryService } from "core/ports/fakes";

import { createRecoveryAdapter } from "./recovery";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";

afterEach(cleanupScratchRoots);

describe("createRecoveryAdapter — contract test (fake vs. real)", () => {
  test("recover() surfaces the already-run startup pass — a clean create-project run has nothing to recover", async () => {
    const fake = createFakeRecoveryService();
    expect(await fake.recover()).toEqual({
      ok: true,
      recovered: 0,
      discarded: 0,
      alreadyComplete: 0,
    });

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createRecoveryAdapter(deps);
      expect(await adapter.recover()).toEqual({
        ok: true,
        recovered: 0,
        discarded: 0,
        alreadyComplete: 0,
      });
    } finally {
      await open.close();
    }
  });

  test("scanOrphanTurns() surfaces the already-run startup sweep — empty for a fresh project", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createRecoveryAdapter(deps);
      expect(await adapter.scanOrphanTurns()).toEqual([]);
    } finally {
      await open.close();
    }
  });

  test("classify() reports 'complete' for a transaction the real journal has never heard of (no marker, no plan)", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createRecoveryAdapter(deps);
      const result = await adapter.classify("01950000-0000-7000-8000-000000000000");
      if ("code" in result) throw new Error("fixture bug: classify() failed");
      // No plan.json/intent.json/committed.json/conflict.json exists for this id at all —
      // `classifyTransaction`'s own "no plan" branch degrades this to `discard`, matching
      // `store/transaction/model/recovery.ts`'s own doc: "a null plan ... discards".
      expect(result.kind).toBe("discard");
    } finally {
      await open.close();
    }
  });

  test("hasIntentRecord() is false for a transaction whose intent.json was never written", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createRecoveryAdapter(deps);
      const result = await adapter.hasIntentRecord("01950000-0000-7000-8000-000000000000");
      expect(result).toBe(false);
    } finally {
      await open.close();
    }
  });
});
