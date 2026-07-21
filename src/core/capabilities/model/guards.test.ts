import { describe, expect, test } from "bun:test"

import { COMMAND_KINDS_V1, REASON_CODES_V1, primaryReason, type CommandKindV1 } from "core/protocol"
import { uuidv7 } from "infrastructure/uuid"

import type { KernelStateSnapshot } from "../types"
import { evaluateCapabilityGuard } from "./guards"

/**
 * kernel-command-contract §10.2 (lines 905-921): "Each command family owns a pure guard
 * over exactly `(currentKernelState, CapabilityTargetByKindV1[K])`, returning `available`
 * or a non-empty typed reason list." §7.1 (lines 222-228), §7.2 (lines 230-270), and §7.7
 * (lines 401-412) are quoted and pinned individually below, each independently of
 * `guards.ts`'s own implementation.
 */

let slugSeq = 0
function slug(): string {
  slugSeq += 1
  return `slug-${slugSeq}`
}

const FULL_COMMIT = "a".repeat(40)

/** A schema-valid representative `CapabilityTargetByKindV1[K]` for every one of the 43 kinds. */
function representativeTarget(kind: CommandKindV1): unknown {
  switch (kind) {
    case "project.create":
    case "project.open":
    case "project.close":
    case "turn.start":
    case "chat.create":
    case "page.reorder":
    case "selection.clear":
    case "export.start":
    case "migration.plan":
      return null
    case "project.retryOpen":
      return { recovery: { kind: "restore", restoreActionId: uuidv7() } }
    case "project.setTrust":
      return { workspaceIdentity: "workspace-1" }
    case "turn.cancel":
      return { turnId: uuidv7() }
    case "chat.switch":
      return { chatId: uuidv7() }
    case "model.select":
      return { backend: "anthropic", model: "claude", effort: "medium" }
    case "page.renameTitle":
    case "page.removePlan":
    case "history.open":
    case "preview.selectPage":
    case "preview.selectCurrent":
      return { pageSlug: slug() }
    case "page.removeConfirm":
    case "page.removeDiscardPlan":
      return { pageRemovePlanId: uuidv7() }
    case "preview.selectHistorical":
    case "restore.plan":
      return { pageSlug: slug(), sourceCommit: FULL_COMMIT }
    case "preview.resize":
    case "preview.forwardInput":
    case "preview.retry":
    case "preview.close":
      return { previewSessionId: uuidv7() }
    case "preview.setThemeCapabilities":
      return { previewSessionId: uuidv7(), themeId: "dark" }
    case "preview.setMode":
      return { previewSessionId: uuidv7(), mode: "static" }
    case "preview.setTweak":
      return { previewSessionId: uuidv7(), tweakId: "font-size" }
    case "preview.queryGeometry":
      return { frameTokenId: uuidv7(), queryKind: "hit" }
    case "selection.set":
      return { pageSlug: slug(), elementId: "el-1" }
    case "pin.create":
      return { geometryTokenId: uuidv7() }
    case "pin.setStatus":
      return { pinId: uuidv7(), status: "open" }
    case "restore.confirm":
    case "restore.discardPlan":
      return { restorePlanId: uuidv7() }
    case "restore.retryRecord":
      return { restoreActionId: uuidv7() }
    case "commit.plan":
      return { scope: "current-page" }
    case "commit.confirm":
    case "commit.discardPlan":
      return { commitPlanId: uuidv7() }
    case "migration.confirm":
    case "migration.discardPlan":
      return { migrationPlanId: uuidv7() }
    case "migration.retryRecovery":
      return { migrationActionId: uuidv7() }
  }
}

/** A fully clean, fully unblocked snapshot: trusted ready project, every model idle. */
function cleanState(): KernelStateSnapshot {
  return {
    project: { phase: "ready", trust: "trusted" },
    turn: { phase: "idle", activeTurnId: null, commitIntentRecorded: false },
    restore: { phase: "idle" },
    commit: { phase: "idle" },
    export: { phase: "idle" },
    preview: { phase: "live", sourceKind: "current" },
    migration: { phase: "idle" },
  }
}

const DEFERRED_KINDS: ReadonlySet<CommandKindV1> = new Set([
  "restore.plan",
  "restore.confirm",
  "restore.discardPlan",
  "restore.retryRecord",
  "commit.plan",
  "commit.confirm",
  "commit.discardPlan",
  "history.open",
  "preview.forwardInput",
  "preview.setTweak",
])

// --- Full sweep: every one of the 43 kinds produces a well-formed decision -------------

describe("evaluateCapabilityGuard — full 43-kind sweep against a clean state", () => {
  test("never throws, and every unavailable decision carries only real reason codes", () => {
    for (const kind of COMMAND_KINDS_V1) {
      const decision = evaluateCapabilityGuard(kind, representativeTarget(kind), cleanState())
      if (decision.available) continue
      expect(decision.reasons.length, `${kind}: reasons must be non-empty`).toBeGreaterThan(0)
      for (const reason of decision.reasons) {
        expect(REASON_CODES_V1 as readonly string[], `${kind}: unknown code ${reason.code}`).toContain(reason.code)
      }
    }
  })

  test("the 10 deferred kinds are unavailable even against an otherwise clean state", () => {
    for (const kind of DEFERRED_KINDS) {
      const decision = evaluateCapabilityGuard(kind, representativeTarget(kind), cleanState())
      expect(decision.available, `${kind} must never be available in this MVP phase`).toBe(false)
    }
  })

  test("a representative non-deferred, non-turn-locked kind is available against a clean state", () => {
    const decision = evaluateCapabilityGuard("selection.set", representativeTarget("selection.set"), cleanState())
    expect(decision).toEqual({ available: true })
  })
})

// --- §7.1 (lines 222-228): PROJECT_NOT_READY -------------------------------------------

describe("§7.1 PROJECT_NOT_READY", () => {
  const EXEMPT: readonly CommandKindV1[] = ["project.create", "project.open", "project.retryOpen", "project.close", "project.setTrust"]
  const NOT_READY_PHASES: readonly KernelStateSnapshot["project"]["phase"][] = [
    "closed",
    "opening",
    "recovering",
    "blocked",
    "closing",
  ]

  test("every non-exempt kind rejects with PROJECT_NOT_READY when the project is not ready", () => {
    for (const phase of NOT_READY_PHASES) {
      const state: KernelStateSnapshot = { ...cleanState(), project: { phase, trust: null } }
      for (const kind of COMMAND_KINDS_V1) {
        if (EXEMPT.includes(kind)) continue
        // migration.plan/confirm's pre-Workspace exception is its own test below.
        if ((kind === "migration.plan" || kind === "migration.confirm") && phase === "opening") continue
        const decision = evaluateCapabilityGuard(kind, representativeTarget(kind), state)
        expect(decision.available, `${kind} at project phase "${phase}" must be unavailable`).toBe(false)
        if (decision.available) continue
        expect(
          decision.reasons.some((r) => r.code === "PROJECT_NOT_READY"),
          `${kind} at project phase "${phase}" must carry PROJECT_NOT_READY`,
        ).toBe(true)
      }
    }
  })

  test("the five exempt project-lifecycle kinds never carry PROJECT_NOT_READY, at any project phase", () => {
    for (const phase of NOT_READY_PHASES) {
      const state: KernelStateSnapshot = { ...cleanState(), project: { phase, trust: null } }
      for (const kind of EXEMPT) {
        const decision = evaluateCapabilityGuard(kind, representativeTarget(kind), state)
        if (decision.available) continue
        expect(
          decision.reasons.some((r) => r.code === "PROJECT_NOT_READY"),
          `${kind} at "${phase}" must not carry PROJECT_NOT_READY`,
        ).toBe(false)
      }
    }
  })

  test("§7.7's 'trusted pre-Workspace migration plan/confirmation' exception: migration.plan/confirm are available while opening+trusted", () => {
    const state: KernelStateSnapshot = { ...cleanState(), project: { phase: "opening", trust: "trusted" } }
    expect(evaluateCapabilityGuard("migration.plan", null, state)).toEqual({ available: true })
    expect(
      evaluateCapabilityGuard("migration.confirm", { migrationPlanId: uuidv7() }, {
        ...state,
        migration: { phase: "awaiting-confirmation" },
      }),
    ).toEqual({ available: true })
  })

  test("the migration exception does not extend to an untrusted pre-Workspace project", () => {
    const state: KernelStateSnapshot = { ...cleanState(), project: { phase: "opening", trust: "untrusted-read-only" } }
    const decision = evaluateCapabilityGuard("migration.plan", null, state)
    expect(decision.available).toBe(false)
    if (decision.available) return
    expect(decision.reasons.some((r) => r.code === "PROJECT_NOT_READY")).toBe(true)
  })

  test("no kind carries PROJECT_NOT_READY once the project is ready", () => {
    const state = cleanState()
    for (const kind of COMMAND_KINDS_V1) {
      const decision = evaluateCapabilityGuard(kind, representativeTarget(kind), state)
      if (decision.available) continue
      expect(decision.reasons.some((r) => r.code === "PROJECT_NOT_READY"), `${kind} at ready`).toBe(false)
    }
  })
})

// --- §7.1: PROJECT_UNTRUSTED ------------------------------------------------------------

describe("§7.1 PROJECT_UNTRUSTED — untrusted-read-only", () => {
  const REMAINS_AVAILABLE: readonly CommandKindV1[] = ["project.setTrust", "project.close", "history.open"]

  function untrustedState(): KernelStateSnapshot {
    return { ...cleanState(), project: { phase: "ready", trust: "untrusted-read-only" } }
  }

  test("every kind except setTrust/close/history.open carries PROJECT_UNTRUSTED", () => {
    const state = untrustedState()
    for (const kind of COMMAND_KINDS_V1) {
      if (REMAINS_AVAILABLE.includes(kind)) continue
      const decision = evaluateCapabilityGuard(kind, representativeTarget(kind), state)
      expect(decision.available, `${kind} must be unavailable while untrusted`).toBe(false)
      if (decision.available) continue
      expect(
        decision.reasons.some((r) => r.code === "PROJECT_UNTRUSTED"),
        `${kind} while untrusted must carry PROJECT_UNTRUSTED`,
      ).toBe(true)
    }
  })

  test("project.setTrust and project.close never carry PROJECT_UNTRUSTED while untrusted", () => {
    const state = untrustedState()
    for (const kind of ["project.setTrust", "project.close"] as const) {
      const decision = evaluateCapabilityGuard(kind, representativeTarget(kind), state)
      if (decision.available) continue
      expect(decision.reasons.some((r) => r.code === "PROJECT_UNTRUSTED")).toBe(false)
    }
  })

  test("history.open never carries PROJECT_UNTRUSTED, though it stays unavailable (deferred) regardless", () => {
    const state = untrustedState()
    const decision = evaluateCapabilityGuard("history.open", representativeTarget("history.open"), state)
    expect(decision.available).toBe(false)
    if (decision.available) return
    expect(decision.reasons.some((r) => r.code === "PROJECT_UNTRUSTED")).toBe(false)
    expect(decision.reasons.some((r) => r.code === "CAPABILITY_UNAVAILABLE")).toBe(true)
  })
})

// --- §7.2 (lines 230-270): turn.start / TURN_ALREADY_ACTIVE -----------------------------

describe("§7.2 turn.start is rejected with TURN_ALREADY_ACTIVE in every non-idle state", () => {
  const NON_IDLE_PHASES: readonly KernelStateSnapshot["turn"]["phase"][] = [
    "admitting",
    "workspace-ready",
    "running",
    "stopping",
    "snapshotting",
    "validating",
    "finalizing",
    "committed",
    "terminalizing",
    "terminal",
    "backend-unhealthy",
  ]

  test("every non-idle TurnState phase rejects turn.start with TURN_ALREADY_ACTIVE and the active turnId", () => {
    const turnId = uuidv7()
    for (const phase of NON_IDLE_PHASES) {
      const state: KernelStateSnapshot = {
        ...cleanState(),
        turn: { phase, activeTurnId: turnId, commitIntentRecorded: false },
      }
      const decision = evaluateCapabilityGuard("turn.start", null, state)
      expect(decision.available, `turn.start at "${phase}" must be unavailable`).toBe(false)
      if (decision.available) continue
      expect(decision.reasons).toContainEqual({ code: "TURN_ALREADY_ACTIVE", turnId })
    }
  })

  test("turn.start is available while TurnState is idle (clean state)", () => {
    expect(evaluateCapabilityGuard("turn.start", null, cleanState())).toEqual({ available: true })
  })
})

// --- §7.2: turn.cancel's own matrix -----------------------------------------------------

describe("turn.cancel", () => {
  test("TURN_NOT_ACTIVE while idle", () => {
    const decision = evaluateCapabilityGuard("turn.cancel", { turnId: uuidv7() }, cleanState())
    expect(decision).toEqual({ available: false, reasons: [{ code: "TURN_NOT_ACTIVE" }] })
  })

  test("TURN_NOT_ACTIVE once the turn has reached committed/terminal/backend-unhealthy", () => {
    const turnId = uuidv7()
    for (const phase of ["committed", "terminal", "backend-unhealthy"] as const) {
      const state: KernelStateSnapshot = {
        ...cleanState(),
        turn: { phase, activeTurnId: turnId, commitIntentRecorded: false },
      }
      const decision = evaluateCapabilityGuard("turn.cancel", { turnId }, state)
      expect(decision.available, `cancel at "${phase}"`).toBe(false)
      if (decision.available) continue
      expect(decision.reasons.some((r) => r.code === "TURN_NOT_ACTIVE"), `cancel at "${phase}"`).toBe(true)
    }
  })

  test("TURN_ID_MISMATCH when the target names a different turn", () => {
    const activeTurnId = uuidv7()
    const state: KernelStateSnapshot = {
      ...cleanState(),
      turn: { phase: "running", activeTurnId, commitIntentRecorded: false },
    }
    const decision = evaluateCapabilityGuard("turn.cancel", { turnId: uuidv7() }, state)
    expect(decision).toEqual({ available: false, reasons: [{ code: "TURN_ID_MISMATCH", turnId: activeTurnId }] })
  })

  test("CANCEL_TOO_LATE in finalizing after durable commit intent", () => {
    const turnId = uuidv7()
    const state: KernelStateSnapshot = {
      ...cleanState(),
      turn: { phase: "finalizing", activeTurnId: turnId, commitIntentRecorded: true },
    }
    const decision = evaluateCapabilityGuard("turn.cancel", { turnId }, state)
    expect(decision).toEqual({ available: false, reasons: [{ code: "CANCEL_TOO_LATE", turnId }] })
  })

  test("available in finalizing before durable commit intent", () => {
    const turnId = uuidv7()
    const state: KernelStateSnapshot = {
      ...cleanState(),
      turn: { phase: "finalizing", activeTurnId: turnId, commitIntentRecorded: false },
    }
    expect(evaluateCapabilityGuard("turn.cancel", { turnId }, state)).toEqual({ available: true })
  })

  test("available for the exact active turn across every other active pre-intent phase", () => {
    const turnId = uuidv7()
    for (const phase of ["admitting", "workspace-ready", "running", "stopping", "snapshotting", "validating", "terminalizing"] as const) {
      const state: KernelStateSnapshot = {
        ...cleanState(),
        turn: { phase, activeTurnId: turnId, commitIntentRecorded: false },
      }
      expect(evaluateCapabilityGuard("turn.cancel", { turnId }, state), `cancel at "${phase}"`).toEqual({
        available: true,
      })
    }
  })

  test("turn.cancel is exempt from the MigrationState-idle requirement (the 'permissive' rule)", () => {
    const turnId = uuidv7()
    const state: KernelStateSnapshot = {
      ...cleanState(),
      turn: { phase: "running", activeTurnId: turnId, commitIntentRecorded: false },
      migration: { phase: "transforming" },
    }
    expect(evaluateCapabilityGuard("turn.cancel", { turnId }, state)).toEqual({ available: true })
  })
})

// --- §7.7 (lines 401-412): MigrationState === idle requirement --------------------------

describe("§7.7 ordinary project-mutation, turn, Restore, export, and commit guards require MigrationState === idle", () => {
  const REQUIRES_MIGRATION_IDLE: readonly CommandKindV1[] = [
    "page.renameTitle",
    "page.removePlan",
    "page.removeConfirm",
    "page.removeDiscardPlan",
    "page.reorder",
    "turn.start",
    "export.start",
  ]

  test("each of the listed kinds is unavailable while MigrationState is non-idle", () => {
    for (const phase of ["planning", "awaiting-confirmation", "backing-up", "transforming", "publishing", "recovering", "blocked"] as const) {
      const state: KernelStateSnapshot = { ...cleanState(), migration: { phase } }
      for (const kind of REQUIRES_MIGRATION_IDLE) {
        const decision = evaluateCapabilityGuard(kind, representativeTarget(kind), state)
        expect(decision.available, `${kind} while migration is "${phase}"`).toBe(false)
      }
    }
  })

  test("chat/model/selection/pin kinds are NOT subject to the migration-idle requirement", () => {
    const state: KernelStateSnapshot = { ...cleanState(), migration: { phase: "transforming" } }
    for (const kind of ["chat.create", "chat.switch", "model.select", "selection.set", "pin.create"] as const) {
      expect(evaluateCapabilityGuard(kind, representativeTarget(kind), state)).toEqual({ available: true })
    }
  })
})

// --- Family-specific phase legality -----------------------------------------------------

describe("project family phase legality", () => {
  test("project.create/open are legal only from closed", () => {
    for (const kind of ["project.create", "project.open"] as const) {
      expect(evaluateCapabilityGuard(kind, null, { ...cleanState(), project: { phase: "closed", trust: null } })).toEqual({
        available: true,
      })
      const decision = evaluateCapabilityGuard(kind, null, { ...cleanState(), project: { phase: "ready", trust: "trusted" } })
      expect(decision.available).toBe(false)
    }
  })

  test("project.retryOpen is legal only from blocked", () => {
    expect(
      evaluateCapabilityGuard("project.retryOpen", null, { ...cleanState(), project: { phase: "blocked", trust: null } }),
    ).toEqual({ available: true })
    const decision = evaluateCapabilityGuard("project.retryOpen", null, {
      ...cleanState(),
      project: { phase: "closed", trust: null },
    })
    expect(decision.available).toBe(false)
  })

  test("project.close is legal from ready or blocked", () => {
    expect(evaluateCapabilityGuard("project.close", null, cleanState())).toEqual({ available: true })
    expect(
      evaluateCapabilityGuard("project.close", null, { ...cleanState(), project: { phase: "blocked", trust: null } }),
    ).toEqual({ available: true })
    const decision = evaluateCapabilityGuard("project.close", null, {
      ...cleanState(),
      project: { phase: "closed", trust: null },
    })
    expect(decision.available).toBe(false)
  })
})

describe("export family phase legality — OPERATION_BUSY", () => {
  test("export.start is legal only from idle", () => {
    expect(evaluateCapabilityGuard("export.start", null, cleanState())).toEqual({ available: true })
    const decision = evaluateCapabilityGuard("export.start", null, { ...cleanState(), export: { phase: "rendering" } })
    expect(decision).toEqual({ available: false, reasons: [{ code: "OPERATION_BUSY" }] })
  })
})

describe("preview family phase legality", () => {
  test("preview.resize/queryGeometry require live, else OPERATION_BUSY", () => {
    const live = cleanState()
    expect(evaluateCapabilityGuard("preview.resize", { previewSessionId: uuidv7() }, live)).toEqual({ available: true })
    const notLive = { ...cleanState(), preview: { phase: "idle" as const, sourceKind: null } }
    expect(evaluateCapabilityGuard("preview.resize", { previewSessionId: uuidv7() }, notLive)).toEqual({
      available: false,
      reasons: [{ code: "OPERATION_BUSY" }],
    })
  })

  test("preview.retry requires circuit-open", () => {
    const circuitOpen = { ...cleanState(), preview: { phase: "circuit-open" as const, sourceKind: null } }
    expect(evaluateCapabilityGuard("preview.retry", { previewSessionId: uuidv7() }, circuitOpen)).toEqual({
      available: true,
    })
    expect(evaluateCapabilityGuard("preview.retry", { previewSessionId: uuidv7() }, cleanState())).toEqual({
      available: false,
      reasons: [{ code: "OPERATION_BUSY" }],
    })
  })

  test("preview.selectPage is legal exactly from idle/live/failed (§7.6's beginStart/beginSwitch sources)", () => {
    // §7.6's table: `beginStart` is idle/failed -> starting; `beginSwitch` is live/failed ->
    // switching. `starting`/`switching` are themselves mid-transition and not listed as a
    // source of either action, so selecting again while already selecting is illegal —
    // exactly what OPERATION_BUSY ("the relevant single-operation model is not idle") means.
    for (const phase of ["idle", "live", "failed"] as const) {
      const state = { ...cleanState(), preview: { phase, sourceKind: null } }
      expect(evaluateCapabilityGuard("preview.selectPage", { pageSlug: slug() }, state)).toEqual({ available: true })
    }
    for (const phase of ["starting", "switching", "disabled", "circuit-open"] as const) {
      const state = { ...cleanState(), preview: { phase, sourceKind: null } }
      expect(evaluateCapabilityGuard("preview.selectPage", { pageSlug: slug() }, state)).toEqual({
        available: false,
        reasons: [{ code: "OPERATION_BUSY" }],
      })
    }
  })

  test("§7.6 HISTORICAL_PREVIEW_READ_ONLY: preview.setMode(interactive) is blocked on a historical source", () => {
    const historical: KernelStateSnapshot = { ...cleanState(), preview: { phase: "live", sourceKind: "historical" } }
    const decision = evaluateCapabilityGuard("preview.setMode", { previewSessionId: uuidv7(), mode: "interactive" }, historical)
    expect(decision.available).toBe(false)
    if (decision.available) return
    expect(decision.reasons.some((r) => r.code === "HISTORICAL_PREVIEW_READ_ONLY")).toBe(true)
  })

  test("preview.setMode(static) remains available on a historical source", () => {
    const historical: KernelStateSnapshot = { ...cleanState(), preview: { phase: "live", sourceKind: "historical" } }
    expect(
      evaluateCapabilityGuard("preview.setMode", { previewSessionId: uuidv7(), mode: "static" }, historical),
    ).toEqual({ available: true })
  })

  test("preview.setMode(interactive) is available on the current (non-historical) source", () => {
    expect(
      evaluateCapabilityGuard("preview.setMode", { previewSessionId: uuidv7(), mode: "interactive" }, cleanState()),
    ).toEqual({ available: true })
  })
})

describe("migration family phase legality", () => {
  test("migration.confirm/discardPlan require awaiting-confirmation", () => {
    const awaiting: KernelStateSnapshot = { ...cleanState(), migration: { phase: "awaiting-confirmation" } }
    expect(evaluateCapabilityGuard("migration.confirm", { migrationPlanId: uuidv7() }, awaiting)).toEqual({
      available: true,
    })
    const decision = evaluateCapabilityGuard("migration.confirm", { migrationPlanId: uuidv7() }, cleanState())
    expect(decision).toEqual({ available: false, reasons: [{ code: "CAPABILITY_UNAVAILABLE" }] })
  })

  test("migration.retryRecovery requires blocked", () => {
    const blocked: KernelStateSnapshot = { ...cleanState(), migration: { phase: "blocked" } }
    expect(evaluateCapabilityGuard("migration.retryRecovery", { migrationActionId: uuidv7() }, blocked)).toEqual({
      available: true,
    })
    const decision = evaluateCapabilityGuard("migration.retryRecovery", { migrationActionId: uuidv7() }, cleanState())
    expect(decision).toEqual({ available: false, reasons: [{ code: "CAPABILITY_UNAVAILABLE" }] })
  })
})

// --- Deferred families layer additional reasons rather than replacing them --------------

describe("deferred families still layer TURN_RUNNING when applicable, alongside CAPABILITY_UNAVAILABLE", () => {
  test("restore.plan during a running turn carries both TURN_RUNNING and CAPABILITY_UNAVAILABLE", () => {
    const turnId = uuidv7()
    const state: KernelStateSnapshot = {
      ...cleanState(),
      turn: { phase: "running", activeTurnId: turnId, commitIntentRecorded: false },
    }
    const decision = evaluateCapabilityGuard("restore.plan", representativeTarget("restore.plan"), state)
    expect(decision.available).toBe(false)
    if (decision.available) return
    const codes: readonly string[] = decision.reasons.map((r) => r.code)
    expect(new Set(codes)).toEqual(new Set(["CAPABILITY_UNAVAILABLE", "TURN_RUNNING"]))
  })

  test("commit.plan during a running turn carries only CAPABILITY_UNAVAILABLE — commit is never TURN_RUNNING-locked", () => {
    const turnId = uuidv7()
    const state: KernelStateSnapshot = {
      ...cleanState(),
      turn: { phase: "running", activeTurnId: turnId, commitIntentRecorded: false },
    }
    const decision = evaluateCapabilityGuard("commit.plan", representativeTarget("commit.plan"), state)
    expect(decision).toEqual({ available: false, reasons: [{ code: "CAPABILITY_UNAVAILABLE" }] })
  })
})

// --- Regression tests for the adversarial review's findings --------------------------

describe("§11.1 HISTORICAL_PREVIEW_READ_ONLY — Send and pin mutation, not just Tweaks", () => {
  function historicalState(): KernelStateSnapshot {
    const state = cleanState()
    return { ...state, preview: { ...state.preview, phase: "live", sourceKind: "historical" } }
  }

  test("Send and pin mutation are blocked on a historical source", () => {
    // §11.1 names them verbatim: "Send, Tweaks, or pin mutation was requested on a
    // historical source." Only preview.setMode was implemented before; turn.start,
    // pin.create and pin.setStatus all reported available.
    for (const kind of ["turn.start", "pin.create", "pin.setStatus"] as const) {
      const decision = evaluateCapabilityGuard(kind, representativeTarget(kind), historicalState())
      expect(decision.available, `${kind}: must be unavailable on a historical source`).toBe(false)
      if (decision.available) continue
      const codes = decision.reasons.map((r) => r.code)
      expect(codes, `${kind}: missing HISTORICAL_PREVIEW_READ_ONLY`).toContain(
        "HISTORICAL_PREVIEW_READ_ONLY",
      )
    }
  })

  test("the same three are available when the source is current", () => {
    // The control half: proves the block is the SOURCE, not something else in the state.
    for (const kind of ["turn.start", "pin.create", "pin.setStatus"] as const) {
      const decision = evaluateCapabilityGuard(kind, representativeTarget(kind), cleanState())
      expect(decision.available, `${kind}: must be available on the current source`).toBe(true)
    }
  })
})

describe("reason priority — the orderings this slice's design depends on", () => {
  test("PROJECT_NOT_READY outranks PROJECT_UNTRUSTED", () => {
    // guards.ts layers both; §11.1's priority table decides the UI's primary hint, and
    // nothing else in this slice pins the order.
    const state = cleanState()
    const opening: KernelStateSnapshot = {
      ...state,
      project: { ...state.project, phase: "opening", trust: "untrusted-read-only" },
    }
    const decision = evaluateCapabilityGuard("page.renameTitle", representativeTarget("page.renameTitle"), opening)
    expect(decision.available).toBe(false)
    if (decision.available) return
    expect(primaryReason(decision.reasons).code).toBe("PROJECT_NOT_READY")
  })

  test("TURN_ALREADY_ACTIVE outranks TURN_RUNNING for turn.start", () => {
    // turn-lock.ts justifies excluding turn.start from the §10.4 matrix on exactly this
    // ordering ("the extra entry would be inert"), so the rationale needs an assertion.
    const state = cleanState()
    const running: KernelStateSnapshot = {
      ...state,
      turn: { ...state.turn, phase: "running", activeTurnId: uuidv7() },
    }
    const decision = evaluateCapabilityGuard("turn.start", null, running)
    expect(decision.available).toBe(false)
    if (decision.available) return
    expect(primaryReason(decision.reasons).code).toBe("TURN_ALREADY_ACTIVE")
  })
})

describe("reason de-duplication", () => {
  test("a deferred kind under a non-idle migration carries CAPABILITY_UNAVAILABLE exactly once", () => {
    // migrationNotIdleReason and deferredCapabilityReason both fall back to the same §11.1
    // code, so without dedupe the DTO would carry it twice — and duplicate codes flow
    // straight into kernel.capabilitiesChanged and its state comparison.
    const state = cleanState()
    const migrating: KernelStateSnapshot = {
      ...state,
      migration: { ...state.migration, phase: "transforming" },
    }
    const decision = evaluateCapabilityGuard("commit.plan", representativeTarget("commit.plan"), migrating)
    expect(decision.available).toBe(false)
    if (decision.available) return
    const occurrences = decision.reasons.filter((r) => r.code === "CAPABILITY_UNAVAILABLE").length
    expect(occurrences).toBe(1)
  })
})
