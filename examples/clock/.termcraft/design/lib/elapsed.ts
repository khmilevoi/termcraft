import { isExport } from "@termcraft/runtime"

// Shared elapsed-time-tracking logic for the stopwatch and timer pages. Both pages
// keep the same three atoms (running / startedAt / committed elapsed) and the same
// "add a live Date.now() delta while running, freeze on export" rule — this factory
// is the one place that rule is written.

/**
 * Builds a `currentElapsedMs` reader over a page's own running/startedAt/elapsed
 * atoms (passed as zero-arg readers, i.e. the atoms themselves). While running it
 * adds the live wall-clock delta since `startedAt` to the last committed value;
 * `Date.now()` only runs off the export flag's guard (§ "What not to do" in
 * RUNTIME.md) — a sealed export/replay render always takes the `isExport()` branch
 * and reports the last committed elapsed value, never a live wall-clock delta.
 */
export function makeElapsedMsReader(
  running: () => boolean,
  startedAt: () => number | null,
  elapsedMs: () => number,
): () => number {
  return function currentElapsedMs(): number {
    const at = startedAt()
    if (running() && at != null && !isExport()) {
      return elapsedMs() + (Date.now() - at)
    }
    return elapsedMs()
  }
}
