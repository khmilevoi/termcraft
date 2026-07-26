import { describe, expect, it } from "bun:test";

import { scanChatListingPrefix } from "./chat-listing";

// `kind: "chat"` matches `entities/chat`'s real `chatHeaderSchema` discriminant
// (`entities/chat/types.ts`, `entities/chat/model/decode.ts`) — not a "chat-header" literal,
// which the schema would reject as a SHAPE violation and which appears nowhere else in this
// codebase's real chat headers.
const HEADER = (chatId: string, projectId: string) =>
  `${JSON.stringify({ formatVersion: 1, kind: "chat", chatId, projectId, createdAt: "2026-07-26T10:00:00.000Z" })}\n`;
const USER = (text: string) =>
  `${JSON.stringify({ kind: "user", recordId: "01900000-0000-7000-8000-000000000001", turnId: "01900000-0000-7000-8000-000000000002", text, ts: "2026-07-26T10:00:01.000Z" })}\n`;
const AGENT = `${JSON.stringify({ kind: "agent", recordId: "01900000-0000-7000-8000-000000000003", turnId: "01900000-0000-7000-8000-000000000002", text: "done", changedPages: [], warnings: [], ts: "2026-07-26T10:00:02.000Z" })}\n`;

const CHAT_ID = "01900000-0000-7000-8000-00000000000a";
const PROJECT_ID = "01900000-0000-7000-8000-00000000000b";
const bytes = (s: string) => new TextEncoder().encode(s);

describe("scanChatListingPrefix", () => {
  it("returns the header's createdAt and the FIRST user record's text", () => {
    const entry = scanChatListingPrefix(
      bytes(HEADER(CHAT_ID, PROJECT_ID) + USER("build a system monitor") + AGENT + USER("second")),
      CHAT_ID,
      PROJECT_ID,
    );
    expect(entry).toEqual({
      chatId: CHAT_ID,
      createdAt: "2026-07-26T10:00:00.000Z",
      firstUserText: "build a system monitor",
    });
  });

  it("returns a null firstUserText for a freshly minted chat with no user record yet", () => {
    const entry = scanChatListingPrefix(bytes(HEADER(CHAT_ID, PROJECT_ID)), CHAT_ID, PROJECT_ID);
    expect(entry?.firstUserText).toBeNull();
  });

  it("refuses a chat whose header identity does not match its filename or project", () => {
    expect(
      scanChatListingPrefix(bytes(HEADER("other", PROJECT_ID)), CHAT_ID, PROJECT_ID),
    ).toBeNull();
    expect(scanChatListingPrefix(bytes(HEADER(CHAT_ID, "other")), CHAT_ID, PROJECT_ID)).toBeNull();
  });

  it("stops at the last LF — a truncated prefix never decodes a partial line", () => {
    const truncated = HEADER(CHAT_ID, PROJECT_ID) + USER("first").slice(0, 20);
    const entry = scanChatListingPrefix(bytes(truncated), CHAT_ID, PROJECT_ID);
    expect(entry?.firstUserText).toBeNull();
  });
});
