import { JSONL_LF, decodeChatHeaderLine, decodeChatRecordLine } from "store/jsonl";

import type { ChatListEntry } from "../types";

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
 * rewriting; the row is simply left out, exactly as `scanOrphanTurns` already skips it.
 */
export function scanChatListingPrefix(
  prefix: Uint8Array,
  chatId: string,
  projectId: string,
): ChatListEntry | null {
  const lines = splitCompleteLines(prefix);
  const [headerLine, ...recordLines] = lines;
  if (headerLine === undefined) return null;

  const header = decodeChatHeaderLine(headerLine);
  if (header instanceof Error) return null;
  if (header.chatId !== chatId || header.projectId !== projectId) return null;

  for (const line of recordLines) {
    const record = decodeChatRecordLine(line);
    // A record that does not decode is not a reason to drop the whole chat from the list — the
    // header already proved the file's identity. Keep scanning; the name simply stays unknown if
    // no readable `user` record turns up inside the bounded prefix.
    if (record instanceof Error) continue;
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
