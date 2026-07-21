import { describe, expect, test } from "bun:test"
import { context, wrap } from "@reatom/core"

import type { Clock } from "infrastructure/clock"
import { parsePageSlug, type PageSlug } from "entities/page"
import { isUuidv7, type FailureDtoV1 } from "core/protocol"
import { reatomTurnStateMachine } from "core/machines"
import { createFakePinStore, createFakeStagingService, createFakeTurnTransactionService } from "core/ports/fakes"
import type { StagedTurnReadSetV1 } from "core/ports"

import type { AdmissionInputV1 } from "../types"
import { ReadSetTranslationError } from "./read-set"
import { type AdmissionDeps, runAdmission } from "./admission"

/**
 * `runAdmission` end to end against 6D's fakes only — no real process, no real disk, no
 * real clock. ORDER IS THE CONTRACT: every precondition test asserts the run stops exactly
 * where it should and that a LATER port is never even attempted (matching
 * `open-sequence.test.ts`'s own style for the identical reason).
 *
 * Every test body lives inside ONE `context.start(async () => {...})` call, and
 * `runAdmission(...)`'s own call is `await wrap(...)`-ed — the same reatom binding-rule
 * reason `open-sequence.test.ts`'s header documents: a plain unwrapped `await` here would
 * resume outside the context that `reatomTurnStateMachine()`'s atoms were created in.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

const PAGE_HOME = slug("home")
const PAGE_GONE = slug("gone")

const T0 = 1_700_000_000_000

function manualClock(startMs: number): Clock {
  return { now: () => new Date(startMs) }
}

const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "boom", details: {} }

function baseReadSet(): StagedTurnReadSetV1 {
  return {
    manifest: { sha256: "a".repeat(64), size: 10 },
    canonicalPages: [{ pageSlug: PAGE_HOME, snapshot: { sha256: "b".repeat(64), size: 20 } }],
    chat: { length: 100, prefixSha256: "c".repeat(64) },
    pins: [{ pageSlug: PAGE_HOME, base: { length: 5, prefixSha256: "d".repeat(64) } }],
  }
}

function baseInput(overrides: Partial<AdmissionInputV1> = {}): AdmissionInputV1 {
  return {
    targetChatId: "chat-1",
    text: "hello",
    candidatePins: [],
    workspace: {
      pages: [{ pageSlug: PAGE_HOME, sourcePath: "/fake/home.tsx" }],
      manifestSlice: new TextEncoder().encode("[]"),
      runtimeDocs: [],
      readSet: baseReadSet(),
    },
    ...overrides,
  }
}

/** Fresh fakes + a fresh turn machine per test — never shared across tests. */
function harness(clock: Clock = manualClock(T0)) {
  const machine = reatomTurnStateMachine()
  const pinReader = createFakePinStore()
  const turnTransactions = createFakeTurnTransactionService()
  const staging = createFakeStagingService()
  const deps: AdmissionDeps = { machine, clock, pinReader, turnTransactions, staging }
  return { deps, machine, pinReader, turnTransactions, staging }
}

describe("runAdmission — idle -> admitting -> workspace-ready", () => {
  test("beginAdmission illegal from a non-idle phase: returns illegal, mints nothing, calls nothing", async () => {
    await context.start(async () => {
      const h = harness()
      h.machine.apply("beginAdmission") // already "admitting" before this run starts

      const outcome = await wrap(runAdmission(h.deps, baseInput()))

      expect(outcome).toEqual({ kind: "illegal", code: "TURN_ALREADY_ACTIVE" })
      expect(h.turnTransactions.calls).toEqual([])
      expect(h.staging.calls).toEqual([])
      expect(h.pinReader.calls).toEqual([])
    })
  })

  test("the happy path mints a UUIDv7 turnId, captures chat/selection, commits BEFORE creating the workspace, and reaches workspace-ready", async () => {
    await context.start(async () => {
      const h = harness()
      const selection = { pageSlug: PAGE_HOME, element: "btn-1" }

      const input = baseInput({ selection })
      const outcome = await wrap(runAdmission(h.deps, input))
      if (outcome.kind !== "workspace-ready") throw new Error(`expected workspace-ready, got ${outcome.kind}`)

      expect(isUuidv7(outcome.context.turnId)).toBe(true)
      expect(outcome.context.targetChatId).toBe("chat-1")
      expect(outcome.context.userRecord.turnId).toBe(outcome.context.turnId)
      expect(outcome.context.userRecord.selection).toEqual(selection)
      expect(outcome.context.userRecord.text).toBe("hello")

      // Order: admit committed BEFORE the workspace was created.
      expect(h.turnTransactions.calls.length).toBe(1)
      expect(h.turnTransactions.calls[0]).toMatchObject({
        method: "admit",
        input: { turnId: outcome.context.turnId, targetChatId: "chat-1" },
      })
      // The record the PORT received, not merely the in-memory echo the caller got back.
      // Asserting only outcome.context.userRecord leaves the durable side unprotected:
      // stripping text/selection/pins from the record handed to admit passes otherwise, and
      // TD §7.2 step 3 is explicit that this record must "commit it fully".
      const admitCall = h.turnTransactions.calls[0]
      if (admitCall?.method !== "admit") throw new Error("expected an admit call")
      expect(admitCall.input.userRecord).toEqual(outcome.context.userRecord)

      expect(h.staging.calls.length).toBe(1)
      const stagingCall = h.staging.calls[0]
      if (stagingCall?.method !== "createTurnWorkspace") throw new Error("expected createTurnWorkspace")
      // TD §7.2 step 4: "copy EVERY listed canonical page.tsx, the manifest slice, RUNTIME.md,
      // and runtime type declarations" — asserting only the method name would let admission
      // stage an entirely empty workspace and launch the agent against no design sources.
      expect(stagingCall.input.pages).toEqual(input.workspace.pages)
      expect(stagingCall.input.manifestSlice).toEqual(input.workspace.manifestSlice)
      expect(stagingCall.input.runtimeDocs).toEqual(input.workspace.runtimeDocs)

      // The CAS basis carried forward is a faithful translation of the staged read set —
      // a dropped entry here silently weakens the pre-intent comparison (read-set.ts's header).
      expect(outcome.context.readSet.chat).toEqual(baseReadSet().chat)
      expect(outcome.context.readSet.pins.get(PAGE_HOME)).toEqual(baseReadSet().pins[0]?.base)

      expect(h.machine.phase()).toBe("workspace-ready")
      // The fence is minted, but attempt 1 is never begun here.
      expect(outcome.context.fence.currentLease()).toBeNull()
      expect(typeof outcome.context.admissionCommit.transactionId).toBe("string")
    })
  })

  test("createdAt/ts come from the injected clock, never wall time", async () => {
    await context.start(async () => {
      const h = harness(manualClock(T0))
      const outcome = await wrap(runAdmission(h.deps, baseInput()))
      if (outcome.kind !== "workspace-ready") throw new Error(`expected workspace-ready, got ${outcome.kind}`)

      const expectedTs = new Date(T0).toISOString()
      expect(outcome.context.userRecord.ts).toBe(expectedTs)
      expect(h.turnTransactions.calls[0]).toMatchObject({ input: { createdAt: expectedTs } })
    })
  })

  test("no selection and no captured pins: both optional fields are OMITTED, not present as empty/null", async () => {
    await context.start(async () => {
      const h = harness()
      const outcome = await wrap(runAdmission(h.deps, baseInput()))
      if (outcome.kind !== "workspace-ready") throw new Error(`expected workspace-ready, got ${outcome.kind}`)

      expect(outcome.context.userRecord.selection).toBeUndefined()
      expect(outcome.context.userRecord.pins).toBeUndefined()
    })
  })

  test("committed user-record precondition: admit failure blocks phase 'admit'; workspace is NEVER attempted; machine stays admitting", async () => {
    await context.start(async () => {
      const h = harness()
      h.turnTransactions.failNext("admit", FAILURE)

      const outcome = await wrap(runAdmission(h.deps, baseInput()))

      expect(outcome).toEqual({ kind: "blocked", phase: "admit", failure: FAILURE })
      expect(h.staging.calls).toEqual([])
      expect(h.machine.phase()).toBe("admitting")
    })
  })

  test("verified-workspace precondition: workspace failure blocks phase 'workspace' AFTER admission already committed; machine stays admitting", async () => {
    await context.start(async () => {
      const h = harness()
      h.staging.failNext("createTurnWorkspace", FAILURE)

      const outcome = await wrap(runAdmission(h.deps, baseInput()))

      expect(outcome).toEqual({ kind: "blocked", phase: "workspace", failure: FAILURE })
      expect(h.turnTransactions.calls.length).toBe(1)
      expect(h.turnTransactions.calls[0]?.method).toBe("admit")
      expect(h.machine.phase()).toBe("admitting")
    })
  })

  test("complete-read-set-hashes precondition: a duplicate page slug blocks phase 'read-set' AFTER both admit and workspace succeeded; machine stays admitting", async () => {
    await context.start(async () => {
      const h = harness()
      const duplicatedReadSet: StagedTurnReadSetV1 = {
        ...baseReadSet(),
        canonicalPages: [
          { pageSlug: PAGE_HOME, snapshot: { sha256: "b".repeat(64), size: 20 } },
          { pageSlug: PAGE_HOME, snapshot: { sha256: "e".repeat(64), size: 30 } },
        ],
      }
      const input = baseInput({ workspace: { ...baseInput().workspace, readSet: duplicatedReadSet } })

      const outcome = await wrap(runAdmission(h.deps, input))

      if (outcome.kind !== "blocked" || outcome.phase !== "read-set") {
        throw new Error(`expected blocked/read-set, got ${JSON.stringify(outcome)}`)
      }
      expect(outcome.error).toBeInstanceOf(ReadSetTranslationError)
      expect(h.turnTransactions.calls.length).toBe(1)
      expect(h.staging.calls.length).toBe(1)
      expect(h.machine.phase()).toBe("admitting")
    })
  })

  test("an unresolvable candidate pin is simply absent from the captured set — never written, never fatal", async () => {
    await context.start(async () => {
      const h = harness()
      // Seed page "home" with one open pin and one already-resolved pin.
      await h.pinReader.appendStandaloneEvent(PAGE_HOME, {
        kind: "pin:created",
        recordId: "rec-1",
        pinId: "pin-open",
        element: "el-1",
        fx: 0.1,
        fy: 0.2,
        text: "note",
        ts: new Date(T0).toISOString(),
      })
      await h.pinReader.appendStandaloneEvent(PAGE_HOME, {
        kind: "pin:created",
        recordId: "rec-2",
        pinId: "pin-resolved",
        element: "el-2",
        fx: 0.3,
        fy: 0.4,
        text: "note",
        ts: new Date(T0).toISOString(),
      })
      await h.pinReader.appendStandaloneEvent(PAGE_HOME, {
        kind: "pin:status",
        recordId: "rec-3",
        pinId: "pin-resolved",
        status: "resolved",
        turnId: "some-other-turn",
        ts: new Date(T0).toISOString(),
      })
      // Page "gone" will have its fold FAIL entirely — its candidate must still be dropped,
      // never propagated as an admission failure.
      h.pinReader.failNext("fold", FAILURE)

      const input = baseInput({
        candidatePins: [
          // "gone" listed FIRST so it is the first distinct page folded, consuming the
          // injected failure — "home"'s fold below runs the real, successful fold.
          { pageSlug: PAGE_GONE, pinId: "pin-x" },
          { pageSlug: PAGE_HOME, pinId: "pin-open" },
          { pageSlug: PAGE_HOME, pinId: "pin-resolved" },
          { pageSlug: PAGE_HOME, pinId: "pin-missing" },
        ],
      })

      const outcome = await wrap(runAdmission(h.deps, input))
      if (outcome.kind !== "workspace-ready") throw new Error(`expected workspace-ready, got ${JSON.stringify(outcome)}`)

      // Only the legitimately open pin survives. Nothing about the other three candidates
      // was captured or written anywhere.
      expect(outcome.context.userRecord.pins).toEqual(["pin-open"])
      // Exactly one fold call per DISTINCT page, regardless of how many candidates named it.
      expect(h.pinReader.calls.filter((call) => call.method === "fold").length).toBe(2)
    })
  })
})
