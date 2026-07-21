import { describe, expect, test } from "bun:test"

import { COMMAND_KINDS_V1, type CommandKindV1 } from "core/protocol"
import { uuidv7 } from "infrastructure/uuid"

import type { KernelStateSnapshot } from "../types"
import { TURN_LOCKED_KINDS, isTurnLockedKind, turnLockedReason } from "./turn-lock"

/**
 * kernel-command-contract §10.4 (lines 954-976), "Required turn-time capability matrix" —
 * "While `TurnState` is non-idle". The list below is transcribed BY HAND from that table's
 * rows, independently of `turn-lock.ts`'s own `TURN_LOCKED_KINDS`, so a wrong or drifted
 * implementation list shows up as a failing assertion here.
 *
 * Excluded deliberately, per the table's own text:
 * - `turn.start` — §7.2 gives it its own specific code, `TURN_ALREADY_ACTIVE`, which
 *   `core/capabilities/model/guards.ts`'s turn family produces directly; folding it into
 *   this generic `TURN_RUNNING` matrix too would just add a redundant second reason for
 *   the same fact `primaryReason` would rank behind it anyway.
 * - `turn.cancel` — "available for the exact active turn before commit intent, with the
 *   permissive revision rule": explicitly NOT locked.
 * - `commit.plan`/`commit.confirm`/`commit.discardPlan` — "The commit guards do NOT
 *   include `TURN_RUNNING`."
 * - `restore.discardPlan` — the row names only "Restore planning, confirmation, and
 *   execution"; discarding an obsolete plan is a cleanup action, not a mutation, mirroring
 *   why `turn.cancel` and the commit family stay unlocked.
 * - Read-only preview switching, local slash-command mode — no Kernel command, or
 *   explicitly "available when the preview/page guard permits it".
 */
const EXPECTED_TURN_LOCKED_KINDS: readonly CommandKindV1[] = [
  "chat.create",
  "chat.switch",
  "export.start",
  "model.select",
  "page.renameTitle",
  "page.removePlan",
  "page.removeConfirm",
  "page.removeDiscardPlan",
  "page.reorder",
  "restore.plan",
  "restore.confirm",
  "restore.retryRecord",
]

const NOT_LOCKED_KINDS: readonly CommandKindV1[] = [
  "turn.start",
  "turn.cancel",
  "commit.plan",
  "commit.confirm",
  "commit.discardPlan",
  "restore.discardPlan",
  "preview.selectPage",
  "preview.resize",
  "selection.set",
  "selection.clear",
  "pin.create",
  "pin.setStatus",
  "migration.plan",
  "history.open",
  "project.setTrust",
]

function baseState(): KernelStateSnapshot {
  return {
    project: { phase: "ready", trust: "trusted" },
    turn: { phase: "idle", activeTurnId: null, commitIntentRecorded: false },
    restore: { phase: "idle" },
    commit: { phase: "idle" },
    export: { phase: "idle" },
    preview: { phase: "disabled", sourceKind: null },
    migration: { phase: "idle" },
  }
}

describe("TURN_LOCKED_KINDS — §10.4's matrix, transcribed", () => {
  test("is exactly the 12 kinds §10.4 names, no more, no fewer", () => {
    expect([...TURN_LOCKED_KINDS].sort()).toEqual([...EXPECTED_TURN_LOCKED_KINDS].sort())
    expect(TURN_LOCKED_KINDS.length).toBe(12)
  })

  test("contains no duplicate kind", () => {
    expect(new Set(TURN_LOCKED_KINDS).size).toBe(TURN_LOCKED_KINDS.length)
  })

  test("every kind is one of the 43 command kinds", () => {
    const allKinds = new Set(COMMAND_KINDS_V1)
    for (const kind of TURN_LOCKED_KINDS) {
      expect(allKinds.has(kind), `${kind} is not a real CommandKindV1`).toBe(true)
    }
  })
})

describe("isTurnLockedKind", () => {
  test("is true for every §10.4 turn-locked kind", () => {
    for (const kind of EXPECTED_TURN_LOCKED_KINDS) {
      expect(isTurnLockedKind(kind), `${kind} should be turn-locked`).toBe(true)
    }
  })

  test("is false for turn.start, turn.cancel, the commit family, restore.discardPlan, and other unlocked kinds", () => {
    for (const kind of NOT_LOCKED_KINDS) {
      expect(isTurnLockedKind(kind), `${kind} should not be turn-locked`).toBe(false)
    }
  })
})

describe("turnLockedReason", () => {
  test("is null for a locked kind while TurnState is idle", () => {
    const state = baseState()
    for (const kind of EXPECTED_TURN_LOCKED_KINDS) {
      expect(turnLockedReason(kind, state), `${kind} at idle should be unlocked`).toBeNull()
    }
  })

  test("is TURN_RUNNING with the active turnId for a locked kind while TurnState is non-idle", () => {
    const turnId = uuidv7()
    const nonIdlePhases: readonly KernelStateSnapshot["turn"]["phase"][] = [
      "admitting",
      "workspace-ready",
      "running",
      "stopping",
      "snapshotting",
      "validating",
      "finalizing",
      "terminalizing",
    ]
    for (const phase of nonIdlePhases) {
      const state: KernelStateSnapshot = {
        ...baseState(),
        turn: { phase, activeTurnId: turnId, commitIntentRecorded: false },
      }
      for (const kind of EXPECTED_TURN_LOCKED_KINDS) {
        expect(turnLockedReason(kind, state), `${kind} at ${phase} should be locked`).toEqual({
          code: "TURN_RUNNING",
          turnId,
        })
      }
    }
  })

  test("is null for every non-locked kind regardless of turn phase", () => {
    const turnId = uuidv7()
    const state: KernelStateSnapshot = {
      ...baseState(),
      turn: { phase: "running", activeTurnId: turnId, commitIntentRecorded: false },
    }
    for (const kind of NOT_LOCKED_KINDS) {
      expect(turnLockedReason(kind, state), `${kind} should never be locked by this matrix`).toBeNull()
    }
  })

  test("falls back to CAPABILITY_UNAVAILABLE (not a fabricated turnId) when the snapshot is inconsistent", () => {
    const state: KernelStateSnapshot = {
      ...baseState(),
      turn: { phase: "running", activeTurnId: null, commitIntentRecorded: false },
    }
    const originalWarn = console.warn
    let warned = false
    console.warn = () => {
      warned = true
    }
    try {
      expect(turnLockedReason("chat.create", state)).toEqual({ code: "CAPABILITY_UNAVAILABLE" })
    } finally {
      console.warn = originalWarn
    }
    expect(warned, "an inconsistent snapshot should be logged, never silently accepted").toBe(true)
  })
})
