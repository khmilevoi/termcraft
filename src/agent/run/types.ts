import type { AgentEvent, TokenUsage, TurnFence } from "entities/turn"
import type { ProcessTree } from "infrastructure/process"

/**
 * The terminal outcome a vendor stream can produce on its own. `cancelled` and
 * `unconfirmed-exit` are the engine's to decide — a driver never names them.
 */
export type NaturalOutcome =
  | {
      readonly kind: "completed"
      readonly finalText: string
      readonly usage: TokenUsage | null
      readonly sessionId: string
    }
  | { readonly kind: "backend-error"; readonly message: string; readonly sessionId: string | null }

/** The engine-owned surface one run's driver writes to. */
export interface RunSink {
  /**
   * True once this run has a terminal owner — i.e. `cancel()` won the race.
   * The driver must stop reading and return; nothing it does after this is
   * observable (turn-durability §6.4's late-event drop).
   */
  isTerminal(): boolean
  /**
   * Emit one normalized event. Never blocks and never depends on a reader, so
   * `outcome` settles even when nobody iterates `AgentRun.events`.
   */
  emit(event: AgentEvent): void
  /**
   * Claim the natural terminal outcome together with this run's last events.
   * The engine latches, emits `finalEvents`, closes the stream, and only then
   * runs exit confirmation — passing the events here rather than emitting them
   * separately is what makes that ordering structural instead of a convention.
   * If the latch is already taken, both the outcome and the events are dropped.
   */
  complete(outcome: NaturalOutcome, finalEvents?: readonly AgentEvent[]): void
}

/**
 * One vendor's stream reader. A driver owns its own vendor error vocabulary and
 * is expected to convert its boundary throws into `complete({kind:"backend-error"})`;
 * the engine's own catch is a backstop, not the primary path.
 */
export type RunDriver = (sink: RunSink) => Promise<void>

/** Deps for {@link startAgentRun}. Carries no vendor type — by design. */
export interface RunDeps {
  readonly processTree: ProcessTree
  readonly abortController: AbortController
  /** Injectable delay for the §6.5 waits; production = `(ms) => Bun.sleep(ms)`. */
  readonly wait: (ms: number) => Promise<void>
  readonly confirmTimeoutMs?: number
}

export type { TurnFence }
