import type { TurnTimelineEntry } from "ui/mirror";

/** The counted head row shown once the timeline no longer fits (design `foldRow`, `:539,562-564`). */
export interface TimelineFold {
  readonly thoughts: number;
  readonly steps: number;
}

/**
 * One already-folded timeline row, ready to paint — no further wrapping/tailing needed.
 *
 * A step's `status` is the design's own three-state glyph (`03-workspace-generating.dc.html:44`:
 * "✓ done, ▸ running, ✗ failed") — `"failed"` wins over position: a step the mirror already
 * flagged failed (`ui/mirror`'s `TurnTimelineEntry.failed`, folded by tool_use id, never by
 * position) renders failed regardless of whether it happens to be the chronologically-last step,
 * which `"running"` is otherwise reserved for.
 */
export type RenderedTimelineEntry =
  | Readonly<{ kind: "step"; op: string; target: string; status: "done" | "running" | "failed" }>
  | Readonly<{ kind: "reasoning"; lines: readonly string[]; live: boolean; clipped: boolean }>;

/**
 * Design `wrapLines` (`design/termcraft-engine.js:298-301`), transcribed: greedy word wrap, then a
 * hard character split for any single word still wider than `width`.
 *
 * `width <= 0` is NOT a design case (the design's own `wrapLines` has the identical hole: its
 * `while(l.length>width)` loop never shrinks `l` once `width` reaches 0, hanging forever) — a
 * transcription doesn't need to carry a hang across (review round 1, Finding 2), so `hardSplit`
 * below returns each line unsplit rather than looping when there is no positive width to split
 * into.
 */
export function wrapText(text: string, width: number): readonly string[] {
  const words = text.split(" ");
  const packed = words.reduce<{ readonly lines: readonly string[]; readonly cur: string }>(
    (acc, word) => {
      if (acc.cur === "") return { lines: acc.lines, cur: word };
      if (`${acc.cur} ${word}`.length <= width)
        return { lines: acc.lines, cur: `${acc.cur} ${word}` };
      return { lines: [...acc.lines, acc.cur], cur: word };
    },
    { lines: [], cur: "" },
  );
  const lines = packed.cur === "" ? packed.lines : [...packed.lines, packed.cur];

  const hardSplit = (line: string): readonly string[] => {
    if (width <= 0) return [line];
    const out: string[] = [];
    let remaining = line;
    while (remaining.length > width) {
      out.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    out.push(remaining);
    return out;
  };
  const out = lines.flatMap(hardSplit);
  return out.length > 0 ? out : [""];
}

/** Trims a past reasoning block's first line the way `thinkRow`'s `else` branch does (`:557`). */
function collapsePastLine(first: string, width: number): string {
  return `${first.replace(/[ ,.;:]+$/, "").slice(0, Math.max(0, width - 1))}…`;
}

/** One PAST (non-live) entry: a step keeps its own row; a reasoning block collapses to one line. */
function renderPastEntry(
  entry: TurnTimelineEntry,
  width: number,
  isActiveStep: boolean,
): RenderedTimelineEntry {
  if (entry.kind === "step") {
    // Failed wins over position — see `RenderedTimelineEntry`'s own doc comment.
    const status = entry.failed ? "failed" : isActiveStep ? "running" : "done";
    return { kind: "step", op: entry.op, target: entry.target, status };
  }
  const wrapped = wrapText(entry.text, width);
  const first = wrapped[0] ?? "";
  const clipped = wrapped.length > 1;
  const line = clipped ? collapsePastLine(first, width) : first;
  return { kind: "reasoning", lines: [line], live: false, clipped };
}

/** The LIVE reasoning block: tailed to `capRows` (never below 1 — design's own `Math.max(1,…)`, `:555`). */
function renderLiveReasoning(wrapped: readonly string[], capRows: number): RenderedTimelineEntry {
  const shownRows = Math.max(1, capRows);
  const clipped = wrapped.length > shownRows;
  const lines = clipped ? wrapped.slice(wrapped.length - shownRows) : wrapped;
  return { kind: "reasoning", lines, live: true, clipped };
}

/**
 * The turn's ordered timeline, folded to fit `maxRows` display rows (design `genTurn`/`thinkRow`/
 * `foldRow`, `design/termcraft-engine.js:511-565`).
 *
 * Row budget, per entry kind:
 *   - a step is one row;
 *   - a PAST reasoning block is one row — its first line, trimmed of trailing punctuation and
 *     suffixed `…` (design `thinkRow`'s `else` branch, `:557`);
 *   - the LIVE reasoning block (always the LAST entry, so it needs no flag of its own) is
 *     `min(wrapped.length, liveCap, remaining rows)` rows, tailed to its NEWEST lines, with the
 *     scrolled-away head marked `┊` instead of `│` (`:558`).
 *
 * Anything that does not fit collapses from the TOP into one counted fold row
 * (`▲ 6 earlier thoughts · 5 steps`, `:539`), counting BOTH elided reasoning blocks and elided
 * steps — so the live block can never push the conversation above it off screen.
 *
 * `liveCap` is per-frame in the design (3 in `short`, 4 in `first`, 5 in `full`/`long`). The
 * caller picks; `AgentStatusBlock`'s default is 5, the `full`/`long` value, documented at its own
 * call site rather than invented here.
 */
export function foldTurnTimeline(input: {
  readonly entries: readonly TurnTimelineEntry[];
  readonly width: number;
  readonly maxRows: number;
  readonly liveCap: number;
}): { readonly fold: TimelineFold | null; readonly entries: readonly RenderedTimelineEntry[] } {
  const { entries, width, maxRows, liveCap } = input;
  if (entries.length === 0) return { fold: null, entries: [] };

  const last = entries[entries.length - 1];
  const liveEntry = last !== undefined && last.kind === "reasoning" ? last : null;
  const nonLiveEntries = liveEntry === null ? entries : entries.slice(0, -1);
  // The last STEP entry chronologically is the one still active — unchanged from the shim this
  // module replaces (`Workspace.tsx`'s old `timelineSteps`), just computed against the WHOLE
  // timeline rather than a pre-filtered steps-only array, so folding away earlier entries can
  // never change which step reads as active.
  const lastStepEntry = entries.findLast((entry) => entry.kind === "step") ?? null;

  const wrappedLive = liveEntry === null ? [] : wrapText(liveEntry.text, width);
  const desiredLiveRows = Math.min(wrappedLive.length, liveCap);

  const budgetIfAllFit = Math.max(0, maxRows - desiredLiveRows);
  const needsFold = nonLiveEntries.length > budgetIfAllFit;
  const budgetForNonLive = needsFold ? Math.max(0, maxRows - desiredLiveRows - 1) : budgetIfAllFit;
  const keepCount = Math.min(nonLiveEntries.length, budgetForNonLive);
  const keptNonLive = nonLiveEntries.slice(nonLiveEntries.length - keepCount);
  const elidedNonLive = nonLiveEntries.slice(0, nonLiveEntries.length - keepCount);

  const fold: TimelineFold | null =
    elidedNonLive.length === 0
      ? null
      : {
          thoughts: elidedNonLive.filter((entry) => entry.kind === "reasoning").length,
          steps: elidedNonLive.filter((entry) => entry.kind === "step").length,
        };

  // Whatever room the fold row and the kept past entries didn't claim goes to the live block,
  // never more than it asked for (`desiredLiveRows`) — this is what keeps the live block from
  // ever pushing the fold row (or the composer below it) off screen.
  const liveRows =
    liveEntry === null
      ? 0
      : Math.max(0, Math.min(desiredLiveRows, maxRows - (fold === null ? 0 : 1) - keepCount));

  const renderedNonLive = keptNonLive.map((entry) =>
    renderPastEntry(entry, width, entry === lastStepEntry),
  );
  const renderedLive = liveEntry === null ? [] : [renderLiveReasoning(wrappedLive, liveRows)];

  return { fold, entries: [...renderedNonLive, ...renderedLive] };
}
