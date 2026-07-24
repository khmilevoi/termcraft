import type { ChatRecordDtoV1 } from "core/protocol";

/**
 * A chat's display name is DERIVED, never stored (design §3.9, spec:379-380): "the
 * first line of its first `user` record, truncated to ~60 chars (the project-name
 * rule, §3.1)." This is the pure derivation the Kernel runs whenever it has loaded a
 * chat's tail (`chat.create`/`chat.switch`/`project.open`, WP-10 Tasks 5/6) to fill
 * `ChatSummaryV1.displayName` — never a UI-side computation, because the `/chats`
 * popup needs a name for every chat while the UI mirror only holds the ACTIVE chat's
 * records (see this package's own plan header for that constraint).
 */

/** §3.9's "~60 chars" truncation bound (the same project-name rule §3.1 already fixes). */
const DISPLAY_NAME_MAX_LENGTH = 60;

/**
 * The first line of the first `kind: "user"` record's `text`, trimmed and truncated
 * to `DISPLAY_NAME_MAX_LENGTH`. `null` when no `user` record exists yet (a freshly
 * created chat) — the UI renders the design's `chatId.slice(0, 8)` fallback for that
 * case (`App.tsx`).
 */
export function deriveChatDisplayName(records: readonly ChatRecordDtoV1[]): string | null {
  const firstUserRecord = records.find((record) => record.kind === "user");
  if (firstUserRecord === undefined) return null;

  const firstLine = (firstUserRecord.text.split("\n")[0] ?? "").trim();
  return firstLine.slice(0, DISPLAY_NAME_MAX_LENGTH);
}
