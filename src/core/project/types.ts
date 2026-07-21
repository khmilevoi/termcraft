import type { FailureDtoV1 } from "core/protocol";

/**
 * `core/project`'s shared vocabulary — the shapes more than one of `model/trust.ts`,
 * `model/orphan-turn-scan.ts`, `model/recovery-routing.ts`, and `model/open-sequence.ts`
 * need, per this repo's module-shape rule (CLAUDE.md "Code style": `types.ts` holds a
 * module's shared types). Each file's own request/dependency shape (its `*Deps`
 * interface) stays local to that file, matching `core/mailbox`'s precedent
 * (`dispatch.ts`'s `DispatchDeps` is not in `mailbox/types.ts`; only the seams two or
 * more files reach for live there).
 */

/**
 * KCC §7.1: "`ready` includes... trust state `trusted | untrusted-read-only`." `null`
 * (trust unresolved) is a `KernelStateSnapshot`-only concern (`core/capabilities/types.ts`
 * already types it there) — by the time `open-sequence.ts` reaches `finishOpen`, trust is
 * always one of these two values, never unresolved.
 */
export type TrustDecisionV1 = "trusted" | "untrusted-read-only";

/**
 * The one domain KCC §12.7 permits `kernel.project.beginRecovery` to route an intended
 * journal to: "invokes exactly one of `kernel.restore.beginRecovery`,
 * `kernel.export.beginRecovery`, or `kernel.migration.beginRecovery` from that domain's
 * `idle` state."
 */
export type IntendedRecoveryDomainV1 = "restore" | "export" | "migration";

/**
 * TD §7.7's three chat_corrupt causes this module's classifier can distinguish from
 * `RecoveryService.scanOrphanTurns()`'s own per-chat report (see `orphan-turn-scan.ts`'s
 * header for why only these three survive as CALLER-side facts): "terminal-without-user"
 * (row 5: "Agent/system terminal record without its user record"), "duplicate-in-chat"
 * (row 6's first clause: "Duplicate user records, multiple terminal records"), and
 * "cross-chat-turn-id" (row 6's second clause: "the same `turnId` in multiple chats" —
 * the one fact §7.7's own per-chat store scan structurally cannot see on its own, and
 * this task's explicitly-named "the MULTI-CHAT decision is the caller's").
 */
export type OrphanTurnCorruptReasonV1 =
  | "terminal-without-user"
  | "duplicate-in-chat"
  | "cross-chat-turn-id";

/** One `(chatId, turnId)` pair's TD §7.7 disposition after `classifyOrphanTurns` runs. */
export type OrphanTurnDecisionV1 =
  | { readonly kind: "resolved"; readonly chatId: string; readonly turnId: string }
  | {
      readonly kind: "chat-corrupt";
      readonly chatId: string;
      readonly turnId: string;
      readonly reason: OrphanTurnCorruptReasonV1;
    };

/** Every step TD §12's ordered startup sequence can stop at (`open-sequence.ts`). */
export type OpenSequenceStepV1 =
  | "open-project-store"
  | "journal-format"
  | "transaction-recovery"
  | "recovery-routing"
  | "migrations-gate"
  | "schema-validation"
  | "orphan-turn-scan"
  | "content-validation"
  | "trust";

/** A typed reason `open-sequence.ts` could not finish a step — always a real `FailureDtoV1`, never a fabricated code (see that file's header for the one exception it documents). */
export interface OpenSequenceBlockedV1 {
  readonly step: OpenSequenceStepV1;
  readonly failure: FailureDtoV1;
}
