import { describe, expect, test } from "bun:test";

import { context } from "@reatom/core";

import type { ChatSummaryV1 } from "../types";
import { createChatDirectory, sortChatsNewestFirst } from "./chat-directory";

function chat(chatId: string, createdAt: string, displayName: string | null = null): ChatSummaryV1 {
  return { chatId, createdAt, displayName };
}

describe("sortChatsNewestFirst", () => {
  test("orders chats by createdAt, newest first", () => {
    const oldest = chat("a", "2024-01-01T00:00:00.000Z");
    const middle = chat("b", "2024-06-01T00:00:00.000Z");
    const newest = chat("c", "2024-12-01T00:00:00.000Z");
    expect(sortChatsNewestFirst([oldest, newest, middle])).toEqual([newest, middle, oldest]);
  });

  test("does not mutate the input array", () => {
    const input = [chat("a", "2024-01-01T00:00:00.000Z"), chat("b", "2024-06-01T00:00:00.000Z")];
    const copy = [...input];
    sortChatsNewestFirst(input);
    expect(input).toEqual(copy);
  });

  test("is stable — equal timestamps preserve original relative order", () => {
    const same = "2024-06-01T00:00:00.000Z";
    const first = chat("a", same);
    const second = chat("b", same);
    expect(sortChatsNewestFirst([first, second])).toEqual([first, second]);
  });

  test("compares by real elapsed time, not by string length or lexical order of fractional digits", () => {
    // A longer fractional-second string is not lexically "less than" a shorter one at the
    // same second, so a naive string comparison would misorder these two.
    const noFraction = chat("a", "2024-06-01T00:00:00Z");
    const withFraction = chat("b", "2024-06-01T00:00:00.500Z");
    expect(sortChatsNewestFirst([noFraction, withFraction])).toEqual([withFraction, noFraction]);
  });
});

describe("createChatDirectory", () => {
  test("starts empty", () => {
    context.start(() => {
      const directory = createChatDirectory();
      expect(directory.newestFirst()).toEqual([]);
    });
  });

  test("upsert() adds a new chat summary", () => {
    context.start(() => {
      const directory = createChatDirectory();
      directory.upsert(chat("a", "2024-01-01T00:00:00.000Z"));
      expect(directory.newestFirst()).toEqual([chat("a", "2024-01-01T00:00:00.000Z")]);
    });
  });

  test("newestFirst() reflects insertion order sorted by createdAt", () => {
    context.start(() => {
      const directory = createChatDirectory();
      directory.upsert(chat("old", "2024-01-01T00:00:00.000Z"));
      directory.upsert(chat("new", "2024-06-01T00:00:00.000Z"));
      expect(directory.newestFirst().map((c) => c.chatId)).toEqual(["new", "old"]);
    });
  });

  test("upsert() with an existing chatId replaces that entry rather than duplicating it", () => {
    context.start(() => {
      const directory = createChatDirectory();
      directory.upsert(chat("a", "2024-01-01T00:00:00.000Z"));
      directory.upsert(chat("a", "2024-06-01T00:00:00.000Z"));
      expect(directory.newestFirst()).toEqual([chat("a", "2024-06-01T00:00:00.000Z")]);
    });
  });

  test("atom carries a hierarchical trace name rooted at kernel.chats", () => {
    context.start(() => {
      const directory = createChatDirectory();
      expect(directory.entriesAtom.name).toBe("kernel.chats.directory");
    });
  });
});
