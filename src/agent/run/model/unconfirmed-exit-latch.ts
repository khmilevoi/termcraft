import type { AgentRunOutcome } from "agent/types";

export interface UnconfirmedExitLatch {
  isLatched(): boolean;
  noteOutcome(outcome: AgentRunOutcome): void;
}

/**
 * Sticky, per-backend-instance lockout. Set the moment any run resolves
 * `unconfirmed-exit` — turn-durability §6.5 requires a backend be locked out of
 * new turns until "a full health check proves the owned tree absent".
 *
 * How it clears: it does not, in place. A tree is `close()`d on every outcome
 * including `unconfirmed-exit`, and closing is INVALIDATING — every method on
 * that tree refuses afterwards, so a backend has no way to re-query the
 * SPECIFIC stale tree to prove it emptied. Spawning an unrelated fresh CLI
 * proves nothing about the stale tree either, which is exactly the
 * false-admission bug this latch exists to close. Recovery therefore matches
 * §6.5's own documented remedy — the user restarts, which reconstructs the
 * backend and with it a fresh, unset latch.
 */
export function createUnconfirmedExitLatch(backendId: string): UnconfirmedExitLatch {
  let latched = false;
  return {
    isLatched: () => latched,
    noteOutcome: (outcome) => {
      if (outcome.kind !== "unconfirmed-exit") return;
      console.warn(
        `agent/run: ${backendId} run exited unconfirmed; latching this backend unhealthy until it is restarted (§6.5)`,
      );
      latched = true;
    },
  };
}
