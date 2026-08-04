import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import path from "node:path";

import type { Clock } from "infrastructure/clock";

import type { DiagnosticsEntry, DiagnosticsKey, ProjectionFsDeps } from "../types";
import {
  DIAGNOSTICS_STORE_GENERATION,
  DiagnosticsStoreIoError,
  createDiagnosticsStore,
} from "./diagnostics-store";

const ROOT = "C:/project/.termcraft/diagnostics";

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
const clock: Clock = { now: () => new Date(currentTime) };
function advanceClock(ms: number): void {
  currentTime += ms;
}

function storeOver(
  memory: ReturnType<typeof memoryFs>,
  options?: {
    quotaBytes?: number;
    isPinned?: (key: DiagnosticsKey) => boolean;
    storeGeneration?: number;
  },
) {
  return createDiagnosticsStore({ root: ROOT, fs: memory.deps, clock, ...options });
}

const baseKey: DiagnosticsKey = {
  pageSlug: "home",
  closureHash: "a".repeat(64),
  kitApiVersion: 1,
};
const baseEntry: DiagnosticsEntry = {
  key: baseKey,
  schemaVersion: 1,
  provenance: "gate",
  observedAt: "2026-07-20T10:00:00.000Z",
  diagnostics: [
    {
      code: "TS2304",
      severity: "error",
      message: "Cannot find name 'x'.",
      range: { line: 3, column: 5 },
    },
  ],
};

function entryHash(key: DiagnosticsKey): string {
  const canonical = [key.pageSlug, key.closureHash, String(key.kitApiVersion)].join(" ");
  return crypto.createHash("sha256").update(new TextEncoder().encode(canonical)).digest("hex");
}

describe("createDiagnosticsStore", () => {
  test("an exact-key put is an exact-key hit", async () => {
    const memory = memoryFs();
    const store = storeOver(memory);

    expect(await store.put(baseEntry)).toBeUndefined();
    expect(await store.get(baseKey)).toEqual(baseEntry);
  });

  test("changing pageSlug alone is a miss, and a subsequent put rebuilds it into a fresh hit", async () => {
    const memory = memoryFs();
    const store = storeOver(memory);
    await store.put(baseEntry);

    const changedKey: DiagnosticsKey = { ...baseKey, pageSlug: "about" };
    expect(await store.get(changedKey)).toBeNull();

    const rebuilt: DiagnosticsEntry = { ...baseEntry, key: changedKey };
    expect(await store.put(rebuilt)).toBeUndefined();
    expect(await store.get(changedKey)).toEqual(rebuilt);
  });

  test("changing closureHash alone is a miss — no diagnostic cross-talk between closure-identical-looking pages", async () => {
    const memory = memoryFs();
    const store = storeOver(memory);
    await store.put(baseEntry);

    const changedKey: DiagnosticsKey = { ...baseKey, closureHash: "b".repeat(64) };
    expect(await store.get(changedKey)).toBeNull();
  });

  test("changing kitApiVersion alone is a miss (§6.1: diagnostics miss even with identical source bytes)", async () => {
    const memory = memoryFs();
    const store = storeOver(memory);
    await store.put(baseEntry);

    const changedKey: DiagnosticsKey = { ...baseKey, kitApiVersion: 2 };
    expect(await store.get(changedKey)).toBeNull();
  });

  test("a malformed entry is a miss, not an error", async () => {
    const memory = memoryFs();
    const store = storeOver(memory);
    await store.put(baseEntry);

    memory.poison(path.join(ROOT, `${entryHash(baseKey)}.json`), "not json at all");
    expect(await store.get(baseKey)).toBeNull();
  });

  test("a store-generation bump rebuilds the entry, and the rebuild touches only the local diagnostics root", async () => {
    const memory = memoryFs();
    const generationOne = storeOver(memory, { storeGeneration: 1 });
    await generationOne.put(baseEntry);
    expect(await generationOne.get(baseKey)).toEqual(baseEntry);

    const generationTwo = storeOver(memory, { storeGeneration: 2 });
    expect(await generationTwo.get(baseKey)).toBeNull();

    expect(await generationTwo.put(baseEntry)).toBeUndefined();
    expect(await generationTwo.get(baseKey)).toEqual(baseEntry);

    const normalizedRoot = path.normalize(ROOT);
    for (const key of memory.files.keys()) expect(key.startsWith(normalizedRoot)).toBe(true);
  });

  test("the real DIAGNOSTICS_STORE_GENERATION bump this task makes (1 -> 2) invalidates a pre-bump entry under the DEFAULT store", async () => {
    // Not the generic mechanism test above (which pins its own 1/2 pair regardless of the
    // module constant) — this one is tied to the actual bump design-tree phase 2 Task 7 makes,
    // re-keying `DiagnosticsKey.sourceHash` -> `closureHash`. `DIAGNOSTICS_STORE_GENERATION`
    // itself is the proof the bump landed; the behavioral half proves it actually invalidates
    // old data rather than surfacing a schema-validation error where a caller expects a miss.
    expect(DIAGNOSTICS_STORE_GENERATION).toBe(2);

    const memory = memoryFs();
    const preTask7 = storeOver(memory, { storeGeneration: 1 }); // simulates an entry written under the old generation
    await preTask7.put(baseEntry);
    expect(await preTask7.get(baseKey)).toEqual(baseEntry);

    const current = storeOver(memory); // no override — the real, current DIAGNOSTICS_STORE_GENERATION
    expect(await current.get(baseKey)).toBeNull();
  });

  test("no chat id anywhere in the key or entry shape", () => {
    // Compile-time/structural guard: DiagnosticsKey and DiagnosticsEntry simply have no
    // chat-id-shaped field to assign — this test documents the invariant for a reader.
    const key: DiagnosticsKey = baseKey;
    const entry: DiagnosticsEntry = baseEntry;
    expect(Object.keys(key)).toEqual(["pageSlug", "closureHash", "kitApiVersion"]);
    expect(Object.keys(entry)).toEqual([
      "key",
      "schemaVersion",
      "provenance",
      "observedAt",
      "diagnostics",
    ]);
  });

  test("quota eviction removes the least-recently-written unpinned entry once the quota is exceeded", async () => {
    const memory = memoryFs();
    // `quotaBytes` here is a raw injected value (this store trusts it as pre-validated —
    // see `resolveQuota`'s doc comment), so a test can pick a tiny quota that exercises
    // eviction without generating megabytes of fixture data.
    const quotaBytes = 600;
    const store = storeOver(memory, { quotaBytes });

    // Pad the message so each entry's envelope is a meaningful fraction of the tiny quota.
    const padded = (key: DiagnosticsKey): DiagnosticsEntry => ({
      ...baseEntry,
      key,
      diagnostics: [
        { code: "PAD", severity: "info", message: "x".repeat(Math.floor(quotaBytes / 3)) },
      ],
    });

    const keyA: DiagnosticsKey = { ...baseKey, pageSlug: "a" };
    const keyB: DiagnosticsKey = { ...baseKey, pageSlug: "b" };
    const keyC: DiagnosticsKey = { ...baseKey, pageSlug: "c" };

    await store.put(padded(keyA));
    advanceClock(1000);
    await store.put(padded(keyB));
    advanceClock(1000);
    await store.put(padded(keyC)); // pushes total over the tiny quota — A is oldest and unpinned

    expect(await store.get(keyA)).toBeNull();
    expect(await store.get(keyC)).not.toBeNull();
  });

  test("a pinned key survives an eviction sweep that would otherwise remove it", async () => {
    const memory = memoryFs();
    const quotaBytes = 600;
    const pinnedSlug = "pinned";
    const store = storeOver(memory, { quotaBytes, isPinned: (key) => key.pageSlug === pinnedSlug });

    const padded = (key: DiagnosticsKey): DiagnosticsEntry => ({
      ...baseEntry,
      key,
      diagnostics: [
        { code: "PAD", severity: "info", message: "x".repeat(Math.floor(quotaBytes / 3)) },
      ],
    });

    const pinnedKey: DiagnosticsKey = { ...baseKey, pageSlug: pinnedSlug };
    const keyB: DiagnosticsKey = { ...baseKey, pageSlug: "b" };
    const keyC: DiagnosticsKey = { ...baseKey, pageSlug: "c" };

    await store.put(padded(pinnedKey));
    advanceClock(1000);
    await store.put(padded(keyB));
    advanceClock(1000);
    await store.put(padded(keyC));

    expect(await store.get(pinnedKey)).not.toBeNull(); // oldest, but pinned — survives
  });

  test("put surfaces a durable-write failure as a tagged error", async () => {
    const memory = memoryFs();
    memory.failWrites(new Error("disk full"));
    const store = storeOver(memory);

    expect(await store.put(baseEntry)).toBeInstanceOf(DiagnosticsStoreIoError);
  });

  test("get surfaces a genuine read failure as a tagged error (not a silent miss)", async () => {
    const memory = memoryFs();
    memory.failReads(new Error("permission denied"));
    const store = storeOver(memory);

    expect(await store.get(baseKey)).toBeInstanceOf(DiagnosticsStoreIoError);
  });
});
