import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";
import { parseDesignSystemRef } from "entities/design-system-ref";

import { createFakeDesignSystemInstall } from "./design-system-install";

/**
 * `createFakeDesignSystemInstall` (mirrors `fakes/trust.test.ts`'s shape): the in-memory
 * {@link DesignSystemQuarantinePort} + {@link DesignSystemInstallPort} double
 * `core/design-systems/model/install.test.ts` composes into its own `createFakePorts` helper.
 */

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "disk full",
  details: {},
};

function refOf(raw: string) {
  const parsed = parseDesignSystemRef(raw);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const MIDNIGHT_REF = refOf("local:midnight@1.2.0");

describe("admit", () => {
  test("echoes the input files back by default, with a deterministic content hash", async () => {
    const fake = createFakeDesignSystemInstall();
    const files = [{ relPath: "design-system.json", bytes: new Uint8Array([1, 2, 3]) }];
    const first = await fake.admit({ installId: "install-1", files });
    const second = await fake.admit({ installId: "install-1", files });
    if ("code" in first || "code" in second) throw new Error("unexpected failure");
    expect(first.files).toEqual(files);
    expect(first.contentHash).toBe(second.contentHash);
  });

  test("failNext() queues one failure for admit()", async () => {
    const fake = createFakeDesignSystemInstall();
    fake.failNext("admit", FAILURE);
    const first = await fake.admit({ installId: "install-1", files: [] });
    expect(first).toEqual(FAILURE);
    const second = await fake.admit({ installId: "install-1", files: [] });
    expect(second).not.toEqual(FAILURE);
  });
});

describe("discard", () => {
  test("records every call, in order, including repeats", () => {
    const fake = createFakeDesignSystemInstall();
    fake.discard("install-1");
    fake.discard("install-2");
    fake.discard("install-1");
    expect(fake.discarded).toEqual(["install-1", "install-2", "install-1"]);
  });
});

describe("install / encodeProvenance", () => {
  test("a successful install() decodes the provenance bytes and records the RECORD, not opaque bytes", async () => {
    const fake = createFakeDesignSystemInstall();
    const provenanceBytes = fake.encodeProvenance({
      ref: MIDNIGHT_REF,
      contentHash: "a".repeat(64),
      installedAt: "2026-08-12T00:00:00.000Z",
    });
    const result = await fake.install({
      nextFiles: [{ treeRelPath: "system/design-system.json", bytes: new Uint8Array([1]) }],
      removedTreeRelPaths: ["system/components/Legacy.tsx"],
      provenanceBytes,
      expectedTreeRevision: "tree-rev-1",
    });
    expect(result).toBeUndefined();
    expect(fake.recordedInstalls).toEqual([
      {
        nextFiles: [{ treeRelPath: "system/design-system.json", bytes: new Uint8Array([1]) }],
        removedTreeRelPaths: ["system/components/Legacy.tsx"],
        expectedTreeRevision: "tree-rev-1",
      },
    ]);
    expect(fake.recordedProvenance).toEqual([
      {
        ref: MIDNIGHT_REF,
        contentHash: "a".repeat(64),
        installedAt: "2026-08-12T00:00:00.000Z",
      },
    ]);
  });

  test("failNext() queues one failure for install(), and a failed call records nothing", async () => {
    const fake = createFakeDesignSystemInstall();
    fake.failNext("install", FAILURE);
    const provenanceBytes = fake.encodeProvenance({
      ref: MIDNIGHT_REF,
      contentHash: "a".repeat(64),
      installedAt: "2026-08-12T00:00:00.000Z",
    });
    const result = await fake.install({
      nextFiles: [],
      removedTreeRelPaths: [],
      provenanceBytes,
      expectedTreeRevision: "tree-rev-1",
    });
    expect(result).toEqual(FAILURE);
    expect(fake.recordedInstalls).toEqual([]);
    expect(fake.recordedProvenance).toEqual([]);
  });
});

describe("readProvenance", () => {
  test("defaults to null — never installed, not an error (§8.5)", async () => {
    const fake = createFakeDesignSystemInstall();
    expect(await fake.readProvenance()).toBeNull();
  });

  test("seedProvenance() primes the next answer", async () => {
    const fake = createFakeDesignSystemInstall();
    const record = {
      ref: MIDNIGHT_REF,
      contentHash: "a".repeat(64),
      installedAt: "2026-08-12T00:00:00.000Z",
    };
    fake.seedProvenance(record);
    expect(await fake.readProvenance()).toEqual(record);
  });

  test("failNext() queues one failure for readProvenance()", async () => {
    const fake = createFakeDesignSystemInstall();
    fake.failNext("readProvenance", FAILURE);
    expect(await fake.readProvenance()).toEqual(FAILURE);
    expect(await fake.readProvenance()).toBeNull();
  });
});

test("records calls in order across both ports", async () => {
  const fake = createFakeDesignSystemInstall();
  await fake.admit({ installId: "install-1", files: [] });
  fake.discard("install-1");
  const provenanceBytes = fake.encodeProvenance({
    ref: MIDNIGHT_REF,
    contentHash: "a".repeat(64),
    installedAt: "2026-08-12T00:00:00.000Z",
  });
  await fake.install({
    nextFiles: [],
    removedTreeRelPaths: [],
    provenanceBytes,
    expectedTreeRevision: "tree-rev-1",
  });
  await fake.readProvenance();
  expect(fake.calls.map((c) => c.method)).toEqual([
    "admit",
    "discard",
    "encodeProvenance",
    "install",
    "readProvenance",
  ]);
});
