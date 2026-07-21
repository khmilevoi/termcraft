import type { FailureDtoV1 } from "core/protocol"

/**
 * `RecoveryService`: startup transaction recovery (turn-durability §4.6; storage-identity
 * §10.2) plus the turn-durability §7.7 orphan-turn scan, narrowed from
 * `store/transaction`'s real `recoverTransactions`/`classifyTransaction` and
 * `store/index.ts`'s `OrphanTurnOutcome` per decision C1.
 *
 * `hasIntentRecord` is the "journal inspection for intent-proof" this file's task brief
 * names: Export and Migration's `publishing -> failBeforeIntent -> idle` edge (6C's
 * transition table) is legal only with journal proof that `intent.json` was never written
 * for the failed transaction — a failure discovered AFTER intent is durable is instead a
 * roll-forward-on-restart case, not a "fail before intent" one. This method is that proof,
 * exposed narrowly rather than handing the caller the whole classification machinery.
 */

/** Mirrors `store/transaction`'s `RecoveryOutcome` (turn-durability §4.6), redrawn per C1. */
export type RecoveryOutcomeV1 =
  | { readonly ok: true; readonly recovered: number; readonly discarded: number; readonly alreadyComplete: number }
  | { readonly ok: false; readonly transactionId: string; readonly error: FailureDtoV1 }

/** One transaction directory's classification (turn-durability §10.2's four branches), redrawn per C1 minus the plan/payload internals `core` never needs. */
export type TransactionClassificationV1 =
  | { readonly kind: "discard"; readonly transactionId: string }
  | { readonly kind: "roll-forward"; readonly transactionId: string }
  | { readonly kind: "complete"; readonly transactionId: string }
  | { readonly kind: "conflict"; readonly transactionId: string; readonly reason: string }

/** One turn the startup orphan scan found without a terminal record, and what it did about it (turn-durability §7.7). */
export interface OrphanTurnOutcomeV1 {
  readonly chatId: string
  readonly turnId: string
  readonly terminalized: boolean
}

export interface RecoveryService {
  /** The complete startup recovery pass, run once before Workspace opens (§4.6/§10.2). */
  recover(): Promise<RecoveryOutcomeV1>
  /** Classify one `transactions.local/{transactionId}/` directory without touching any target (§10.2). */
  classify(transactionId: string): Promise<FailureDtoV1 | TransactionClassificationV1>
  /** `true` only when `intent.json` exists for `transactionId` — the proof Export/Migration's `failBeforeIntent` edge requires. */
  hasIntentRecord(transactionId: string): Promise<FailureDtoV1 | boolean>
  /** The full multi-chat orphan-turn sweep (§7.7's seven-row table, including `chat_corrupt`). */
  scanOrphanTurns(): Promise<FailureDtoV1 | readonly OrphanTurnOutcomeV1[]>
}
