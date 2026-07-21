import { describe, expect, test } from "bun:test"

import type { OrphanTurnOutcomeV1 } from "core/ports"
import { createFakeRecoveryService } from "core/ports/fakes"

import { classifyOrphanTurns, scanOrphanTurns } from "./orphan-turn-scan"

/**
 * TD §7.7's full seven-row orphan/nonterminal-turn decision table.
 *
 * Rows 1 (complete; no action), 3 (interrupted append), and 4 (discard + interrupted
 * append) all collapse to what `RecoveryService.scanOrphanTurns()` itself already
 * reports (that port's own doc: "the startup orphan scan found... and what it did about
 * it" — the STORE performs the per-chat remediation; nothing here re-appends a record).
 * Row 2 (pending intended transaction — recover, then rescan) and row 7 (recovery
 * conflict) are satisfied by `open-sequence.ts`'s own step ordering — generic
 * transaction recovery (TD step 4) always runs before this scan (TD step 8) — and are
 * covered by `open-sequence.test.ts`, not here. That leaves exactly what this file's
 * classifier computes: rows 5 and 6, PLUS the cross-chat correlation this task names as
 * "the caller's" job.
 */

describe("classifyOrphanTurns", () => {
  test("row 1: an empty report classifies to nothing", () => {
    expect(classifyOrphanTurns([])).toEqual([])
  })

  test("rows 3/4: a singleton the store already terminalized resolves with no further action", () => {
    const outcomes: readonly OrphanTurnOutcomeV1[] = [{ chatId: "chat-a", turnId: "turn-1", terminalized: true }]
    expect(classifyOrphanTurns(outcomes)).toEqual([{ kind: "resolved", chatId: "chat-a", turnId: "turn-1" }])
  })

  test("row 5: a singleton the store could NOT terminalize is chat_corrupt (terminal record without its user record)", () => {
    const outcomes: readonly OrphanTurnOutcomeV1[] = [{ chatId: "chat-a", turnId: "turn-1", terminalized: false }]
    expect(classifyOrphanTurns(outcomes)).toEqual([
      { kind: "chat-corrupt", chatId: "chat-a", turnId: "turn-1", reason: "terminal-without-user" },
    ])
  })

  test("row 6 (duplicate records): the same (chatId, turnId) reported more than once is chat_corrupt for every occurrence", () => {
    const outcomes: readonly OrphanTurnOutcomeV1[] = [
      { chatId: "chat-a", turnId: "turn-1", terminalized: true },
      { chatId: "chat-a", turnId: "turn-1", terminalized: false },
    ]
    expect(classifyOrphanTurns(outcomes)).toEqual([
      { kind: "chat-corrupt", chatId: "chat-a", turnId: "turn-1", reason: "duplicate-in-chat" },
      { kind: "chat-corrupt", chatId: "chat-a", turnId: "turn-1", reason: "duplicate-in-chat" },
    ])
  })

  test("row 6 (cross-chat turnId): the same turnId under two different chatIds is chat_corrupt for every occurrence, regardless of terminalized", () => {
    const outcomes: readonly OrphanTurnOutcomeV1[] = [
      { chatId: "chat-a", turnId: "turn-1", terminalized: true },
      { chatId: "chat-b", turnId: "turn-1", terminalized: true },
    ]
    expect(classifyOrphanTurns(outcomes)).toEqual([
      { kind: "chat-corrupt", chatId: "chat-a", turnId: "turn-1", reason: "cross-chat-turn-id" },
      { kind: "chat-corrupt", chatId: "chat-b", turnId: "turn-1", reason: "cross-chat-turn-id" },
    ])
  })

  test("independent turns classify independently: one resolved, one corrupt, no cross-contamination", () => {
    const outcomes: readonly OrphanTurnOutcomeV1[] = [
      { chatId: "chat-a", turnId: "turn-1", terminalized: true },
      { chatId: "chat-b", turnId: "turn-2", terminalized: false },
    ]
    expect(classifyOrphanTurns(outcomes)).toEqual([
      { kind: "resolved", chatId: "chat-a", turnId: "turn-1" },
      { kind: "chat-corrupt", chatId: "chat-b", turnId: "turn-2", reason: "terminal-without-user" },
    ])
  })

  test("idempotent: classifying the same report twice yields byte-identical decisions", () => {
    const outcomes: readonly OrphanTurnOutcomeV1[] = [
      { chatId: "chat-a", turnId: "turn-1", terminalized: true },
      { chatId: "chat-b", turnId: "turn-2", terminalized: false },
      { chatId: "chat-c", turnId: "turn-3", terminalized: true },
      { chatId: "chat-d", turnId: "turn-3", terminalized: true },
    ]
    const first = classifyOrphanTurns(outcomes)
    const second = classifyOrphanTurns(outcomes)
    expect(second).toEqual(first)
  })
})

describe("scanOrphanTurns", () => {
  test("drives RecoveryService.scanOrphanTurns() and classifies its report", async () => {
    const recovery = createFakeRecoveryService({
      orphans: [
        { chatId: "chat-a", turnId: "turn-1", terminalized: true },
        { chatId: "chat-b", turnId: "turn-2", terminalized: false },
      ],
    })
    const result = await scanOrphanTurns({ recovery })
    if ("code" in result) throw new Error("unexpected failure")
    expect(result).toEqual([
      { kind: "resolved", chatId: "chat-a", turnId: "turn-1" },
      { kind: "chat-corrupt", chatId: "chat-b", turnId: "turn-2", reason: "terminal-without-user" },
    ])
  })

  test("propagates a scanOrphanTurns() port failure", async () => {
    const recovery = createFakeRecoveryService()
    const failure = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "chat log unreadable", details: {} } as const
    recovery.failNext("scanOrphanTurns", failure)

    const result = await scanOrphanTurns({ recovery })

    expect(result).toEqual(failure)
  })

  test("a rescan after remediation (store no longer reports the turn) is a clean no-op — proves repeated rescans are idempotent", async () => {
    const beforeRemediation = createFakeRecoveryService({
      orphans: [{ chatId: "chat-a", turnId: "turn-1", terminalized: true }],
    })
    const first = await scanOrphanTurns({ recovery: beforeRemediation })
    if ("code" in first) throw new Error("unexpected failure")
    expect(first).toEqual([{ kind: "resolved", chatId: "chat-a", turnId: "turn-1" }])

    // A second Kernel process's rescan of the SAME project, after the store durably
    // completed remediation, would no longer report `turn-1` at all (TD §7.7 row 1: now
    // "one user record and one successful terminal record" — complete, no action).
    const afterRemediation = createFakeRecoveryService({ orphans: [] })
    const second = await scanOrphanTurns({ recovery: afterRemediation })
    if ("code" in second) throw new Error("unexpected failure")
    expect(second).toEqual([])
  })
})
