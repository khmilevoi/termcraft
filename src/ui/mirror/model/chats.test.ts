import { describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";

import type { ChatSummary } from "../types";
import { sortChatSummariesNewestFirst } from "./chats";

function summary(createdAt: string): ChatSummary {
  return { chatId: uuidv7(), createdAt, displayName: null };
}

describe("sortChatSummariesNewestFirst (design 24-chats.dc.html, wsChats)", () => {
  test("sorts ascending-createdAt input newest-first", () => {
    const oldest = summary("2026-07-20T00:00:00.000Z");
    const middle = summary("2026-07-21T00:00:00.000Z");
    const newest = summary("2026-07-22T00:00:00.000Z");
    const sorted = sortChatSummariesNewestFirst([oldest, middle, newest]);
    expect(sorted.map((row) => row.chatId)).toEqual([newest.chatId, middle.chatId, oldest.chatId]);
  });

  test("is a stable sort — equal createdAt values keep their relative (insertion) order", () => {
    const first = summary("2026-07-22T00:00:00.000Z");
    const second = summary("2026-07-22T00:00:00.000Z");
    const sorted = sortChatSummariesNewestFirst([first, second]);
    expect(sorted.map((row) => row.chatId)).toEqual([first.chatId, second.chatId]);
  });

  test("accepts any iterable (e.g. a Map's values()) without mutating the source", () => {
    const a = summary("2026-07-20T00:00:00.000Z");
    const b = summary("2026-07-21T00:00:00.000Z");
    const map = new Map([
      [a.chatId, a],
      [b.chatId, b],
    ]);
    const sorted = sortChatSummariesNewestFirst(map.values());
    expect(sorted.map((row) => row.chatId)).toEqual([b.chatId, a.chatId]);
    expect([...map.values()].map((row) => row.chatId)).toEqual([a.chatId, b.chatId]);
  });
});
