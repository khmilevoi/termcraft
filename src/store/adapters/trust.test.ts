import { afterEach, describe, expect, test } from "bun:test";

import { createFakeTrustGate } from "core/ports/fakes";
import { uuidv7 } from "infrastructure/uuid";

import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";
import { createTrustAdapter } from "./trust";

afterEach(cleanupScratchRoots);

describe("createTrustAdapter — contract test (fake vs. real)", () => {
  test("createProject's implicit grant is already granted for that exact subject", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const manifest = await open.manifest.read();
      if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);
      const adapter = createTrustAdapter(deps);

      const subject = await adapter.buildSubject(open.root, manifest.projectId, null);
      if ("code" in subject) throw new Error("fixture bug: buildSubject failed");
      expect(await adapter.isGranted(subject)).toBe(true);
    } finally {
      await open.close();
    }
  });

  test("isGranted() is false for a subject that was never granted (never fails open)", async () => {
    const fake = createFakeTrustGate();
    const fakeSubject = await fake.buildSubject("/nowhere", "no-project", null);
    if ("code" in fakeSubject) throw new Error("fixture bug: fake buildSubject failed");
    expect(await fake.isGranted(fakeSubject)).toBe(false);

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createTrustAdapter(deps);
      const subject = await adapter.buildSubject(open.root, uuidv7(), null);
      if ("code" in subject) throw new Error("fixture bug: buildSubject failed");
      expect(await adapter.isGranted(subject)).toBe(false);
    } finally {
      await open.close();
    }
  });

  test("grant() then isGranted() round-trips a fresh subject", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createTrustAdapter(deps);
      const subject = await adapter.buildSubject(open.root, uuidv7(), null);
      if ("code" in subject) throw new Error("fixture bug: buildSubject failed");
      expect(await adapter.isGranted(subject)).toBe(false);

      const granted = await adapter.grant(subject);
      expect(granted).toBeUndefined();
      expect(await adapter.isGranted(subject)).toBe(true);
    } finally {
      await open.close();
    }
  });
});
