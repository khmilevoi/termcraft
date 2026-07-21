import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import path from "node:path";

import type { ExportRenderKey, ProjectionFsDeps, RenderEntry } from "../types";
import { RenderCacheIoError, canonicalizeExportRenderKey, createRenderCache } from "./render-cache";

const ROOT = "C:/project/.termcraft/cache/export-render";

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
      const normalizedDir = path.normalize(absDir);
      const names: string[] = [];
      for (const key of files.keys()) {
        if (path.dirname(key) === normalizedDir) names.push(path.basename(key));
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

let currentTime = new Date("2026-07-20T10:00:00.000Z").getTime();
const clock = { now: () => new Date(currentTime) };
function advanceClock(ms: number): void {
  currentTime += ms;
}

function cacheOver(
  memory: ReturnType<typeof memoryFs>,
  options?: {
    quotaBytes?: number;
    isPinned?: (key: ExportRenderKey) => boolean;
    storeGeneration?: number;
  },
) {
  return createRenderCache({ root: ROOT, fs: memory.deps, clock, ...options });
}

const baseKey: ExportRenderKey = {
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  rendererVersion: "1.0.0",
  size: { width: 80, height: 24 },
  theme: "dark",
  flags: { unicode: true, colorDepth: 256 },
};

const baseEntry: RenderEntry = {
  key: baseKey,
  styledFrame: new TextEncoder().encode("styled-bytes"),
  textFrame: new TextEncoder().encode("text-bytes"),
  layout: new TextEncoder().encode("layout-bytes"),
};

function entryHash(key: ExportRenderKey): string {
  return crypto
    .createHash("sha256")
    .update(new TextEncoder().encode(canonicalizeExportRenderKey(key)))
    .digest("hex");
}

describe("canonicalizeExportRenderKey", () => {
  test("flags are sorted regardless of the caller's insertion order", () => {
    const a: ExportRenderKey = { ...baseKey, flags: { unicode: true, colorDepth: 256 } };
    const b: ExportRenderKey = { ...baseKey, flags: { colorDepth: 256, unicode: true } };
    expect(canonicalizeExportRenderKey(a)).toBe(canonicalizeExportRenderKey(b));
  });
});

describe("createRenderCache", () => {
  test("an exact-key put is an exact-key hit, with byte-exact buffers", async () => {
    const memory = memoryFs();
    const cache = cacheOver(memory);

    expect(await cache.put(baseEntry)).toBeUndefined();
    const hit = await cache.get(baseKey);
    expect(hit).not.toBeInstanceOf(Error);
    if (hit instanceof Error || hit === null) throw new Error("expected a hit");
    expect(hit.key).toEqual(baseKey);
    expect(Buffer.from(hit.styledFrame)).toEqual(Buffer.from(baseEntry.styledFrame));
    expect(Buffer.from(hit.textFrame)).toEqual(Buffer.from(baseEntry.textFrame));
    expect(Buffer.from(hit.layout)).toEqual(Buffer.from(baseEntry.layout));
  });

  test("a hit is served regardless of the requester's flags insertion order", async () => {
    const memory = memoryFs();
    const cache = cacheOver(memory);
    await cache.put(baseEntry);

    const reordered: ExportRenderKey = { ...baseKey, flags: { colorDepth: 256, unicode: true } };
    expect(await cache.get(reordered)).not.toBeNull();
  });

  test.each([
    ["sourceHash", { ...baseKey, sourceHash: "b".repeat(64) }],
    ["kitApiVersion", { ...baseKey, kitApiVersion: 2 }],
    ["rendererVersion", { ...baseKey, rendererVersion: "2.0.0" }],
    ["size", { ...baseKey, size: { width: 100, height: 24 } }],
    ["theme", { ...baseKey, theme: "light" }],
    ["flags", { ...baseKey, flags: { unicode: false, colorDepth: 256 } }],
  ] as const)(
    "changing %s alone is a miss, and a subsequent put rebuilds it into a fresh hit",
    async (_field, changedKey) => {
      const memory = memoryFs();
      const cache = cacheOver(memory);
      await cache.put(baseEntry);

      expect(await cache.get(changedKey)).toBeNull();

      const rebuilt: RenderEntry = { ...baseEntry, key: changedKey };
      expect(await cache.put(rebuilt)).toBeUndefined();
      const hit = await cache.get(changedKey);
      expect(hit).not.toBeNull();
      expect(hit).not.toBeInstanceOf(Error);
    },
  );

  test("a malformed entry is a miss, not an error", async () => {
    const memory = memoryFs();
    const cache = cacheOver(memory);
    await cache.put(baseEntry);

    memory.poison(path.join(ROOT, `${entryHash(baseKey)}.json`), "not json");
    expect(await cache.get(baseKey)).toBeNull();
  });

  test("a corrupted buffer (checksum mismatch) is a miss", async () => {
    const memory = memoryFs();
    const cache = cacheOver(memory);
    await cache.put(baseEntry);

    const target = path.join(ROOT, `${entryHash(baseKey)}.json`);
    const raw = memory.files.get(target);
    if (raw === undefined) throw new Error("expected a written entry");
    const envelope = JSON.parse(new TextDecoder().decode(raw)) as {
      styledFrame: { base64: string };
    };
    envelope.styledFrame.base64 = Buffer.from("tampered").toString("base64");
    memory.poison(target, JSON.stringify(envelope));

    expect(await cache.get(baseKey)).toBeNull();
  });

  test("a store-generation bump rebuilds the entry, and the rebuild touches only the local render-cache root", async () => {
    const memory = memoryFs();
    const generationOne = cacheOver(memory, { storeGeneration: 1 });
    await generationOne.put(baseEntry);
    expect(await generationOne.get(baseKey)).not.toBeNull();

    const generationTwo = cacheOver(memory, { storeGeneration: 2 });
    expect(await generationTwo.get(baseKey)).toBeNull();

    expect(await generationTwo.put(baseEntry)).toBeUndefined();
    expect(await generationTwo.get(baseKey)).not.toBeNull();

    const normalizedRoot = path.normalize(ROOT);
    for (const key of memory.files.keys()) expect(key.startsWith(normalizedRoot)).toBe(true);
  });

  test("quota eviction removes the least-recently-written unpinned entry once the quota is exceeded", async () => {
    const memory = memoryFs();
    const quotaBytes = 600;
    const cache = cacheOver(memory, { quotaBytes });

    const bigBytes = (n: number) => new TextEncoder().encode("x".repeat(n));
    const padded = (key: ExportRenderKey): RenderEntry => ({
      key,
      styledFrame: bigBytes(Math.floor(quotaBytes / 3)),
      textFrame: new Uint8Array(0),
      layout: new Uint8Array(0),
    });

    const keyA: ExportRenderKey = { ...baseKey, theme: "a" };
    const keyB: ExportRenderKey = { ...baseKey, theme: "b" };
    const keyC: ExportRenderKey = { ...baseKey, theme: "c" };

    await cache.put(padded(keyA));
    advanceClock(1000);
    await cache.put(padded(keyB));
    advanceClock(1000);
    await cache.put(padded(keyC));

    expect(await cache.get(keyA)).toBeNull();
    expect(await cache.get(keyC)).not.toBeNull();
  });

  test("a pinned key survives an eviction sweep that would otherwise remove it", async () => {
    const memory = memoryFs();
    const quotaBytes = 600;
    const pinnedTheme = "pinned";
    const cache = cacheOver(memory, { quotaBytes, isPinned: (key) => key.theme === pinnedTheme });

    const bigBytes = (n: number) => new TextEncoder().encode("x".repeat(n));
    const padded = (key: ExportRenderKey): RenderEntry => ({
      key,
      styledFrame: bigBytes(Math.floor(quotaBytes / 3)),
      textFrame: new Uint8Array(0),
      layout: new Uint8Array(0),
    });

    const pinnedKey: ExportRenderKey = { ...baseKey, theme: pinnedTheme };
    const keyB: ExportRenderKey = { ...baseKey, theme: "b" };
    const keyC: ExportRenderKey = { ...baseKey, theme: "c" };

    await cache.put(padded(pinnedKey));
    advanceClock(1000);
    await cache.put(padded(keyB));
    advanceClock(1000);
    await cache.put(padded(keyC));

    expect(await cache.get(pinnedKey)).not.toBeNull();
  });

  test("put surfaces a durable-write failure as a tagged error", async () => {
    const memory = memoryFs();
    memory.failWrites(new Error("disk full"));
    const cache = cacheOver(memory);

    expect(await cache.put(baseEntry)).toBeInstanceOf(RenderCacheIoError);
  });

  test("get surfaces a genuine read failure as a tagged error (not a silent miss)", async () => {
    const memory = memoryFs();
    memory.failReads(new Error("permission denied"));
    const cache = cacheOver(memory);

    expect(await cache.get(baseKey)).toBeInstanceOf(RenderCacheIoError);
  });
});
