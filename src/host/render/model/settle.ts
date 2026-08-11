import { CodeRenderable } from "@opentui/core";
import type { Renderable } from "@opentui/core";

import type { CapturedFrame, FrameSettleOptions, FrameSettleResult } from "../types";

/**
 * WHY A SETTLE LOOP EXISTS AT ALL (design spec §6.1/§6.3).
 *
 * `RenderHandle.render()` — `renderer.intermediateRender(); await renderer.idle();` — is the
 * ONLY render seam in this repository, and `handleMount` calls it once and captures. Syntax
 * highlighting is asynchronous: it runs in `@opentui/core`'s tree-sitter WORKER, so a single
 * pass plus `idle()` snapshots the frame BEFORE any hue arrives. Because the host emits exactly
 * one frame per mount, that unhighlighted frame is not a transient — it is the frame, forever.
 *
 * Two mechanisms, in this order per pass, because neither alone is enough:
 *   1. `CodeRenderable.highlightingDone` — the PRECISE signal, and it covers `Markdown` too:
 *      every markdown block, fenced and prose alike, is itself a `CodeRenderable`.
 *   2. quiet frames — the general backstop for anything the walk cannot see (a highlight that
 *      spawns new blocks; a late worker message).
 *
 * The loop YIELDS REAL WALL-CLOCK TIME between passes. A tight loop with no yield does not let
 * the worker's message land, and this repository uses no fake timers anywhere.
 */
export const DEFAULT_FRAME_SETTLE = {
  /** Consecutive identical frames that end the loop. Two is the smallest number that can tell
   *  "nothing is happening" from "one pass happened to look the same". */
  quietFrames: 2,
  /** Wall-clock ceiling. ~350 ms is the design spec's budget for a small document. */
  budgetMs: 350,
  /** The yield between passes. Small enough that a static page costs ~16 ms in total. */
  pollMs: 8,
} as const satisfies Required<FrameSettleOptions>;

/** Everything the loop needs, injected so its logic is testable with no renderer and no clock. */
export interface SettleDriver {
  readonly render: () => Promise<void>;
  readonly snapshot: () => string;
  readonly pending: () => readonly Promise<void>[];
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly options?: FrameSettleOptions;
}

/**
 * A frame's identity for "did anything change".
 *
 * INCLUDES COLOUR AND ATTRIBUTES, NOT ONLY TEXT — this is the load-bearing detail. Highlighting
 * changes only colour, so a text-only fingerprint would report the plain-text frame as quiet on
 * its very first comparison and the loop would return before a single hue arrived.
 *
 * `run.fg`/`run.bg` are `Color` (`src/host/protocol/types.ts`): `"default" | { indexed } |
 * { rgb }`, not a bare string, so naive template interpolation (`${run.fg}`) would stringify
 * every object variant to the literal `"[object Object]"` and silently erase the very signal
 * this function exists to capture. `JSON.stringify` per run serializes `text`/`fg`/`bg`/`attrs`
 * by value instead.
 */
export function frameFingerprint(frame: CapturedFrame): string {
  return frame.rows.map((row) => row.map((run) => JSON.stringify(run)).join("")).join("\n");
}

/**
 * Every in-flight highlight promise reachable from a mounted tree.
 *
 * `MarkdownRenderable` exposes no aggregate completion signal, but it builds every block —
 * fenced code AND prose — as a `CodeRenderable`, so this one walk is precise for both wrappers.
 * The promise is re-read on every pass because `CodeRenderable` reassigns it inside `renderSelf`
 * each time highlights go dirty.
 */
export function collectHighlightingPromises(root: Renderable): readonly Promise<void>[] {
  const found: Promise<void>[] = [];
  const visit = (node: Renderable): void => {
    if (node instanceof CodeRenderable) found.push(node.highlightingDone);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

/** Render until the frame stops changing, or until the budget runs out. Never throws. */
export async function settleFrames(input: SettleDriver): Promise<FrameSettleResult> {
  const quietFrames = input.options?.quietFrames ?? DEFAULT_FRAME_SETTLE.quietFrames;
  const budgetMs = input.options?.budgetMs ?? DEFAULT_FRAME_SETTLE.budgetMs;
  const pollMs = input.options?.pollMs ?? DEFAULT_FRAME_SETTLE.pollMs;

  const started = input.now();
  await input.render();
  let last = input.snapshot();
  let quiet = 0;
  let passes = 0;

  while (input.now() - started < budgetMs) {
    // The highlight promises ACCELERATE the loop; they never gate it. A worker that dies leaves
    // a promise open forever, so the race is against ONE poll interval — never against the whole
    // remaining budget, which would spend the entire budget on the first pass. The `while`
    // condition is what bounds the total.
    //
    // `.catch(() => {})` on the `Promise.all` swallows a rejected `highlightingDone` (this
    // function's doc comment promises it never throws, and a failed highlight is exactly the
    // case the quiet-frames backstop below exists to fall through to). Not re-logged here:
    // `CodeRenderable.startHighlight` already warns on its own failure — this is only the
    // accelerator declining to gate on a signal that turned out bad.
    await Promise.race([Promise.all(input.pending()).catch(() => {}), input.sleep(pollMs)]);
    await input.render();
    passes += 1;
    const next = input.snapshot();
    if (next === last) {
      quiet += 1;
      if (quiet >= quietFrames) {
        return { settled: true, passes, elapsedMs: input.now() - started };
      }
    } else {
      quiet = 0;
      last = next;
    }
    // The SECOND yield, and the one that matters. When `Promise.all(pending())` wins the race
    // above it resolves on a microtask, so no wall-clock time passed and the worker's next
    // message never got a chance to land. This one always spends real time.
    await input.sleep(pollMs);
  }

  return { settled: false, passes, elapsedMs: input.now() - started };
}
