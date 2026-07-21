import type { FailureDtoV1 } from "core/protocol"
import type { OrphanTurnOutcomeV1, RecoveryService } from "core/ports"

import type { OrphanTurnDecisionV1 } from "../types"

/**
 * The startup orphan/nonterminal-turn scan (TD §7.7's seven-row table, lines 836-853).
 *
 * `RecoveryService.scanOrphanTurns()` (`core/ports/recovery.ts`) is itself "the startup
 * orphan scan" per its own doc comment — it walks every chat and reports what it found
 * AND remediated: `terminalized: true` means it already appended the one `system:error`
 * `interrupted` record TD §7.7 rows 3/4 require (a fresh nonterminal turn, or a
 * prepared-but-not-intended transaction discarded first); `terminalized: false` means it
 * found a `(chatId, turnId)` it could NOT safely remediate on its own.
 *
 * Rows this file does NOT decide, and why:
 *   - Row 1 ("one user record and one successful terminal record — complete") never
 *     reaches this classifier at all: a resolved turn is not reported by
 *     `scanOrphanTurns()` in the first place.
 *   - Row 2 ("a pending intended finalization/terminalization transaction — recover
 *     first, then rescan") is TD step 4's job (`RecoveryService.recover()`), which
 *     `open-sequence.ts` always runs strictly BEFORE calling `scanOrphanTurns()` (TD
 *     step 8) — by the time this classifier ever sees a report, every pending intended
 *     transaction is already gone. See `open-sequence.test.ts` for the ordering proof.
 *   - Row 7 ("a related transaction is in recovery conflict — show Recovery Conflict
 *     before orphan terminalization") is the same generic recovery pass's OWN failure
 *     path (`recover()` returning `{ok: false, ...}`), which likewise blocks
 *     `open-sequence.ts` before this scan ever runs.
 *
 * What remains — and what a SINGLE chat's own local scan structurally CANNOT decide by
 * itself — is exactly this task's "the multi-chat decision is the caller's": whether a
 * `terminalized: false` singleton is row 5 ("terminal record without its user record"),
 * or whether MULTIPLE entries for the same `turnId` are row 6's "duplicate... records"
 * (same `chatId`, store reported it more than once) or "the same `turnId` in multiple
 * chats" (different `chatId`s) — the latter provably requires seeing every chat's report
 * at once, which is exactly what only the caller (this module), not any one chat's own
 * scan, can do.
 */

export interface OrphanTurnScanDeps {
  readonly recovery: RecoveryService
}

/**
 * Groups by `turnId` and classifies each group per TD §7.7 rows 5/6. Pure — no I/O, no
 * randomness, no clock — so repeated calls against the identical `outcomes` array always
 * produce byte-identical decisions (this file's own idempotence proof; a REAL rescan's
 * idempotence additionally depends on `RecoveryService.scanOrphanTurns()` no longer
 * reporting an already-remediated turn at all, which `scanOrphanTurns` below's own test
 * demonstrates against two differently-configured fakes).
 */
export function classifyOrphanTurns(outcomes: readonly OrphanTurnOutcomeV1[]): readonly OrphanTurnDecisionV1[] {
  const byTurnId = new Map<string, OrphanTurnOutcomeV1[]>()
  for (const outcome of outcomes) {
    const group = byTurnId.get(outcome.turnId)
    if (group === undefined) byTurnId.set(outcome.turnId, [outcome])
    else group.push(outcome)
  }

  const decisions: OrphanTurnDecisionV1[] = []
  for (const outcome of outcomes) {
    const group = byTurnId.get(outcome.turnId) ?? []
    decisions.push(classifyOne(outcome, group))
  }
  return decisions
}

function classifyOne(outcome: OrphanTurnOutcomeV1, group: readonly OrphanTurnOutcomeV1[]): OrphanTurnDecisionV1 {
  const distinctChatIds = new Set(group.map((entry) => entry.chatId))

  // TD §7.7 row 6, second clause: "the same turnId in multiple chats" — the fact only a
  // multi-chat view (this function's own input, never one chat's own local scan) can see.
  if (distinctChatIds.size > 1) {
    return { kind: "chat-corrupt", chatId: outcome.chatId, turnId: outcome.turnId, reason: "cross-chat-turn-id" }
  }

  // TD §7.7 row 6, first clause: "Duplicate user records, multiple terminal records" —
  // reported here as more than one entry for the identical (chatId, turnId) pair. "Never
  // guess which record wins" (§7.7) — every duplicate entry gets the same corrupt verdict.
  if (group.length > 1) {
    return { kind: "chat-corrupt", chatId: outcome.chatId, turnId: outcome.turnId, reason: "duplicate-in-chat" }
  }

  // A genuine singleton. `terminalized: true` is TD §7.7 rows 3/4 (the store already
  // remediated it); `terminalized: false` is row 5 ("terminal record without its user
  // record") — the only remaining explanation once rows 2/7 are ruled out by
  // `open-sequence.ts`'s step ordering (see this file's header).
  if (outcome.terminalized) return { kind: "resolved", chatId: outcome.chatId, turnId: outcome.turnId }
  return { kind: "chat-corrupt", chatId: outcome.chatId, turnId: outcome.turnId, reason: "terminal-without-user" }
}

/** Runs the port's own scan, then applies {@link classifyOrphanTurns} to its report. */
export async function scanOrphanTurns(deps: OrphanTurnScanDeps): Promise<FailureDtoV1 | readonly OrphanTurnDecisionV1[]> {
  const outcomes = await deps.recovery.scanOrphanTurns()
  // Same `"code" in result` idiom as `core/ports/fakes/page-store.test.ts`'s identical
  // `FailureDtoV1 | readonly T[]` union — an array has no `code` property, so this
  // narrows cleanly without needing `Array.isArray` (whose `arg is any[]` predicate does
  // not narrow a `readonly T[]` union member on this project's TypeScript version).
  if ("code" in outcomes) return outcomes

  return classifyOrphanTurns(outcomes)
}
