/** One rectangle size in terminal cells. */
export interface CellSize {
  readonly w: number;
  readonly h: number;
}

/** One absolute terminal cell. */
export interface CellPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The chat column's share of the terminal, verbatim from the design engine's own
 * `paneShell` (`design/termcraft-engine.js:478`: `chatW = Math.round(w * 0.37)`).
 */
const CHAT_WIDTH_RATIO = 0.37;

/** Rows the shell owns outside the preview pane: the status bar. */
const STATUS_BAR_ROWS = 1;

/** The pane's own top+bottom border rows. */
const PANE_BORDER_ROWS = 2;

/** The tab strip row inside the pane (design `paneShell` draws it at y=1). */
const TAB_STRIP_ROWS = 1;

/**
 * The rule under the tab strip plus the blank row below it — design `paneShell`
 * (`design/termcraft-engine.js:485-486`) draws `hline` at y=2 and starts the design at
 * `dy = 4`, i.e. two rows of header chrome between the tabs and the design.
 */
const TAB_RULE_ROWS = 2;

/** The pane's own left+right border columns. */
const PANE_BORDER_COLUMNS = 2;

export function chatColumnWidth(terminalWidth: number): number {
  return Math.round(terminalWidth * CHAT_WIDTH_RATIO);
}

/**
 * The preview pane's OUTER width — border columns included. Fullscreen (F2) drops the chat
 * column entirely, matching the design engine's `paneShell(..., {noChat:true})`
 * (`design/termcraft-engine.js:478,481`: `chatW = 0`, so `pw = w`).
 *
 * DIVERGENCE (non-fullscreen branch): the design's `paneShell` (`:478,481,483`) has the chat
 * box and the preview box SHARE one divider column — `div = chatW - 1`, `pw = w - div =
 * w - chatW + 1` — which is exactly the column the design paints its `┬`/`┴` tee glyphs into
 * (`:483`), fusing the two boxes into one frame. OpenTUI lays out `ws-chat` and `ws-preview`
 * as two ordinary flex siblings (same limitation already noted on `Workspace`'s own doc
 * comment: "OpenTUI flex siblings cannot auto-tee their borders"), so each keeps its own,
 * non-overlapping border column instead of sharing one. This returns `w - chatW` — one column
 * narrower than the design's `w - chatW + 1` — the closest faithful mapping without a shared
 * divider column to borrow. Do not "correct" this to the design's `+ 1`: with two independent
 * sibling borders there is no shared column, so the extra column would make the preview pane
 * overlap the chat column by one cell instead of sitting flush beside it.
 */
export function previewPaneWidth(terminal: CellSize, fullscreen: boolean): number {
  return fullscreen ? terminal.w : terminal.w - chatColumnWidth(terminal.w);
}

/**
 * The cell size actually available to preview CONTENT: the pane minus its own border, minus
 * the tab strip row, minus the rule row and the blank gap row below it (design `paneShell`'s
 * `dy = 4` — see {@link TAB_RULE_ROWS}). This is the size the host is asked to render at
 * (`preview.resize`) and the size every placeholder panel is laid out in — one number, so a
 * frame can never be sized against a different rectangle than the one it is painted into.
 * Clamped at zero so a terminal too small to hold the chrome reports an empty region rather
 * than a negative one.
 */
export function previewRegionSize(terminal: CellSize, fullscreen: boolean): CellSize {
  return {
    w: Math.max(0, previewPaneWidth(terminal, fullscreen) - PANE_BORDER_COLUMNS),
    h: Math.max(
      0,
      terminal.h - STATUS_BAR_ROWS - PANE_BORDER_ROWS - TAB_STRIP_ROWS - TAB_RULE_ROWS,
    ),
  };
}

/**
 * The ABSOLUTE terminal cell the frame's own (0,0) lands on — what turns a mouse event into
 * a frame-local point. Derived from the same split `previewRegionSize` uses rather than
 * restated as a constant: a hardcoded origin is exactly what silently breaks when the pane's
 * chrome gains or loses a row.
 */
export function previewFrameOrigin(terminal: CellSize, fullscreen: boolean): CellPoint {
  return {
    x: (fullscreen ? 0 : chatColumnWidth(terminal.w)) + 1,
    y: PANE_BORDER_ROWS - 1 + TAB_STRIP_ROWS + TAB_RULE_ROWS,
  };
}
