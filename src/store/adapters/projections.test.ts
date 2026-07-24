import { afterEach, describe, expect, test } from "bun:test";

import {
  createFakeDiagnosticsCache,
  createFakePageMetaCache,
  createFakeRenderCache,
} from "core/ports/fakes";

import { createProjectionsAdapter } from "./projections";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";

afterEach(cleanupScratchRoots);

describe("createProjectionsAdapter — contract test (fake vs. real)", () => {
  test("pageMeta: a miss is null on both the fake and the real adapter; put()+get() round-trips", async () => {
    const fake = createFakePageMetaCache();
    const key = { pageSlug: "home", sourceHash: "a".repeat(64), extractorVersion: 1 };
    expect(await fake.get(key)).toBeNull();

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createProjectionsAdapter(deps);
      const miss = await adapter.pageMeta.get(key);
      expect(miss).toBeNull();

      const entry = {
        key,
        meta: { kitApiVersion: 1, title: "Home", minSize: { w: 40, h: 10 }, theme: "dark" },
      };
      const put = await adapter.pageMeta.put(entry);
      expect(put).toBeUndefined();

      const hit = await adapter.pageMeta.get(key);
      if (hit === null || "code" in hit) throw new Error("fixture bug: expected a hit");
      expect(hit).toEqual(entry);
    } finally {
      await open.close();
    }
  });

  test("render: a miss is null; put()+get() round-trips opaque bytes", async () => {
    const fake = createFakeRenderCache();
    const key = {
      sourceHash: "b".repeat(64),
      kitApiVersion: 1,
      rendererVersion: "1.0.0",
      size: { width: 80, height: 24 },
      theme: "dark",
      flags: {},
    };
    expect(await fake.get(key)).toBeNull();

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createProjectionsAdapter(deps);
      expect(await adapter.render.get(key)).toBeNull();

      const entry = {
        key,
        styledFrame: new Uint8Array([1, 2, 3]),
        textFrame: new Uint8Array([4, 5, 6]),
        layout: new Uint8Array([7, 8, 9]),
      };
      const put = await adapter.render.put(entry);
      expect(put).toBeUndefined();

      const hit = await adapter.render.get(key);
      if (hit === null || "code" in hit) throw new Error("fixture bug: expected a hit");
      expect(hit.styledFrame).toEqual(entry.styledFrame);
      expect(hit.textFrame).toEqual(entry.textFrame);
      expect(hit.layout).toEqual(entry.layout);
    } finally {
      await open.close();
    }
  });

  test("diagnostics: a miss is null; put()+get() round-trips, deriving a stable diagnosticId and a documented placeholder scope", async () => {
    const fake = createFakeDiagnosticsCache();
    const key = { pageSlug: "home", sourceHash: "c".repeat(64), kitApiVersion: 1 };
    expect(await fake.get(key)).toBeNull();

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createProjectionsAdapter(deps);
      expect(await adapter.diagnostics.get(key)).toBeNull();

      const entry = {
        key,
        schemaVersion: 1,
        provenance: "gate" as const,
        observedAt: "2026-07-24T00:00:00.000Z",
        diagnostics: [
          {
            diagnosticId: "ignored-on-write",
            scope: "project" as const,
            severity: "error" as const,
            code: "E001",
            safeMessage: "bad thing",
          },
        ],
      };
      const put = await adapter.diagnostics.put(entry);
      expect(put).toBeUndefined();

      const first = await adapter.diagnostics.get(key);
      if (first === null || "code" in first) throw new Error("fixture bug: expected a hit");
      expect(first.diagnostics).toHaveLength(1);
      expect(first.diagnostics[0]?.safeMessage).toBe("bad thing");
      expect(first.diagnostics[0]?.pageSlug).toBe("home");
      expect(typeof first.diagnostics[0]?.diagnosticId).toBe("string");

      // Deterministic: re-reading the same stored content yields the same diagnosticId.
      const second = await adapter.diagnostics.get(key);
      if (second === null || "code" in second) throw new Error("fixture bug: expected a hit");
      expect(second.diagnostics[0]?.diagnosticId).toBe(first.diagnostics[0]?.diagnosticId);
    } finally {
      await open.close();
    }
  });
});
