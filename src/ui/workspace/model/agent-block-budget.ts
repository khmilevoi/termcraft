import { recordToChatRecordProps } from "ui/chat";
import type { PinListRow } from "ui/chat";
import type { ChatRecord } from "ui/mirror";

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
 * How many terminal rows the persisted chat scrollback (`ChatScrollback`) actually renders for
 * `records`, given `agentLabel`: one header line per record, plus that record's own flattened
 * markdown-lite line count — computed through the SAME `recordToChatRecordProps` pipeline
 * `ChatScrollback` itself renders through, not a parallel estimate that could drift from it.
 */
export function chatScrollbackRows(records: readonly ChatRecord[], agentLabel: string): number {
  return records.reduce(
    (sum, record) => sum + 1 + recordToChatRecordProps(record, agentLabel).lines.length,
    0,
  );
}

/** How many rows `PinList` actually renders for `pins` — nothing when there are none (`PinList`'s
 *  own `pins.length === 0` early return), else one header row plus one row per pin. */
export function pinListRowCount(pins: readonly PinListRow[]): number {
  return pins.length === 0 ? 0 : 1 + pins.length;
}

/** How many rows `Composer` actually renders: the seam row, an optional attach line, and the
 *  single-row `TextInput` (`Composer.tsx`; `TextInput.tsx` always renders exactly one row). */
export function composerRowCount(hasAttach: boolean): number {
  return hasAttach ? 3 : 2;
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
  readonly scrollbackRows: number;
  readonly pinListRows: number;
  readonly composerRows: number;
}): number {
  const available =
    input.frameH -
    CHAT_PANEL_BORDER_ROWS -
    (input.hasAgentLine ? 1 : 0) -
    input.scrollbackRows -
    input.pinListRows -
    input.composerRows -
    input.chromeRows;
  return Math.max(3, Math.min(MAX_TIMELINE_ROWS, available));
}
