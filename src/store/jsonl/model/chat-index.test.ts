import { describe, expect, test } from "bun:test";

import type { ChatRecord } from "entities/chat";

import type {
  ChatIndexCanonicalSource,
  ChatIndexPage,
  ChatIndexPageStore,
  PageCursor,
} from "../types";
import {
  CHAT_INDEX_MAX_RESIDENT_PAGES,
  CHAT_INDEX_PAGE_SIZE,
  ChatIndexCursorStaleError,
  ChatIndexIoError,
  buildChatIndex,
  loadChatIndexBefore,
  loadChatIndexTail,
  updateChatIndex,
} from "./chat-index";
import { encodeChatHeaderLine, encodeChatRecordLine } from "./line-codec";

const PROJECT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10";
const CHAT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11";
const TURN_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20";
const TS = "2026-07-19T10:00:00Z";
const IDENTITY = "unix:2049:123456";
const VIEW_GENERATION = "view-1";

/** A canonical UUIDv7-shaped id carrying a distinct counter in its final group. */
function recordId(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

function unwrap<T>(value: T): Exclude<T, Error> {
  if (value instanceof Error) throw new Error(`unexpected error: ${value.message}`);
  return value as Exclude<T, Error>;
}

function requireCursor(cursor: PageCursor | null): PageCursor {
  if (cursor === null) throw new Error("expected a prevCursor");
  return cursor;
}

function chatHeaderBytes(): Uint8Array {
  return unwrap(
    encodeChatHeaderLine({
      kind: "chat",
      formatVersion: 1,
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      createdAt: TS,
    }),
  );
}

function userRecord(n: number, text = `message ${n}`): ChatRecord {
  return { kind: "user", recordId: recordId(n), turnId: TURN_ID, text, ts: TS };
}

function recordBytes(record: ChatRecord): Uint8Array {
  return unwrap(encodeChatRecordLine(record));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function chunksOf(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += size)
    chunks.push(bytes.subarray(at, Math.min(at + size, bytes.byteLength)));
  return chunks;
}

/** A chat log of `count` short user records after the header, plus the record list used to build it. */
function chatOf(count: number): { bytes: Uint8Array; records: ChatRecord[] } {
  const records = Array.from({ length: count }, (_, i) => userRecord(i + 1));
  const bytes = concat([chatHeaderBytes(), ...records.map(recordBytes)]);
  return { bytes, records };
}

function makeSource(bytes: Uint8Array, chunkSize = 4096): ChatIndexCanonicalSource {
  return {
    openChunks: () => chunksOf(bytes, chunkSize),
    async readRange({ start, end }) {
      return bytes.subarray(Math.max(0, start), Math.min(bytes.byteLength, end));
    },
  };
}

interface FakePageStore extends ChatIndexPageStore {
  readonly pages: Map<string, ChatIndexPage>;
  writeCount: number;
  readCount: number;
}

function makePageStore(): FakePageStore {
  const pages = new Map<string, ChatIndexPage>();
  const fake: FakePageStore = {
    pages,
    writeCount: 0,
    readCount: 0,
    async writePage(chatId, page) {
      fake.writeCount += 1;
      pages.set(`${chatId}:${page.pageIndex}`, page);
      return undefined;
    },
    async readPage(chatId, pageIndex) {
      fake.readCount += 1;
      return pages.get(`${chatId}:${pageIndex}`) ?? null;
    },
  };
  return fake;
}

async function buildFor(
  bytes: Uint8Array,
  pages: ChatIndexPageStore,
  projectViewGeneration = VIEW_GENERATION,
) {
  return buildChatIndex({
    chatId: CHAT_ID,
    canonicalIdentity: IDENTITY,
    projectViewGeneration,
    source: makeSource(bytes),
    deps: { pages },
  });
}

describe("build", () => {
  test("a clean small chat indexes every record with generation 1", async () => {
    const { bytes, records } = chatOf(3);
    const pages = makePageStore();
    const state = unwrap(await buildFor(bytes, pages));

    expect(state.generation).toBe(1);
    expect(state.tail.kind).toBe("clean");
    expect(state.totalBytes).toBe(bytes.byteLength);
    expect(state.validPrefixBytes).toBe(bytes.byteLength);
    expect(state.pages).toHaveLength(1);
    expect(state.pages[0]?.entryCount).toBe(3);

    const loaded = unwrap(await loadChatIndexTail(state, { pages }, makeSource(bytes)));
    expect(loaded.records.map((r) => r.recordId)).toEqual(records.map((r) => r.recordId));
    expect(loaded.prevCursor).toBeNull();
  });

  test("a header-only chat has no entries and no pages", async () => {
    const pages = makePageStore();
    const state = unwrap(await buildFor(chatHeaderBytes(), pages));
    expect(state.pages).toEqual([]);
    expect(state.validPrefixBytes).toBe(chatHeaderBytes().byteLength);

    const loaded = unwrap(await loadChatIndexTail(state, { pages }, makeSource(chatHeaderBytes())));
    expect(loaded.records).toEqual([]);
    expect(loaded.prevCursor).toBeNull();
  });

  test("never stores record bodies — only the four indexed fields plus offsets", async () => {
    const { bytes } = chatOf(2);
    const pages = makePageStore();
    await buildFor(bytes, pages);
    const page = pages.pages.get(`${CHAT_ID}:0`);
    const entry = page?.entries[0];
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "changedPages",
      "offsetEnd",
      "offsetStart",
      "recordId",
      "ts",
      "turnId",
    ]);
  });
});

describe("a 100k-record fixture builds with bounded resident memory", () => {
  test("pages independently in ≤512-entry pages, one page store write per page", async () => {
    const { bytes, records } = chatOf(100_000);
    const pages = makePageStore();
    const state = unwrap(await buildFor(bytes, pages));

    const expectedPageCount = Math.ceil(records.length / CHAT_INDEX_PAGE_SIZE);
    expect(state.pages).toHaveLength(expectedPageCount);
    expect(pages.writeCount).toBe(expectedPageCount);
    // The steady-state resident structure is the lightweight directory, never the bodies:
    // every persisted page stays within the §7.1 bound, and the directory itself carries
    // only offsets/counts/checksums (no record text ever appears in it).
    for (const dirEntry of state.pages)
      expect(dirEntry.entryCount).toBeLessThanOrEqual(CHAT_INDEX_PAGE_SIZE);

    pages.readCount = 0;
    const loaded = unwrap(await loadChatIndexTail(state, { pages }, makeSource(bytes)));
    expect(loaded.records.map((r) => r.recordId)).toEqual(
      records.slice(-100).map((r) => r.recordId),
    );
    // One `loadTail` call never touches more than the resident-page bound (§7.1).
    expect(pages.readCount).toBeLessThanOrEqual(CHAT_INDEX_MAX_RESIDENT_PAGES);
  }, 30_000);
});

describe("append fast path vs forced rebuild (§7.4)", () => {
  test("an unchanged prefix with a longer file takes the append fast path", async () => {
    const { bytes: before } = chatOf(3);
    const pages = makePageStore();
    const first = unwrap(await buildFor(before, pages));

    const after = concat([before, recordBytes(userRecord(4)), recordBytes(userRecord(5))]);
    const updated = unwrap(
      await updateChatIndex(first, {
        canonicalIdentity: IDENTITY,
        projectViewGeneration: VIEW_GENERATION,
        totalBytes: after.byteLength,
        source: makeSource(after),
        deps: { pages },
      }),
    );

    expect(updated.generation).toBe(first.generation); // no rebuild — fast path
    expect(updated.validPrefixBytes).toBe(after.byteLength);

    const loaded = unwrap(await loadChatIndexTail(updated, { pages }, makeSource(after)));
    expect(loaded.records.map((r) => r.recordId)).toEqual([1, 2, 3, 4, 5].map(recordId));
  });

  test("no new bytes leaves the state untouched", async () => {
    const { bytes } = chatOf(2);
    const pages = makePageStore();
    const first = unwrap(await buildFor(bytes, pages));
    const updated = unwrap(
      await updateChatIndex(first, {
        canonicalIdentity: IDENTITY,
        projectViewGeneration: VIEW_GENERATION,
        totalBytes: bytes.byteLength,
        source: makeSource(bytes),
        deps: { pages },
      }),
    );
    expect(updated).toEqual(first);
  });

  test("a partial final line leaves the previous scan's tail non-clean, which forces the next update to rebuild", async () => {
    const { bytes } = chatOf(2);
    const partial = recordBytes(userRecord(3)).subarray(0, -1); // valid JSON, no terminating LF
    const withPartial = concat([bytes, partial]);

    const pages = makePageStore();
    const first = unwrap(await buildFor(withPartial, pages));
    expect(first.tail.kind).not.toBe("clean"); // an uncommitted suffix, per §11.3 case 2

    const updated = unwrap(
      await updateChatIndex(first, {
        canonicalIdentity: IDENTITY,
        projectViewGeneration: VIEW_GENERATION,
        totalBytes: withPartial.byteLength, // same bytes — isolates the tail-cleanliness rule
        source: makeSource(withPartial),
        deps: { pages },
      }),
    );
    expect(updated.generation).toBe(first.generation + 1); // forced rebuild, not a silent no-op
    expect(updated.pages).toEqual(first.pages); // rebuild reproduces the same two-record prefix
  });

  test("a file shorter than the stored valid prefix (truncation) forces a rebuild", async () => {
    const { bytes } = chatOf(5);
    const pages = makePageStore();
    const first = unwrap(await buildFor(bytes, pages));

    const truncated = bytes.subarray(0, bytes.byteLength - 10);
    const updated = unwrap(
      await updateChatIndex(first, {
        canonicalIdentity: IDENTITY,
        projectViewGeneration: VIEW_GENERATION,
        totalBytes: truncated.byteLength,
        source: makeSource(truncated),
        deps: { pages },
      }),
    );
    expect(updated.generation).toBe(first.generation + 1);
    expect(updated.pages[0]?.entryCount).toBe(4); // the truncated record is dropped by the rebuild
  });

  test("a same-length branch switch forces a rebuild even though the bytes are identical", async () => {
    const { bytes } = chatOf(4);
    const pages = makePageStore();
    const first = unwrap(await buildFor(bytes, pages));

    const updated = unwrap(
      await updateChatIndex(first, {
        canonicalIdentity: IDENTITY,
        projectViewGeneration: "view-2", // same path, same length — only the view generation moved
        totalBytes: bytes.byteLength,
        source: makeSource(bytes),
        deps: { pages },
      }),
    );
    expect(updated.generation).toBe(first.generation + 1);
    expect(updated.projectViewGeneration).toBe("view-2");
  });

  test("a replaced canonical identity forces a rebuild", async () => {
    const { bytes } = chatOf(2);
    const pages = makePageStore();
    const first = unwrap(await buildFor(bytes, pages));

    const updated = unwrap(
      await updateChatIndex(first, {
        canonicalIdentity: "unix:9999:1",
        projectViewGeneration: VIEW_GENERATION,
        totalBytes: bytes.byteLength,
        source: makeSource(bytes),
        deps: { pages },
      }),
    );
    expect(updated.generation).toBe(first.generation + 1);
  });

  test("a rewritten tail window (not a pure append) forces a rebuild rather than trusting the new bytes", async () => {
    // Two byte-identical-length variants that differ only in record 3's text — a hostile
    // same-length in-place rewrite, exactly what §7.4's window hashes exist to catch (the
    // length/identity checks alone cannot see it).
    const shared = [chatHeaderBytes(), recordBytes(userRecord(1)), recordBytes(userRecord(2))];
    const original = concat([...shared, recordBytes(userRecord(3, "AAAAAAAA"))]);
    const rewritten = concat([...shared, recordBytes(userRecord(3, "BBBBBBBB"))]);
    expect(rewritten.byteLength).toBe(original.byteLength);

    const pages = makePageStore();
    const first = unwrap(await buildFor(original, pages));

    const grown = concat([rewritten, recordBytes(userRecord(4))]);
    const updated = unwrap(
      await updateChatIndex(first, {
        canonicalIdentity: IDENTITY,
        projectViewGeneration: VIEW_GENERATION,
        totalBytes: grown.byteLength,
        source: makeSource(grown),
        deps: { pages },
      }),
    );
    expect(updated.generation).toBe(first.generation + 1);
  });
});

describe("resident-page ceiling (§7.1: never more than CHAT_INDEX_MAX_RESIDENT_PAGES pages touched by one call)", () => {
  test("many small single-record appends produce many single-entry pages, and one loadTail call stops at the resident-page cap rather than reading all of them", async () => {
    // Deliberately the OPPOSITE fixture shape from the "100k-record fixture" test above: many
    // small `updateChatIndex` appends (one record each) so the append fast path pages
    // independently every time (chat-index.ts's own documented behavior: "an append never
    // tops up a previous partial last page"), producing far more pages than the
    // CHAT_INDEX_MAX_RESIDENT_PAGES ceiling. This is what actually forces `selectBackward`
    // to hit its `pagesTouched >= CHAT_INDEX_MAX_RESIDENT_PAGES` branch — the pre-existing
    // 100k-record test's single 512-entry-page build can satisfy any `loadTail` request
    // (limit <= 200) from ONE page, so `readCount` there is always 1 and never exercises this
    // branch (finding #10: that assertion was structurally tautological).
    const APPENDS = 20;
    const pages = makePageStore();
    // The base chat starts well past `CHAT_INDEX_WINDOW_BYTES` (4 KiB) so the FIRST window
    // (bytes [0, 4096)) is already stable at build time — every later append then keeps
    // taking the fast path (`updateChatIndex`'s window-hash check only recomputes the FINAL
    // window on each append; while the whole file is still under 4 KiB, "first" and "final"
    // are the same growing window and the fast path's carried-forward `firstWindowSha256`
    // goes stale, forcing an incidental rebuild — orthogonal to what this test is checking).
    const { bytes: baseBytes, records: baseRecords } = chatOf(40);
    let bytes = baseBytes;
    let state = unwrap(await buildFor(bytes, pages));
    expect(bytes.byteLength).toBeGreaterThan(4096);
    expect(state.pages).toHaveLength(1); // the 40-record base fits in one page

    const appendedIds: string[] = [...baseRecords.map((r) => r.recordId)];
    for (let i = baseRecords.length + 1; i <= baseRecords.length + APPENDS; i += 1) {
      const record = userRecord(i);
      appendedIds.push(record.recordId);
      bytes = concat([bytes, recordBytes(record)]);
      state = unwrap(
        await updateChatIndex(state, {
          canonicalIdentity: IDENTITY,
          projectViewGeneration: VIEW_GENERATION,
          totalBytes: bytes.byteLength,
          source: makeSource(bytes),
          deps: { pages },
        }),
      );
    }

    expect(state.pages).toHaveLength(1 + APPENDS); // the base page, plus one page per single-record append
    expect(state.generation).toBe(1); // every append stayed on the fast path — no rebuild

    pages.readCount = 0;
    // No explicit limit: the default (100) and max (200) both exceed the 20 records that
    // exist, so without a resident-page ceiling this would walk every one of the 20 pages.
    const loaded = unwrap(await loadChatIndexTail(state, { pages }, makeSource(bytes)));

    expect(pages.readCount).toBe(CHAT_INDEX_MAX_RESIDENT_PAGES); // the actual ceiling, not merely "<="
    expect(loaded.records).toHaveLength(CHAT_INDEX_MAX_RESIDENT_PAGES); // one entry per page here
    expect(loaded.records.map((r) => r.recordId)).toEqual(
      appendedIds.slice(-CHAT_INDEX_MAX_RESIDENT_PAGES),
    );
    expect(loaded.prevCursor).not.toBeNull(); // older records exist but are unreachable from this call
  });
});

describe("backward pagination follows byte offsets correctly (§7.3)", () => {
  test("loadTail then repeated loadBefore reconstructs the whole chat in order", async () => {
    const { bytes, records } = chatOf(25);
    const pages = makePageStore();
    const state = unwrap(await buildFor(bytes, pages));
    const source = makeSource(bytes);

    const tail = unwrap(await loadChatIndexTail(state, { pages }, source, { limit: 10 }));
    expect(tail.records).toHaveLength(10);
    expect(tail.prevCursor).not.toBeNull();

    const page2 = unwrap(
      await loadChatIndexBefore(state, { pages }, source, requireCursor(tail.prevCursor), {
        limit: 10,
      }),
    );
    expect(page2.records).toHaveLength(10);
    expect(page2.prevCursor).not.toBeNull();

    const page3 = unwrap(
      await loadChatIndexBefore(state, { pages }, source, requireCursor(page2.prevCursor), {
        limit: 10,
      }),
    );
    expect(page3.records).toHaveLength(5);
    expect(page3.prevCursor).toBeNull(); // reached the beginning

    const reassembled = [...page3.records, ...page2.records, ...tail.records].map(
      (r) => r.recordId,
    );
    expect(reassembled).toEqual(records.map((r) => r.recordId));
  });

  test("a cursor from a stale generation is refused", async () => {
    const { bytes } = chatOf(3);
    const pages = makePageStore();
    const state = unwrap(await buildFor(bytes, pages));
    const staleCursor: PageCursor = { generation: state.generation + 1, beforeOffset: 0 };
    const result = await loadChatIndexBefore(state, { pages }, makeSource(bytes), staleCursor);
    expect(result).toBeInstanceOf(ChatIndexCursorStaleError);
  });
});

describe("a single oversized record is returned alone (§7.3)", () => {
  test("a byte budget smaller than the newest record still returns exactly that record", async () => {
    const base = chatHeaderBytes();
    const small = [recordBytes(userRecord(1)), recordBytes(userRecord(2))];
    const hugeBase = JSON.stringify(userRecord(3, "")).length;
    const huge = recordBytes(userRecord(3, "x".repeat(500_000 - hugeBase)));
    const bytes = concat([base, ...small, huge]);

    const pages = makePageStore();
    const state = unwrap(await buildFor(bytes, pages));
    const loaded = unwrap(
      await loadChatIndexTail(state, { pages }, makeSource(bytes), { byteBudget: 1024 }),
    );

    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]?.recordId).toBe(recordId(3));
    expect(loaded.prevCursor).not.toBeNull(); // the two smaller records remain older
  });
});

describe("page store integrity", () => {
  test("a corrupted persisted page surfaces as a ChatIndexIoError instead of bad data", async () => {
    const { bytes } = chatOf(2);
    const pages = makePageStore();
    const state = unwrap(await buildFor(bytes, pages));

    const key = `${CHAT_ID}:0`;
    const page = pages.pages.get(key);
    if (page === undefined) throw new Error("expected page 0 to exist");
    pages.pages.set(key, { ...page, checksum: "0".repeat(64) });

    const result = await loadChatIndexTail(state, { pages }, makeSource(bytes));
    expect(result).toBeInstanceOf(ChatIndexIoError);
  });
});

describe("total record count", () => {
  test("loadTail reports the chat's whole record count, not the page's", async () => {
    const { bytes } = chatOf(250);
    const pages = makePageStore();
    const state = unwrap(await buildFor(bytes, pages));

    const tail = unwrap(await loadChatIndexTail(state, { pages }, makeSource(bytes), { limit: 10 }));
    expect(tail.records).toHaveLength(10);
    expect(tail.totalRecordCount).toBe(250);
  });

  test("loadBefore reports the same total as loadTail", async () => {
    const { bytes } = chatOf(250);
    const pages = makePageStore();
    const state = unwrap(await buildFor(bytes, pages));
    const source = makeSource(bytes);

    const tail = unwrap(await loadChatIndexTail(state, { pages }, source, { limit: 10 }));
    const older = unwrap(
      await loadChatIndexBefore(state, { pages }, source, requireCursor(tail.prevCursor), {
        limit: 10,
      }),
    );
    expect(older.records).toHaveLength(10);
    expect(older.totalRecordCount).toBe(250);
  });

  test("a header-only chat reports zero", async () => {
    const pages = makePageStore();
    const state = unwrap(await buildFor(chatHeaderBytes(), pages));
    const loaded = unwrap(
      await loadChatIndexTail(state, { pages }, makeSource(chatHeaderBytes())),
    );
    expect(loaded.totalRecordCount).toBe(0);
  });
});
