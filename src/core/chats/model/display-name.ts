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
 * §3.9's derivation applied to one already-selected record's text: first line, trimmed,
 * truncated to {@link DISPLAY_NAME_MAX_LENGTH}. Split out so the chat LISTING path
 * (`ChatReader.list()`, which returns raw `firstUserText` and never a display name) applies the
 * identical rule as the tail-reading path below, rather than a second copy that can drift.
 */
export function truncateChatDisplayName(text: string | null): string | null {
  if (text === null) return null;
  const firstLine = (text.split("\n")[0] ?? "").trim();
  if (firstLine === "") return null;
  return firstLine.slice(0, DISPLAY_NAME_MAX_LENGTH);
}

/**
 * The first line of the first `kind: "user"` record's `text`, trimmed and truncated
 * to `DISPLAY_NAME_MAX_LENGTH`. `null` when no `user` record exists yet (a freshly
 * created chat), OR when one exists but its first line is blank/whitespace-only after
 * trimming (review finding Minor, WP-10 fix wave) — an empty string is not a name, and
 * returning `null` here (rather than `""`) lets the UI's own null-fallback
 * (`chatId.slice(0, 8)`, `App.tsx`) engage instead of rendering a blank label.
 */
export function deriveChatDisplayName(records: readonly ChatRecordDtoV1[]): string | null {
  const firstUserRecord = records.find((record) => record.kind === "user");
  if (firstUserRecord === undefined) return null;
  return truncateChatDisplayName(firstUserRecord.text);
}
