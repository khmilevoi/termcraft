import type { ChatSummary } from "../types";

/**
 * Design `design/24-chats.dc.html` (`wsChats`, engine `termcraft-engine.js:844-849`): the
 * `/chats` popup lists rows newest-first — the sample data descends `now`, `8m ago`, `1h ago`,
 * … with the most recently created chat on top. Both the popup's rendered rows (`App.tsx`
 * `renderOverlay`) and the `chat-move`/`chat-switch` intents (`intent.ts`) sort through this one
 * helper so the visual row order and the selection index they resolve always agree — sorting
 * only where the rows are painted would desync the index the intents read (`intent.ts:107`,
 * pre-fix, read insertion order).
 *
 * `Array.prototype.sort` is a stable sort (guaranteed since ES2019), so entries sharing a
 * `createdAt` keep their original relative (insertion) order instead of being reshuffled.
 */
export function sortChatSummariesNewestFirst(
  summaries: Iterable<ChatSummary>,
): readonly ChatSummary[] {
  return [...summaries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
