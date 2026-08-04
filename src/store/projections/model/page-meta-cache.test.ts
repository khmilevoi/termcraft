import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import path from "node:path";

import type { Clock } from "infrastructure/clock";

import type { PageMetaEntry, PageMetaKey, ProjectionFsDeps } from "../types";
import {
  PAGE_META_CACHE_GENERATION,
  PageMetaCacheIoError,
  createPageMetaCache,
} from "./page-meta-cache";

const ROOT = "C:/project/.termcraft/cache/page-meta";

/** An in-memory `ProjectionFsDeps` — no real filesystem touched, deterministic and fast. */
function memoryFs() {
  const files = new Map<string, Uint8Array>();
  let failWrite: Error | null = null;
  let failRead: Error | null = null;

  const deps: ProjectionFsDeps = {
    readFile(absPath) {
      if (failRead !== null) return failRead;
      return files.get(absPath) ?? null;
    },
    durableWrite(absPath, bytes) {
      if (failWrite !== null) return failWrite;
      files.set(absPath, bytes);
      return undefined;
    },
    remove(absPath) {
      files.delete(absPath);
      return undefined;
    },
    listFiles(absDir) {
      const names: string[] = [];
      for (const key of files.keys()) {
        if (path.dirname(key) === absDir) names.push(path.basename(key));
      }
      return names;
    },
    ensureDir() {
      return undefined;
    },
  };

  return {
    deps,
    files,
    failWrites(error: Error) {
      failWrite = error;
    },
    failReads(error: Error) {
      failRead = error;
    },
    poison(absPath: string, text: string) {
      files.set(absPath, new TextEncoder().encode(text));
    },
  };
}

const clock: Clock = { now: () => new Date("2026-07-20T10:00:00.000Z") };

function cacheOver(memory: ReturnType<typeof memoryFs>, storeGeneration?: number) {
  return createPageMetaCache({ root: ROOT, fs: memory.deps, clock, storeGeneration });
}

const baseKey: PageMetaKey = { pageSlug: "home", closureHash: "a".repeat(64), extractorVersion: 1 };
const baseEntry: PageMetaEntry = {
  key: baseKey,
  meta: { kitApiVersion: 1, title: "Home", minSize: { w: 40, h: 12 }, theme: "dark" },
};

describe("createPageMetaCache", () => {
  test("an exact-key put is an exact-key hit", async () => {
    const memory = memoryFs();
    const cache = cacheOver(memory);

    const wrote = await cache.put(baseEntry);
    expect(wrote).toBeUndefined();

    const hit = await cache.get(baseKey);
    expect(hit).toEqual(baseEntry);
  });

  test("changing pageSlug alone is a miss, and a subsequent put rebuilds it into a fresh hit", async () => {
    const memory = memoryFs();
    const cache = cacheOver(memory);
    await cache.put(baseEntry);

    const changedKey: PageMetaKey = { ...baseKey, pageSlug: "about" };
    expect(await cache.get(changedKey)).toBeNull();

    const rebuilt: PageMetaEntry = { ...baseEntry, key: changedKey };
    expect(await cache.put(rebuilt)).toBeUndefined();
    expect(await cache.get(changedKey)).toEqual(rebuilt);
    // The original key's entry is untouched by the rebuild of a different key.
    expect(await cache.get(baseKey)).toEqual(baseEntry);
  });

  test("changing closureHash alone is a miss — never falls back to a different closure hash", async () => {
    const memory = memoryFs();
    const cache = cacheOver(memory);
    await cache.put(baseEntry);

    const changedKey: PageMetaKey = { ...baseKey, closureHash: "b".repeat(64) };
    expect(await cache.get(changedKey)).toBeNull();
  });

  test("changing extractorVersion alone is a miss", async () => {
    const memory = memoryFs();
    const cache = cacheOver(memory);
    await cache.put(baseEntry);

    const changedKey: PageMetaKey = { ...baseKey, extractorVersion: 2 };
    expect(await cache.get(changedKey)).toBeNull();
  });

  test("a malformed entry (invalid JSON) is a miss, not an error", async () => {
    const memory = memoryFs();
    const cache = cacheOver(memory);
    await cache.put(baseEntry);

    const target = path.join(ROOT, `${cacheEntryHash(baseKey)}.json`);
    memory.poison(target, "{ not valid json");

    expect(await cache.get(baseKey)).toBeNull();
  });

  test("a malformed entry (schema violation) is a miss", async () => {
    const memory = memoryFs();
    const cache = cacheOver(memory);
    await cache.put(baseEntry);

    const target = path.join(ROOT, `${cacheEntryHash(baseKey)}.json`);
    memory.poison(target, JSON.stringify({ envelopeVersion: 1 }));

    expect(await cache.get(baseKey)).toBeNull();
  });

  test("a checksum mismatch (tampered value) is a miss", async () => {
    const memory = memoryFs();
    const cache = cacheOver(memory);
    await cache.put(baseEntry);

    const target = path.join(ROOT, `${cacheEntryHash(baseKey)}.json`);
    const raw = memory.files.get(target);
    if (raw === undefined) throw new Error("expected a written entry");
    const envelope = JSON.parse(new TextDecoder().decode(raw)) as { value: { title: string } };
    envelope.value.title = "Tampered";
    memory.poison(target, JSON.stringify(envelope));

    expect(await cache.get(baseKey)).toBeNull();
  });

  test("a store-generation bump rebuilds the entry, and the rebuild touches only the local cache root", async () => {
    const memory = memoryFs();
    const generationOne = cacheOver(memory, 1);
    await generationOne.put(baseEntry);
    expect(await generationOne.get(baseKey)).toEqual(baseEntry);

    const generationTwo = cacheOver(memory, 2);
    expect(await generationTwo.get(baseKey)).toBeNull(); // old-generation entry misses under the bumped generation

    expect(await generationTwo.put(baseEntry)).toBeUndefined();
    expect(await generationTwo.get(baseKey)).toEqual(baseEntry);

    // Every write this whole scenario ever made stayed under the injected local cache
    // root — nothing resembling a portable write (e.g. a `project.toml` path) occurred.
    const normalizedRoot = path.normalize(ROOT);
    for (const key of memory.files.keys()) expect(key.startsWith(normalizedRoot)).toBe(true);
  });

  test("the real PAGE_META_CACHE_GENERATION bump this task makes (1 -> 2) invalidates a pre-bump entry under the DEFAULT cache", async () => {
    // Not the generic mechanism test above (which pins its own 1/2 pair regardless of the
    // module constant) — this one is tied to the actual bump design-tree phase 2 Task 6 makes,
    // re-keying `PageMetaKey.sourceHash` -> `closureHash`. `PAGE_META_CACHE_GENERATION` itself
    // is the proof the bump landed; the behavioral half proves it actually invalidates old data.
    expect(PAGE_META_CACHE_GENERATION).toBe(2);

    const memory = memoryFs();
    const preTask6 = cacheOver(memory, 1); // simulates an entry written under the old generation
    await preTask6.put(baseEntry);
    expect(await preTask6.get(baseKey)).toEqual(baseEntry);

    const current = cacheOver(memory); // no override — the real, current PAGE_META_CACHE_GENERATION
    expect(await current.get(baseKey)).toBeNull();
  });

  test("put surfaces a durable-write failure as a tagged error", async () => {
    const memory = memoryFs();
    memory.failWrites(new Error("disk full"));
    const cache = cacheOver(memory);

    const result = await cache.put(baseEntry);
    expect(result).toBeInstanceOf(PageMetaCacheIoError);
  });

  test("get surfaces a genuine read failure as a tagged error (not a silent miss)", async () => {
    const memory = memoryFs();
    memory.failReads(new Error("permission denied"));
    const cache = cacheOver(memory);

    const result = await cache.get(baseKey);
    expect(result).toBeInstanceOf(PageMetaCacheIoError);
  });
});

/** Re-derive the content-addressed filename the store itself would compute for `key`, for direct-poison tests. */
function cacheEntryHash(key: PageMetaKey): string {
  const canonical = [key.pageSlug, key.closureHash, String(key.extractorVersion)].join(" ");
  return crypto.createHash("sha256").update(new TextEncoder().encode(canonical)).digest("hex");
}
