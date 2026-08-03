import type { PinListRow } from "ui/chat";

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

/** How many rows `PinList` actually renders for `pins` — nothing when there are none (`PinList`'s
 *  own `pins.length === 0` early return), else one header row plus one row per pin. */
export function pinListRowCount(pins: readonly PinListRow[]): number {
  return pins.length === 0 ? 0 : 1 + pins.length;
}

/**
 * How many rows `Composer` actually renders: the seam row, an optional attach line, and however
 * many rows the editor takes.
 *
 * WAS the constant `2 | 3` (spec §6.3): the prior single-line input always rendered exactly one
 * row, because the design draws the input on exactly one — `drawChat` `:256`, `workspace` `:594`.
 * The editor (`ui/text-input`'s `TextEditor`, 2026-08-03) now grows to `editorMaxRows(frameH)`
 * (its own approved divergence, spec §3), and its height is subtracted from the chat's budget in
 * the SAME frame the text changes, which is why the count is passed in rather than asked of the
 * renderable one frame later.
 *
 * At `editorRows === 1` this is exactly today's 2 and 3.
 */
export function composerRowCount(hasAttach: boolean, editorRows: number): number {
  return 1 + (hasAttach ? 1 : 0) + Math.max(1, editorRows);
}

/**
 * The row budget passed to `foldTurnTimeline` as `maxRows` (review round 1, Finding 1 — the
 * previous `Math.max(3, frameH - AGENT_BLOCK_CHROME_ROWS)` both had no upper bound and measured
 * from `frameH` alone, ignoring `ws-chat`'s own border and every sibling `AgentStatusBlock`
 * actually shares `ws-chat-stream` with).
 *
 * `frameH` is `ws-chat`'s own OUTER height; everything this function subtracts is a row that
 * physically cannot also hold a timeline row: the panel's own border, the `● agent` presence
 * line (when shown), the persisted scrollback above the ephemeral block, the pin list below it,
 * the composer beneath the whole stream, and `AgentStatusBlock`'s own always-drawn chrome
 * (presence/connection/spinner lines — `chromeRows`, the caller's `AGENT_BLOCK_CHROME_ROWS`).
 * Clamped to `[3, MAX_TIMELINE_ROWS]` — 3 is the pre-existing floor (the design's own smallest
 * per-frame cap, `short`'s `liveCap:3`), `MAX_TIMELINE_ROWS` is the design's own ceiling.
 */
export function agentStatusMaxRows(input: {
  readonly frameH: number;
  readonly chromeRows: number;
  readonly hasAgentLine: boolean;
  readonly pinListRows: number;
  readonly composerRows: number;
}): number {
  const available =
    input.frameH -
    CHAT_PANEL_BORDER_ROWS -
    (input.hasAgentLine ? 1 : 0) -
    input.pinListRows -
    input.composerRows -
    input.chromeRows;
  return Math.max(3, Math.min(MAX_TIMELINE_ROWS, available));
}

/**
 * The rows left for the persisted scrollback once every pinned sibling has taken its share.
 *
 * The scrollback is the ONE part of `ws-chat-stream` that yields, and this is the inversion the
 * overflow fix turns on. `agentStatusMaxRows` above used to subtract the scrollback's own
 * measured height, letting an ever-growing history squeeze the live block — while nothing
 * bounded the history itself, so the stream simply grew past the panel and overdrew the composer
 * and the bottom border. The design fixes the other three: the composer is pinned at
 * `frameH - composerH`, the live block is capped at 12 rows, and the history is what gets
 * summarised away behind `▲ N earlier messages` (`design/termcraft-engine.js:569`). So the live
 * block is budgeted first and the scrollback takes what remains — never the reverse.
 *
 * `liveBlockRows` is whatever the ephemeral region actually claims this frame: the running
 * turn's `AgentStatusBlock` (its chrome plus {@link agentStatusMaxRows}), the finished turn's
 * collapsed record, or 0 when neither is on screen.
 */
export function scrollbackMaxRows(input: {
  readonly frameH: number;
  readonly hasAgentLine: boolean;
  readonly liveBlockRows: number;
  readonly pinListRows: number;
  readonly composerRows: number;
}): number {
  return Math.max(
    0,
    input.frameH -
      CHAT_PANEL_BORDER_ROWS -
      (input.hasAgentLine ? 1 : 0) -
      input.liveBlockRows -
      input.pinListRows -
      input.composerRows,
  );
}
