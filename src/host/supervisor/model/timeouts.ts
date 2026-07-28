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
 * The 10 s budget stays anyway, and 10 s matches `MOUNT_TIMEOUT_MS`, the existing precedent for
 * "this child legitimately needs seconds". The honest reason to leave it alone is that it is now
 * GENEROUS rather than tight — ~18x the median and ~5x the slowest wait observed — and the cost
 * of headroom here is bounded (one slow failure path) while the cost of another too-tight budget
 * is the crash loop above.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The operator-facing failure reason, derived so it can never drift from the budget above. */
export const HANDSHAKE_TIMEOUT_REASON = `no host.hello within ${HANDSHAKE_TIMEOUT_MS / 1_000}s`;
