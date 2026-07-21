import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { durableFileWrite } from "infrastructure/durability";

import type { ChatIndexPage, ChatIndexState } from "../types";
import {
  createNodeChatIndexPageStore,
  createNodeChatIndexStateStore,
  nodeChatIndexCacheFsDeps,
} from "./chat-index-store";

const CHAT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11";

const roots: string[] = [];
function freshRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-chat-index-cache-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function samplePage(pageIndex: number): ChatIndexPage {
  return {
    pageIndex,
    entries: [
      {
        recordId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20",
        ts: "2026-07-20T10:00:00Z",
        changedPages: [],
        offsetStart: 0,
        offsetEnd: 42,
      },
    ],
    checksum: "a".repeat(64),
  };
}

function sampleState(): ChatIndexState {
  return {
    chatId: CHAT_ID,
    generation: 1,
    canonicalIdentity: "unix:2049:123456",
    projectViewGeneration: "1",
    totalBytes: 100,
    validPrefixBytes: 100,
    firstWindowSha256: "b".repeat(64),
    finalWindowSha256: "c".repeat(64),
    tail: { kind: "clean" },
    pages: [
      {
        pageIndex: 0,
        entryCount: 1,
        firstOffsetStart: 0,
        lastOffsetEnd: 42,
        checksum: "a".repeat(64),
      },
    ],
  };
}

describe("createNodeChatIndexPageStore — durable round-trip (finding #3)", () => {
  test("writePage then readPage round-trips exactly, across separate store instances (surviving a restart)", async () => {
    const root = freshRoot();
    const fsDeps = nodeChatIndexCacheFsDeps(durableFileWrite);
    const store1 = createNodeChatIndexPageStore(root, fsDeps);

    const page = samplePage(0);
    const wrote = await store1.writePage(CHAT_ID, page);
    expect(wrote).toBeUndefined();

    // A FRESH store instance over the SAME root — simulates a process restart. This is the
    // core of finding #3: the in-memory store this replaces could never do this.
    const store2 = createNodeChatIndexPageStore(root, fsDeps);
    const read = await store2.readPage(CHAT_ID, 0);
    expect(read).toEqual(page);
  });

  test("readPage returns null (a miss) for a page that was never written", async () => {
    const root = freshRoot();
    const store = createNodeChatIndexPageStore(root, nodeChatIndexCacheFsDeps(durableFileWrite));
    expect(await store.readPage(CHAT_ID, 0)).toBeNull();
  });

  test("readPage returns null (a miss, not an error) for a corrupt page file", async () => {
    const root = freshRoot();
    const store = createNodeChatIndexPageStore(root, nodeChatIndexCacheFsDeps(durableFileWrite));
    await store.writePage(CHAT_ID, samplePage(0));
    fs.writeFileSync(path.join(root, CHAT_ID, "page-0.json"), "{not json");
    expect(await store.readPage(CHAT_ID, 0)).toBeNull();
  });

  test("pages for different chatIds never collide", async () => {
    const root = freshRoot();
    const store = createNodeChatIndexPageStore(root, nodeChatIndexCacheFsDeps(durableFileWrite));
    const otherChatId = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d99";
    await store.writePage(CHAT_ID, samplePage(0));
    await store.writePage(otherChatId, { ...samplePage(0), checksum: "d".repeat(64) });

    const own = await store.readPage(CHAT_ID, 0);
    const other = await store.readPage(otherChatId, 0);
    if (own instanceof Error || other instanceof Error) throw new Error("fixture bug");
    expect(own?.checksum).toBe("a".repeat(64));
    expect(other?.checksum).toBe("d".repeat(64));
  });
});

describe("createNodeChatIndexStateStore — durable round-trip (finding #3)", () => {
  test("write then read round-trips exactly, across separate store instances", async () => {
    const root = freshRoot();
    const fsDeps = nodeChatIndexCacheFsDeps(durableFileWrite);
    const store1 = createNodeChatIndexStateStore(root, fsDeps);

    const state = sampleState();
    const wrote = await store1.write(CHAT_ID, state);
    expect(wrote).toBeUndefined();

    const store2 = createNodeChatIndexStateStore(root, fsDeps);
    expect(await store2.read(CHAT_ID)).toEqual(state);
  });

  test("read returns null (never built) when no state was ever written", async () => {
    const root = freshRoot();
    const store = createNodeChatIndexStateStore(root, nodeChatIndexCacheFsDeps(durableFileWrite));
    expect(await store.read(CHAT_ID)).toBeNull();
  });

  test("read returns null (a miss, not an error) for a corrupt state file — the caller falls back to a full rebuild rather than failing to open", async () => {
    const root = freshRoot();
    const store = createNodeChatIndexStateStore(root, nodeChatIndexCacheFsDeps(durableFileWrite));
    await store.write(CHAT_ID, sampleState());
    fs.writeFileSync(path.join(root, CHAT_ID, "state.json"), "{not json");
    expect(await store.read(CHAT_ID)).toBeNull();
  });

  test("write is idempotent — writing the same chatId twice replaces the previous state (not create-new-only)", async () => {
    const root = freshRoot();
    const store = createNodeChatIndexStateStore(root, nodeChatIndexCacheFsDeps(durableFileWrite));
    await store.write(CHAT_ID, sampleState());
    const updated = { ...sampleState(), generation: 2 };
    const wrote = await store.write(CHAT_ID, updated);
    expect(wrote).toBeUndefined();
    expect(await store.read(CHAT_ID)).toEqual(updated);
  });
});
