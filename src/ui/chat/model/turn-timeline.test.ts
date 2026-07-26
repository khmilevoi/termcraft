import { describe, expect, it } from "bun:test";

import type { TurnTimelineEntry } from "ui/mirror";

import { foldTurnTimeline, wrapText } from "./turn-timeline";

const reasoning = (text: string): TurnTimelineEntry => ({ kind: "reasoning", text });
const step = (op: string, target: string): TurnTimelineEntry => ({ kind: "step", op, target });

/** Design `genTurn`'s own `R.samples` (`design/termcraft-engine.js:519`) — the measured
 *  248-491-char prose the brief cites, reused here rather than an invented fixture string. */
const LONG_PROSE =
  "Sixty samples is about the pane width at the narrowest supported size, so the series will not need resampling when the preview is resized. The peaks read better against a shared y-max with the memory gauge, and putting the ↑/↓ throughput labels under the chart rather than inline keeps the row height at one line, which matters because the processes table below is already tight.";

describe("wrapText", () => {
  it("wraps on word boundaries and hard-splits an over-long word (design wrapLines :298-301)", () => {
    expect(wrapText("the gauges already fill the top band", 12)).toEqual([
      "the gauges",
      "already fill",
      "the top band",
    ]);
    expect(wrapText("aaaaaaaaaaaaaaa", 5)).toEqual(["aaaaa", "aaaaa", "aaaaa"]);
  });
});

describe("foldTurnTimeline", () => {
  it("tails the LIVE block to its cap and marks the scrolled head (design thinkRow :552-559)", () => {
    const { entries } = foldTurnTimeline({
      entries: [reasoning(LONG_PROSE)],
      width: 20,
      maxRows: 20,
      liveCap: 3,
    });
    const last = entries.at(-1);
    expect(last?.kind).toBe("reasoning");
    if (last?.kind !== "reasoning") return;
    expect(last.live).toBe(true);
    expect(last.clipped).toBe(true);
    expect(last.lines).toHaveLength(3);
  });

  it("collapses a PAST block to its first line plus …", () => {
    const { entries } = foldTurnTimeline({
      entries: [reasoning(LONG_PROSE), step("write", "page.tsx")],
      width: 20,
      maxRows: 20,
      liveCap: 5,
    });
    const first = entries[0];
    if (first?.kind !== "reasoning") return;
    expect(first.live).toBe(false);
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]?.endsWith("…")).toBe(true);
  });

  it("folds the head into one counted row that counts BOTH thoughts and steps (design :539)", () => {
    const entries = [
      ...Array.from({ length: 6 }, (_, i) => reasoning(`thought ${i}`)),
      ...Array.from({ length: 5 }, (_, i) => step("write", `page-${i}.tsx`)),
      reasoning(LONG_PROSE),
    ];
    const folded = foldTurnTimeline({ entries, width: 40, maxRows: 6, liveCap: 5 });
    expect(folded.fold).toEqual({ thoughts: 6, steps: 5 });
  });

  it("never lets the live block push the fold row off — the live block always fits", () => {
    const { entries } = foldTurnTimeline({
      entries: [step("a", "b"), reasoning(LONG_PROSE)],
      width: 40,
      maxRows: 3,
      liveCap: 5,
    });
    const last = entries.at(-1);
    if (last?.kind !== "reasoning") return;
    expect(last.lines.length).toBeLessThanOrEqual(2); // one row spent on the fold marker
  });

  it("never fabricates a fold row when nothing was elided", () => {
    const { fold, entries } = foldTurnTimeline({
      entries: [reasoning(LONG_PROSE)],
      width: 20,
      maxRows: 20,
      liveCap: 3,
    });
    expect(fold).toBeNull();
    expect(entries).toHaveLength(1);
  });

  it("returns an empty timeline as-is", () => {
    expect(foldTurnTimeline({ entries: [], width: 20, maxRows: 20, liveCap: 3 })).toEqual({
      fold: null,
      entries: [],
    });
  });

  it("does not filter whitespace-only reasoning text — renders it as one (empty) line", () => {
    // A lone space carries no token for `wrapText`'s `split(" ")` to keep — same collapse the
    // design's own `wrapLines` produces (`String(str).split(' ')` on `" "` yields `["", ""]`,
    // and two empty words never accumulate a space between them). The contract only promises
    // this entry ISN'T DROPPED, not that its whitespace survives wrapping.
    const { entries } = foldTurnTimeline({
      entries: [reasoning(" ")],
      width: 20,
      maxRows: 20,
      liveCap: 3,
    });
    const last = entries.at(-1);
    expect(last?.kind).toBe("reasoning");
    if (last?.kind !== "reasoning") return;
    expect(last.live).toBe(true);
    expect(last.clipped).toBe(false);
    expect(last.lines).toEqual([""]);
  });

  it("marks the last step entry active (not done) and every earlier step done", () => {
    const { entries } = foldTurnTimeline({
      entries: [step("read", "design"), step("write", "widgets")],
      width: 20,
      maxRows: 20,
      liveCap: 3,
    });
    expect(entries[0]).toEqual({ kind: "step", op: "read", target: "design", done: true });
    expect(entries[1]).toEqual({ kind: "step", op: "write", target: "widgets", done: false });
  });
});
