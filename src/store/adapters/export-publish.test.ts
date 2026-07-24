import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { EXPORT_POINTER_TARGET, type ExportPointerV1, type ExportPublishPlanV1 } from "core/ports";
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

describe("createExportPublishAdapter — readPointer()", () => {
  test("returns null on a fresh project — export/current.json genuinely does not exist yet", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createExportPublishAdapter(deps);
      const result = await adapter.readPointer();
      expect(result).toBeNull();
    } finally {
      await open.close();
    }
  });

  test("returns the committed ExportPointerV1 after a real publish() writes both the generation file and the pointer", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const writeCoordinator = createProjectWriteAdapter({ mutex: open.writeMutex });
      const adapter = createExportPublishAdapter(deps);

      const generationId = uuidv7();
      const frameBytes = new Uint8Array([1, 2, 3, 4]);
      const frameTarget = `export/generations/${generationId}/frame.bin`;
      const pointer: ExportPointerV1 = {
        schemaVersion: 1,
        generationId,
        files: {
          [frameTarget]: { sha256: sha256Hex(frameBytes), size: frameBytes.byteLength },
        },
      };
      const pointerBytes = new TextEncoder().encode(JSON.stringify(pointer));
      const framePayloadId = uuidv7();
      const pointerPayloadId = uuidv7();

      const plan: ExportPublishPlanV1 = {
        generationId,
        pageCount: 1,
        createdAt: "2026-07-24T00:00:00.000Z",
        operations: [
          {
            index: 0,
            target: frameTarget,
            mode: "replace",
            oldImage: { state: "absent" },
            newImage: { state: "file", sha256: sha256Hex(frameBytes), size: frameBytes.byteLength },
            payloadId: framePayloadId,
          },
          {
            index: 1,
            target: EXPORT_POINTER_TARGET,
            mode: "replace",
            oldImage: { state: "absent" },
            newImage: {
              state: "file",
              sha256: sha256Hex(pointerBytes),
              size: pointerBytes.byteLength,
            },
            payloadId: pointerPayloadId,
          },
        ],
        payloads: new Map([
          [framePayloadId, frameBytes],
          [pointerPayloadId, pointerBytes],
        ]),
      };

      const permit = await writeCoordinator.acquire();
      const published = await adapter.publish(plan);
      writeCoordinator.release(permit);
      if ("code" in published)
        throw new Error(`fixture bug: publish() failed: ${published.safeMessage}`);

      const result = await adapter.readPointer();
      if (result === null || "code" in result) throw new Error("fixture bug: expected a pointer");
      expect(result.schemaVersion).toBe(1);
      expect(result.generationId).toBe(generationId);
      expect(result.files[frameTarget]).toEqual({
        sha256: sha256Hex(frameBytes),
        size: frameBytes.byteLength,
      });
    } finally {
      await open.close();
    }
  });

  test("returns a FailureDtoV1 when export/current.json holds bytes that are not valid JSON", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const writeCoordinator = createProjectWriteAdapter({ mutex: open.writeMutex });
      const adapter = createExportPublishAdapter(deps);

      // Honestly hashed garbage bytes: the store transaction only checks that what lands on
      // disk matches the DECLARED image, never that the content is semantically valid JSON —
      // so this is a genuine "corrupt pointer" case, not a fixture that would be rejected by
      // the transaction engine itself before readPointer() ever runs.
      const garbage = new TextEncoder().encode("not valid json{");
      const payloadId = uuidv7();
      const plan: ExportPublishPlanV1 = {
        generationId: uuidv7(),
        pageCount: 0,
        createdAt: "2026-07-24T00:00:00.000Z",
        operations: [
          {
            index: 0,
            target: EXPORT_POINTER_TARGET,
            mode: "replace",
            oldImage: { state: "absent" },
            newImage: { state: "file", sha256: sha256Hex(garbage), size: garbage.byteLength },
            payloadId,
          },
        ],
        payloads: new Map([[payloadId, garbage]]),
      };

      const permit = await writeCoordinator.acquire();
      const published = await adapter.publish(plan);
      writeCoordinator.release(permit);
      if ("code" in published)
        throw new Error(`fixture bug: publish() failed: ${published.safeMessage}`);

      const result = await adapter.readPointer();
      if (result === null || !("code" in result))
        throw new Error("fixture bug: expected a failure");
      expect(result.code).toBe("PERSISTENCE_FAILED");
    } finally {
      await open.close();
    }
  });

  test("returns a FailureDtoV1 when the pointer's referenced generation directory does not exist", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const writeCoordinator = createProjectWriteAdapter({ mutex: open.writeMutex });
      const adapter = createExportPublishAdapter(deps);

      // A well-formed pointer whose generationId was never actually published (D-Q4: the
      // read side confirms the referenced generation directory exists, not just that the
      // pointer itself parses).
      const pointer: ExportPointerV1 = {
        schemaVersion: 1,
        generationId: uuidv7(),
        files: {},
      };
      const pointerBytes = new TextEncoder().encode(JSON.stringify(pointer));
      const payloadId = uuidv7();
      const plan: ExportPublishPlanV1 = {
        generationId: pointer.generationId,
        pageCount: 0,
        createdAt: "2026-07-24T00:00:00.000Z",
        operations: [
          {
            index: 0,
            target: EXPORT_POINTER_TARGET,
            mode: "replace",
            oldImage: { state: "absent" },
            newImage: {
              state: "file",
              sha256: sha256Hex(pointerBytes),
              size: pointerBytes.byteLength,
            },
            payloadId,
          },
        ],
        payloads: new Map([[payloadId, pointerBytes]]),
      };

      const permit = await writeCoordinator.acquire();
      const published = await adapter.publish(plan);
      writeCoordinator.release(permit);
      if ("code" in published)
        throw new Error(`fixture bug: publish() failed: ${published.safeMessage}`);

      const result = await adapter.readPointer();
      if (result === null || !("code" in result))
        throw new Error("fixture bug: expected a failure");
      expect(result.code).toBe("PERSISTENCE_FAILED");
    } finally {
      await open.close();
    }
  });

  test("returns a FailureDtoV1, never null, when readFile fails for a reason OTHER than not-found", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createExportPublishAdapter(deps);

      // `export/current.json` exists but as a DIRECTORY, not a regular file — a genuine
      // `readFile` failure (`LeafRejectedError`, not `FsAccessError`/not-found) that must
      // surface as a `FailureDtoV1` through the generic `toFailureDto(bytes)` branch, never
      // be mistaken for the "absent" case that legitimately returns `null`.
      const exportDir = path.join(open.safeFs.root.realPath, "export");
      fs.mkdirSync(path.join(exportDir, "current.json"), { recursive: true });

      const result = await adapter.readPointer();
      if (result === null || !("code" in result))
        throw new Error("fixture bug: expected a failure, not null");
      expect(result.code).toBe("PERSISTENCE_FAILED");
    } finally {
      await open.close();
    }
  });

  test("returns a FailureDtoV1 when export/current.json is valid JSON that fails the pointer schema", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createExportPublishAdapter(deps);

      // Well-formed JSON (JSON.parse succeeds) but `schemaVersion: 2` fails
      // `exportPointerV1Schema`'s `z.literal(1)` — a genuinely distinct failure from the
      // "not valid JSON" case above, exercising `readPointer`'s `validated.success === false`
      // branch specifically.
      const exportDir = path.join(open.safeFs.root.realPath, "export");
      fs.mkdirSync(exportDir, { recursive: true });
      fs.writeFileSync(
        path.join(exportDir, "current.json"),
        JSON.stringify({ schemaVersion: 2, generationId: uuidv7(), files: {} }),
      );

      const result = await adapter.readPointer();
      if (result === null || !("code" in result))
        throw new Error("fixture bug: expected a failure");
      expect(result.code).toBe("PERSISTENCE_FAILED");
    } finally {
      await open.close();
    }
  });
});
