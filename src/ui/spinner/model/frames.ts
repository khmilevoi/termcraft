import { atom, bind, sleep, withConnectHook, wrap } from "@reatom/core";

/**
 * The braille spinner cycle.
 *
 * DIVERGENCE (documented per the repo's design rule): the design system supplies the GLYPH but
 * no cadence. `design/termcraft-engine.js` draws `⠹ generating design…` as a single static frame
 * in four screens (`:188`, `:649`, `:730`, `:954`) — a static HTML mockup cannot express motion —
 * and its one animation primitive (`:85`, `tcblink 1.05s steps(1,end) infinite`) belongs to the
 * cursor, not to this. So the cycle below is the canonical braille sequence and the interval is
 * chosen here, not read from the design.
 *
 * The sequence is PHASE-SHIFTED so `⠹` — the exact glyph every design screen shows — is frame 0.
 * It is the same cycle either way (phase is arbitrary in a loop), and starting on the design's
 * own glyph keeps a freshly-mounted spinner pixel-identical to the mockups.
 */
export const SPINNER_FRAMES: readonly string[] = ["⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠋", "⠙"];

/** Chosen here, not design-sourced — see {@link SPINNER_FRAMES}. */
export const SPINNER_INTERVAL_MS = 80;

/**
 * The ONE shared spinner ticker. Every `Spinner` on screen reads this same atom, so N spinners
 * cost one timer, and they stay in phase with each other rather than drifting apart.
 *
 * Lifetime is owned by the connect hook (Reatom RTM-L01/L02): the timer starts when something
 * first reads this atom and stops when the last reader goes away. Since the only current caller
 * renders solely while a turn is running, the ticker starts and stops with the turn on its own —
 * there is no `turn.phase` flag to keep in sync, and no timer left spinning over an idle app.
 *
 * The `bind(...)` captures are created in the hook body, BEFORE the fire-and-forget loop, and the
 * loop is never awaited from Reatom code — the exact shape `ui/app/model/deps.ts`'s `runtime` atom
 * already uses. An `await` on an unwrapped inner promise is its own context boundary, so binding
 * inside the loop instead would write to the default context.
 */
export const spinnerGlyph = atom(0, "ui.spinner.frame").extend(
  withConnectHook(() => {
    let active = true;
    const advance = bind(() => {
      spinnerGlyph.set((spinnerGlyph() + 1) % SPINNER_FRAMES.length);
    });
    const waitTick = bind(() => wrap(sleep(SPINNER_INTERVAL_MS)));

    void (async () => {
      while (active) {
        const ticked = await waitTick().catch((cause: unknown) => cause);
        // A rejected sleep means the surrounding scope was aborted (the spinner unmounted mid
        // wait) — stop silently rather than reporting a failure the user cannot act on.
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

/** The glyph for the current tick. Reading this connects the shared ticker. */
export function currentSpinnerFrame(): string {
  return SPINNER_FRAMES[spinnerGlyph() % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0] ?? "";
}
