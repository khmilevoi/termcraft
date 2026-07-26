import { atom, bind, sleep, withConnectHook, wrap } from "@reatom/core";

/** One second — the coarsest tick that still keeps `· 2m 40s` truthful. Chosen here; the design
 *  supplies the FORMAT (`design/termcraft-engine.js:547`), not a cadence. */
export const ELAPSED_INTERVAL_MS = 1_000;

/**
 * The shared elapsed ticker. Lifetime is owned by its connect hook (RTM-L01/L02) exactly like
 * `spinnerGlyph` (`frames.ts`): it starts when something first reads it and stops when the last
 * reader goes away, so it starts and stops with the turn on its own — no `turn.phase` flag to
 * keep in sync and no timer left running over an idle app.
 *
 * Holds the CURRENT TIME (`Date.now()`), not a counter — `Spinner` subtracts a turn's
 * `startedAt` from this value, so the atom must carry an absolute instant for that subtraction
 * to mean anything.
 *
 * The `bind(...)` captures are created in the hook body, BEFORE the fire-and-forget loop, and the
 * loop is never awaited from Reatom code — the exact shape `frames.ts`'s `spinnerGlyph` already
 * uses. An `await` on an unwrapped inner promise is its own context boundary, so binding inside
 * the loop instead would write to the default context.
 */
export const elapsedTick = atom(0, "ui.spinner.elapsedTick").extend(
  withConnectHook(() => {
    let active = true;
    const advance = bind(() => {
      elapsedTick.set(Date.now());
    });
    const waitTick = bind(() => wrap(sleep(ELAPSED_INTERVAL_MS)));

    advance();

    void (async () => {
      while (active) {
        const ticked = await waitTick().catch((cause: unknown) => cause);
        // A rejected sleep means the surrounding scope was aborted (the last reader
        // disconnected mid-wait) — stop silently rather than reporting a failure the user
        // cannot act on.
        if (ticked !== undefined) return;
        if (!active) return;
        advance();
      }
    })();

    return () => {
      active = false;
    };
  }),
);

/** `18s` · `2m 40s` · `1h 04m` — the design's own `· 2m 40s` shape (`design/termcraft-engine.js:547`,
 *  `genTurn`'s `'long'` frame), widened for the two bounds it does not draw. Never negative: a
 *  clock that moved backwards renders `0s`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
