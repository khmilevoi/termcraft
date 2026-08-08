/**
 * The handshake budget, shared by the long-lived session driver (`session.ts`) and the one-shot
 * smoke/export driver (`one-shot.ts`).
 *
 * RAISED FROM 3 s (2026-07-27, HANDOFF Finding 4). The design host is this same binary
 * re-invoked as `bun <srcRoot> _host --stdio` (`spawn-command.ts`), so every spawn transpiles and
 * loads the whole application graph before reaching the first statement of `main.tsx`. A
 * `HANDSHAKE_TIMEOUT` is a BUDGETED failure (`restart-policy.ts`), so missing it does not fail
 * once: it burns all three automatic restarts, spawning four incarnations that each die the same
 * way. That crash loop is what the maintainer experienced as the app freezing.
 *
 * WHAT THE WAIT ACTUALLY IS (corrected 2026-07-28). The raise was justified by a "2-3 s" figure
 * that was never measured — it was reconstructed from scratch-directory mtimes, before either end
 * of the handshake was logged. `session.ts`'s `host.handshake` trace now measures it directly, and
 * across 43 successful handshakes on the maintainer's machine the wait was 464-1799 ms, median
 * ~544 ms — typically 0.5-0.6 s, roughly a quarter of the number this comment used to assert.
 *
 * The 10 s budget stays anyway, and 10 s matches {@link MOUNT_TIMEOUT_MS}, the existing
 * precedent for "this child legitimately needs seconds". The honest reason to leave it alone is
 * that it is now GENEROUS rather than tight — ~18x the median and ~5x the slowest wait observed
 * — and the cost of headroom here is bounded (one slow failure path) while the cost of another
 * too-tight budget is the crash loop above.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The operator-facing failure reason, derived so it can never drift from the budget above. */
export const HANDSHAKE_TIMEOUT_REASON = `no host.hello within ${HANDSHAKE_TIMEOUT_MS / 1_000}s`;

/**
 * The budget from a sent `mount` to the correlated `ready` (design §9.4). On `start()` this
 * covers `ready` AND the first frame together, in either order (`awaitReady`'s own deadline); a
 * repeated `mount()` inside a live incarnation (design §9.2, Task 3) uses this same value as its
 * own per-request timeout. Moved here (was module-private in `session.ts`) because both this
 * budget and {@link FIRST_FRAME_TIMEOUT_MS} below belong to the same design §9.4 pair, and
 * `one-shot.ts`'s own one-shot capture deadline (`CAPTURE_TIMEOUT_MS`) is a DIFFERENT, separately
 * named budget for a different lifecycle, not a copy of this one.
 */
export const MOUNT_TIMEOUT_MS = 10_000;

/**
 * The budget from an accepted `ready` to the frame that must follow it (design §9.4).
 *
 * WHY IT IS A CONFORMANCE GUARD AND NOT THE PRIMARY DEADLINE. `host-state-machine.ts`'s
 * `handleMount` renders, captures, sends `ready` and calls `emitFrame` in ONE synchronous
 * block, so for this host the interval this bounds is unmeasurably small and every real hang
 * is caught by the mount deadline instead. It exists because `ready` is a CLAIM ("the page
 * mounted") and the frame is the EVIDENCE, and a supervisor that accepted the claim without
 * the evidence would leave the preview waiting forever with a healthy-looking session.
 *
 * 5 s is half of {@link HANDSHAKE_TIMEOUT_MS} and of `MOUNT_TIMEOUT_MS`, chosen — not
 * measured, because there is nothing here to measure — as generous for an interval whose real
 * value is zero, while still being an order of magnitude below the point a user would call the
 * app hung.
 */
export const FIRST_FRAME_TIMEOUT_MS = 5_000;
