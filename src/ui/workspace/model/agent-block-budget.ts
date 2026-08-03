/**
 * Design's own hard cap on the ephemeral status block's FOLDABLE timeline, excluding the pinned
 * spinner row (review round 1, Finding 1 — the previous `maxRows` had no upper bound at all):
 * `design/03-workspace-generating.dc.html` states "The block is capped at 12 rows and folds from
 * the top. The spinner row is pinned." — and the engine confirms it arithmetically. `genTurn`'s
 * `rows.long` (`design/termcraft-engine.js:539-545`) renders exactly 11 rows once each entry's
 * OWN row cost is counted (not array-entry count): the fold row (1) + 3 step rows + 2 collapsed
 * PAST reasoning rows (1 each) + the live block's own 5-line cap = 11. Prepending the pinned
 * spinner status line (`:547`) makes 12 total, matching the design's own stated number.
 * `AgentStatusBlock` always draws the spinner itself, OUTSIDE the foldable timeline, so the
 * timeline's own share of that 12-row budget is `12 - 1 = 11`.
 */
export const MAX_TIMELINE_ROWS = 11;

/** `ws-chat`'s own rounded border (`Workspace.tsx`'s `border`/`borderStyle="rounded"`) always
 *  consumes exactly 2 rows (top + bottom) of `frameH`, regardless of content. */
const CHAT_PANEL_BORDER_ROWS = 2;

/**
 * The row budget passed to `foldTurnTimeline` as `maxRows` (chat-scroll spec §5.3).
 *
 * It used to subtract every sibling that shares `ws-chat-stream` — the panel border, the
 * `● agent` line, the persisted scrollback, the pin list, the composer — because nothing else
 * bounded the stream, and a long reply would paint straight over the composer. The
 * `<scrollbox>` now does that job by clipping (chat-scroll spec §5.2/§5.3), so this subtracts
 * only what physically cannot hold a timeline row inside the block's own frame: the panel
 * border and `AgentStatusBlock`'s own always-drawn chrome.
 *
 * `MAX_TIMELINE_ROWS` STAYS. The 12-row cap is design semantics, not crowding:
 * `design/03-workspace-generating.dc.html` states "The block is capped at 12 rows and folds
 * from the top. The spinner row is pinned." — so the fold must not vary with terminal size.
 * The `3` floor is the design's own smallest per-frame cap (`short`'s `liveCap:3`).
 */
export function agentStatusMaxRows(input: {
  readonly frameH: number;
  readonly chromeRows: number;
}): number {
  const available = input.frameH - CHAT_PANEL_BORDER_ROWS - input.chromeRows;
  return Math.max(3, Math.min(MAX_TIMELINE_ROWS, available));
}
