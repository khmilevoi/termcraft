import { describe, expect, it } from "bun:test";

import { type ChatListingScanIssue, scanChatListingPrefix } from "./chat-listing";

// `kind: "chat"` matches `entities/chat`'s real `chatHeaderSchema` discriminant
// (`entities/chat/types.ts`, `entities/chat/model/decode.ts`) — not a "chat-header" literal,
// which the schema would reject as a SHAPE violation and which appears nowhere else in this
// codebase's real chat headers.
const HEADER = (chatId: string, projectId: string) =>
  `${JSON.stringify({ formatVersion: 1, kind: "chat", chatId, projectId, createdAt: "2026-07-26T10:00:00.000Z" })}\n`;
const USER = (text: string) =>
  `${JSON.stringify({ kind: "user", recordId: "01900000-0000-7000-8000-000000000001", turnId: "01900000-0000-7000-8000-000000000002", text, ts: "2026-07-26T10:00:01.000Z" })}\n`;
const AGENT = `${JSON.stringify({ kind: "agent", recordId: "01900000-0000-7000-8000-000000000003", turnId: "01900000-0000-7000-8000-000000000002", text: "done", changedPages: [], warnings: [], ts: "2026-07-26T10:00:02.000Z" })}\n`;
// Valid JSON, but `kind` matches no member of `entities/chat`'s record union — a schema
// violation `decodeChatRecordLine` reports as a `ChatDecodeError`, not a JSON parse failure.
const UNDECODABLE_RECORD = `${JSON.stringify({ kind: "not-a-real-record-kind" })}\n`;
// Valid JSON, but `chatId` fails `canonicalUuidv7Schema` — a schema violation
// `decodeChatHeaderLine` reports as a `ChatDecodeError`.
const UNDECODABLE_HEADER = `${JSON.stringify({ formatVersion: 1, kind: "chat", chatId: "not-a-uuid", projectId: "01900000-0000-7000-8000-00000000000b", createdAt: "2026-07-26T10:00:00.000Z" })}\n`;

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

  // Review fix round 1, Finding 1: a decode failure is a `null` return AND a reported cause —
  // never a silently swallowed `Error` (errore rule 21).
  it("reports the real decode cause through onIssue when the header itself is undecodable, rather than losing it", () => {
    const issues: ChatListingScanIssue[] = [];
    const entry = scanChatListingPrefix(bytes(UNDECODABLE_HEADER), CHAT_ID, PROJECT_ID, (issue) =>
      issues.push(issue),
    );
    expect(entry).toBeNull();
    expect(issues).toEqual([{ kind: "header-unreadable", cause: expect.any(Error) }]);
    expect(issues[0]?.kind === "header-unreadable" && issues[0].cause.message.length > 0).toBe(
      true,
    );
  });

  // Review fix round 1, Finding 2: a record that fails to decode BEFORE the first readable
  // `user` record must stop the walk right there — never fall through to a LATER `user`
  // record and report ITS text as "first" (that would fabricate which turn actually named the
  // chat, the project's hardest rule). Unlike `scanOrphanTurns`, the row itself is still kept
  // (the header already proved the file's identity) — only the name is refused.
  it("refuses to name the chat from a LATER user record when an earlier record fails to decode, and reports why", () => {
    const issues: ChatListingScanIssue[] = [];
    const entry = scanChatListingPrefix(
      bytes(HEADER(CHAT_ID, PROJECT_ID) + UNDECODABLE_RECORD + USER("must not appear")),
      CHAT_ID,
      PROJECT_ID,
      (issue) => issues.push(issue),
    );
    expect(entry).toEqual({
      chatId: CHAT_ID,
      createdAt: "2026-07-26T10:00:00.000Z",
      firstUserText: null,
    });
    expect(issues).toEqual([{ kind: "record-unreadable", cause: expect.any(Error) }]);
  });
});
