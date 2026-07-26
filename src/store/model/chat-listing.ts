import { JSONL_LF, decodeChatHeaderLine, decodeChatRecordLine } from "store/jsonl";

import type { ChatListEntry } from "../types";

/**
 * A skipped/degraded outcome `scanChatListingPrefix` reports through `onIssue` rather than
 * losing (errore rule 21: "an error that is not propagated MUST be logged" — the caller does
 * the logging, since this scan stays pure/testable and never touches `console` itself).
 * `cause` is the real `Error` `store/jsonl`'s decoder returned — never re-derived or
 * approximated — so the caller can log the ACTUAL reason, matching `scanOrphanTurns`'s own
 * precedent of logging `doc.message` rather than a generic string.
 */
export type ChatListingScanIssue =
  | { readonly kind: "no-header-line" }
  | { readonly kind: "header-unreadable"; readonly cause: Error }
  | {
      readonly kind: "identity-mismatch";
      readonly headerChatId: string;
      readonly headerProjectId: string;
    }
  | { readonly kind: "record-unreadable"; readonly cause: Error };

/**
 * A chat's listing facts, read FORWARD from the file's own start.
 *
 * Read direction is the whole point (fix-bundle spec §2.1): a chat's display name is the first
 * line of its first `user` record — by definition at the start of the file, since it is the first
 * turn — so a forward scan stops within the first few lines. `core/chats`'s
 * `resolveChatDisplayName` walks `loadBefore` BACKWARDS from the tail all the way to the
 * beginning for the same fact, which is the most likely cause of the observed empty chat list on
 * a long history. With this listing supplying names, that backward walk is no longer needed at
 * all; `loadTail` remains only for the scrollback.
 *
 * `null` means "this file is not a usable chat for listing purposes" — an unreadable header, or a
 * storage-identity §5.2 identity mismatch (the filename must equal the header's `chatId`, and the
 * header's `projectId` must equal `project.toml`'s). Identity is never repaired by renaming or
 * rewriting; the row is simply left out, exactly as `scanOrphanTurns` already skips it. Every
 * `null` return, and every degraded-but-kept `ChatListEntry`, is reported through `onIssue` first
 * — the caller's job is to log it, never to drop it unlogged.
 */
export function scanChatListingPrefix(
  prefix: Uint8Array,
  chatId: string,
  projectId: string,
  onIssue?: (issue: ChatListingScanIssue) => void,
): ChatListEntry | null {
  const lines = splitCompleteLines(prefix);
  const [headerLine, ...recordLines] = lines;
  if (headerLine === undefined) {
    onIssue?.({ kind: "no-header-line" });
    return null;
  }

  const header = decodeChatHeaderLine(headerLine);
  if (header instanceof Error) {
    onIssue?.({ kind: "header-unreadable", cause: header });
    return null;
  }
  if (header.chatId !== chatId || header.projectId !== projectId) {
    onIssue?.({
      kind: "identity-mismatch",
      headerChatId: header.chatId,
      headerProjectId: header.projectId,
    });
    return null;
  }

  for (const line of recordLines) {
    const record = decodeChatRecordLine(line);
    // DIVERGENCE from `scanOrphanTurns` (documented, not silent): that scan skips the WHOLE
    // chat on any mid-file corruption. This one does not — the header already proved the
    // file's identity, so the row is kept — but a record that fails to decode BEFORE the
    // first readable `user` record means this scan can no longer honestly say what the
    // chat's first user text is. Continuing past it and reporting a LATER `user` record's
    // text as "first" would fabricate a fact (global constraint: "never fabricate a fact");
    // the fix is to stop right here and list the chat with `firstUserText: null` instead —
    // the same honest "unnamed" state a freshly minted chat already gets.
    if (record instanceof Error) {
      onIssue?.({ kind: "record-unreadable", cause: record });
      return { chatId, createdAt: header.createdAt, firstUserText: null };
    }
    if (record.kind === "user") {
      return { chatId, createdAt: header.createdAt, firstUserText: record.text };
    }
  }
  return { chatId, createdAt: header.createdAt, firstUserText: null };
}

/**
 * Every LF-terminated physical line in `prefix`, INCLUDING its terminator (which
 * `decodeJsonlLine` requires — a syntactically valid final object without one is an uncommitted
 * suffix, never a record). Any trailing bytes after the last LF are dropped: a bounded prefix read
 * routinely lands mid-line, and decoding that fragment would be reading a record that does not
 * exist yet.
 */
function splitCompleteLines(prefix: Uint8Array): readonly Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < prefix.byteLength; i += 1) {
    if (prefix[i] !== JSONL_LF) continue;
    lines.push(prefix.subarray(start, i + 1));
    start = i + 1;
  }
  return lines;
}
