import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";

import {
  createFakeDiagnosticsCache,
  createFakePageMetaCache,
  createFakeRenderCache,
} from "./projections";

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "cache unreadable",
  details: {},
};

describe("createFakePageMetaCache", () => {
  test("get() misses (null) for a key that was never put — never an error", async () => {
    const cache = createFakePageMetaCache();
    const key = { pageSlug: "home", closureHash: "a".repeat(64), extractorVersion: 1 };
    expect(await cache.get(key)).toBeNull();
  });

  test("put() then get() round-trips the exact entry", async () => {
    const cache = createFakePageMetaCache();
    const key = { pageSlug: "home", closureHash: "a".repeat(64), extractorVersion: 1 };
    const entry = {
      key,
      meta: { kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "default" },
    };
    await cache.put(entry);
    expect(await cache.get(key)).toEqual(entry);
  });

  test("a key with a different closureHash is a distinct cache slot (a miss)", async () => {
    const cache = createFakePageMetaCache();
    const key1 = { pageSlug: "home", closureHash: "a".repeat(64), extractorVersion: 1 };
    const key2 = { pageSlug: "home", closureHash: "b".repeat(64), extractorVersion: 1 };
    await cache.put({
      key: key1,
      meta: { kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "default" },
    });
    expect(await cache.get(key2)).toBeNull();
  });

  test("failNext() queues one failure for get()", async () => {
    const cache = createFakePageMetaCache();
    const key = { pageSlug: "home", closureHash: "a".repeat(64), extractorVersion: 1 };
    cache.failNext("get", FAILURE);
    expect(await cache.get(key)).toEqual(FAILURE);
    expect(await cache.get(key)).toBeNull();
  });
});

describe("createFakeDiagnosticsCache", () => {
  test("put() then get() round-trips", async () => {
    const cache = createFakeDiagnosticsCache();
    const key = { pageSlug: "home", closureHash: "a".repeat(64), kitApiVersion: 1 };
    const entry = {
      key,
      schemaVersion: 1,
      provenance: "gate" as const,
      observedAt: "2024-01-01T00:00:00.000Z",
      diagnostics: [],
    };
    await cache.put(entry);
    expect(await cache.get(key)).toEqual(entry);
  });
});

describe("createFakeRenderCache", () => {
  test("put() then get() round-trips opaque render bytes", async () => {
    const cache = createFakeRenderCache();
    const key = {
      closureHash: "a".repeat(64),
      kitApiVersion: 1,
      rendererVersion: "1",
      size: { width: 80, height: 24 },
      theme: "default",
      flags: {},
    };
    const entry = {
      key,
      styledFrame: new Uint8Array([1]),
      textFrame: new Uint8Array([2]),
      layout: new Uint8Array([3]),
    };
    await cache.put(entry);
    expect(await cache.get(key)).toEqual(entry);
  });

  test("records get/put calls in order across all three caches independently", async () => {
    const pageMeta = createFakePageMetaCache();
    const key = { pageSlug: "home", closureHash: "a".repeat(64), extractorVersion: 1 };
    await pageMeta.get(key);
    await pageMeta.put({
      key,
      meta: { kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "default" },
    });
    expect(pageMeta.calls.map((c) => c.method)).toEqual(["get", "put"]);
  });
});
