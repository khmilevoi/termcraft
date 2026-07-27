import { describe, expect, test } from "bun:test";

import {
  CHAT_LIST_VIEWPORT_CAP,
  FRESH_CHAT_LABEL,
  computeChatListViewport,
  formatChatWhen,
} from "./chat-list";

describe("computeChatListViewport (Defect 1: no viewport cap, design wsChats cap=6)", () => {
  test("a list at or under the cap shows every row with no before/after overflow", () => {
    expect(computeChatListViewport({ total: 3, selectedIndex: 0 })).toEqual({
      start: 0,
      visibleCount: 3,
      before: 0,
      after: 0,
    });
    expect(computeChatListViewport({ total: CHAT_LIST_VIEWPORT_CAP, selectedIndex: 5 })).toEqual({
      start: 0,
      visibleCount: 6,
      before: 0,
      after: 0,
    });
  });

  test("an empty list produces an empty, non-throwing window", () => {
    expect(computeChatListViewport({ total: 0, selectedIndex: 0 })).toEqual({
      start: 0,
      visibleCount: 0,
      before: 0,
      after: 0,
    });
  });

  test("selecting the first row pins the window to the top (no negative start)", () => {
    const viewport = computeChatListViewport({ total: 14, selectedIndex: 0 });
    expect(viewport.start).toBe(0);
    expect(viewport.visibleCount).toBe(6);
    expect(viewport.before).toBe(0);
    expect(viewport.after).toBe(8);
    expect(0).toBeGreaterThanOrEqual(viewport.start);
    expect(0).toBeLessThan(viewport.start + viewport.visibleCount);
  });

  test("selecting the last row pins the window to the bottom (never scrolls past the end)", () => {
    const viewport = computeChatListViewport({ total: 14, selectedIndex: 13 });
    expect(viewport.start).toBe(8);
    expect(viewport.visibleCount).toBe(6);
    expect(viewport.before).toBe(8);
    expect(viewport.after).toBe(0);
    expect(13).toBeGreaterThanOrEqual(viewport.start);
    expect(13).toBeLessThan(viewport.start + viewport.visibleCount);
  });

  test("selecting a middle row keeps the window centered on it, with both edges overflowing", () => {
    const viewport = computeChatListViewport({ total: 14, selectedIndex: 7 });
    expect(viewport.start).toBe(5);
    expect(viewport.visibleCount).toBe(6);
    expect(viewport.before).toBe(5);
    expect(viewport.after).toBe(3);
    expect(7).toBeGreaterThanOrEqual(viewport.start);
    expect(7).toBeLessThan(viewport.start + viewport.visibleCount);
  });

  test("the selected row is always inside the window, for every index across a long list", () => {
    const total = 37;
    for (let selectedIndex = 0; selectedIndex < total; selectedIndex++) {
      const viewport = computeChatListViewport({ total, selectedIndex });
      expect(selectedIndex).toBeGreaterThanOrEqual(viewport.start);
      expect(selectedIndex).toBeLessThan(viewport.start + viewport.visibleCount);
      expect(viewport.start).toBeGreaterThanOrEqual(0);
      expect(viewport.start + viewport.visibleCount).toBeLessThanOrEqual(total);
    }
  });

  test("a custom cap is honoured", () => {
    expect(computeChatListViewport({ total: 10, selectedIndex: 9, cap: 3 })).toEqual({
      start: 7,
      visibleCount: 3,
      before: 7,
      after: 0,
    });
  });
});

describe("formatChatWhen (Defect 2: raw ISO-8601 timestamp instead of relative time)", () => {
  const NOW = Date.parse("2026-07-27T12:00:00.000Z");

  test("under a minute reads 'now'", () => {
    expect(formatChatWhen(new Date(NOW - 0).toISOString(), NOW)).toBe("now");
    expect(formatChatWhen(new Date(NOW - 30_000).toISOString(), NOW)).toBe("now");
  });

  test("minutes ago, 1-59m", () => {
    expect(formatChatWhen(new Date(NOW - 60_000).toISOString(), NOW)).toBe("1m ago");
    expect(formatChatWhen(new Date(NOW - 8 * 60_000).toISOString(), NOW)).toBe("8m ago");
    expect(formatChatWhen(new Date(NOW - 59 * 60_000).toISOString(), NOW)).toBe("59m ago");
  });

  test("hours ago, 1-23h", () => {
    expect(formatChatWhen(new Date(NOW - 60 * 60_000).toISOString(), NOW)).toBe("1h ago");
    expect(formatChatWhen(new Date(NOW - 23 * 3_600_000).toISOString(), NOW)).toBe("23h ago");
  });

  test("24-47h reads 'yesterday'", () => {
    expect(formatChatWhen(new Date(NOW - 24 * 3_600_000).toISOString(), NOW)).toBe("yesterday");
    expect(formatChatWhen(new Date(NOW - 47 * 3_600_000).toISOString(), NOW)).toBe("yesterday");
  });

  test("days ago, 2-6d", () => {
    expect(formatChatWhen(new Date(NOW - 48 * 3_600_000).toISOString(), NOW)).toBe("2d ago");
    expect(formatChatWhen(new Date(NOW - 6 * 24 * 3_600_000).toISOString(), NOW)).toBe("6d ago");
  });

  test("weeks ago, >=7d", () => {
    expect(formatChatWhen(new Date(NOW - 7 * 24 * 3_600_000).toISOString(), NOW)).toBe("1w ago");
    expect(formatChatWhen(new Date(NOW - 14 * 24 * 3_600_000).toISOString(), NOW)).toBe("2w ago");
    expect(formatChatWhen(new Date(NOW - 28 * 24 * 3_600_000).toISOString(), NOW)).toBe("4w ago");
  });

  test("a clock-skewed future timestamp never goes negative — reads 'now'", () => {
    expect(formatChatWhen(new Date(NOW + 5_000).toISOString(), NOW)).toBe("now");
  });

  test("an invalid timestamp reads as unknown — never a fabricated 'now'", () => {
    // "now" would itself assert freshness the runtime has no basis for; the em-dash says the
    // one true thing available.
    expect(formatChatWhen("not-a-date", NOW)).toBe("—");
  });
});

describe("FRESH_CHAT_LABEL (Defect 3: fabricated chatId.slice(0, 8) fallback)", () => {
  test("is the design's actual wsChatFresh wording, not a hex chat-id fragment", () => {
    expect(FRESH_CHAT_LABEL).toBe("new chat — fresh context");
  });
});
