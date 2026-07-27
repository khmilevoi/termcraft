/**
 * The handshake budget, shared by the long-lived session driver (`session.ts`) and the one-shot
 * smoke/export driver (`one-shot.ts`).
 *
 * RAISED FROM 3 s (2026-07-27, HANDOFF Finding 4). The design host is this same binary
 * re-invoked as `bun <srcRoot> _host --stdio` (`spawn-command.ts`), so every spawn transpiles and
 * loads the whole application graph before reaching the first statement of `main.tsx` — measured
 * at 2-3 s on the maintainer's machine, against a 3 s budget. A `HANDSHAKE_TIMEOUT` is a
 * BUDGETED failure (`restart-policy.ts`), so missing it does not fail once: it burns all three
 * automatic restarts, spawning four incarnations that each die the same way. That crash loop is
 * what the maintainer experienced as the app freezing.
 *
 * 10 s matches `MOUNT_TIMEOUT_MS`, the existing precedent for "this child legitimately needs
 * seconds". It is a floor chosen to clear a measurement, not a ceiling: `session.ts` now traces
 * the actual wait (`host.handshake`), so the next revision of this number can come from data.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The operator-facing failure reason, derived so it can never drift from the budget above. */
export const HANDSHAKE_TIMEOUT_REASON = `no host.hello within ${HANDSHAKE_TIMEOUT_MS / 1_000}s`;
