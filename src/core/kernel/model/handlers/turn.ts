import { wrap } from "@reatom/core";

import type { TransitionOutcome, TurnAction, TurnState } from "core/machines";
import type { EventCorrelationV1, PublishableEventV1 } from "core/mailbox";
import type { CommandPayloadByKindV1 } from "core/protocol";

import type { CommandOutcomeV1, FamilyHandlerMap, HandlerContext } from "./types";
import { completedOutcome, noOpOutcome, startedOutcome } from "./types";

/**
 * `turn.start` / `turn.cancel` — kernel-assembly WP-1 task 9, Step C2 (`turn.cancel`, real)
 * and Step C3 (this task: closes Gap 3, discovers Gap 4, builds the infrastructure Gap 4's
 * eventual closer needs).
 *
 * `.superpowers/sdd/task9-family-turn-report.md` (the original NEEDS_CONTEXT investigation),
 * Step C1, and Step C2 (`.superpowers/sdd/task-9-report.md`) are read in full before this
 * file. Step C1 closed Gap 1 in full (`context.turnRunner.machine` is the SAME full
 * `StateMachine<TurnState, TurnAction>` `kernel.ts` holds) and built Gap 2's storage
 * (`context.turnRunner.setActiveAttempt`/`activeAttempt`). Step C2 made `turn.cancel` real
 * end to end and found Gap 3 (below, now CLOSED). Step C3 closed Gap 3 at the ports layer,
 * built the two primitives Gap 3's closure and Gap 2's remaining producer side both need
 * (`StagingService.readCandidateFile`; `HandlerContext.publishOperationEvent`;
 * `RunTurnDeps.onAttemptStarted`), and — composing `runTurn`'s OTHER input,
 * `RunTurnInputV1.admission: AdmissionInputV1`, for real — found a FOURTH, previously
 * unflagged gap (Gap 4, below) that still blocks `turn.start` itself.
 *
 * - `turn.cancel` is real, end to end. §7.2's `requestCancel` edge is legal from EVERY
 *   cancelable phase (`core/machines/model/turn-machine.ts`'s own table, lines 136-147:
 *   `admitting`/`workspace-ready`/`snapshotting`/`validating`/`finalizing` ->
 *   `terminalizing`; `running` -> `stopping`; `stopping`/`terminalizing` -> themselves,
 *   `noOp: true`), so this handler ALWAYS applies it synchronously first — one uniform
 *   transition, never phase-specific branching at the machine level. It then asks
 *   `context.turnRunner.activeAttempt(payload.turnId)` for a live handle: `null` means every
 *   phase except `"running"` (no live `AgentBackend` process exists there — the transition
 *   above is already the complete, correct action, per the family report's own phase-by-phase
 *   read); non-null means a live run IS in flight, and this handler drives its OWN
 *   `handle.requestCancel()` — GENUINELY stopping the backend, never just the phase flip
 *   alone (Gap 2's whole point). Proven with a directly-injected fake `TurnCancelHandle`
 *   (`turn.test.ts`), independent of whether `turn.start` itself can populate the slot today.
 *
 * - `turn.start` stays the documented no-op it already was on the `notYetImplementedHandlers`
 *   stand-in (`./index.ts`, until Step C3 wired `turnHandlers` in for real — the MAP is now
 *   real, only `turn.start`'s OWN disposition is still a no-op). Composing `runTurn`
 *   (`core/turns`) end to end needed TWO things, in this order:
 *
 *   GAP 3 — CLOSED (Step C3). No port exposed the frozen candidate's own file CONTENT, only
 *   its structural metadata. `RunTurnInputV1.buildValidationInput`/`buildFinalizeInput`
 *   (`core/turns/model/run-turn.ts:143`/`:145-150`) both need RAW TEXT/byte content off a
 *   frozen `TurnCandidateV1`, but that type (`core/turns/model/candidate.ts:58-64`) carries
 *   only hash/size ("the diff never touches content"). Closed by
 *   `StagingService.readCandidateFile(root, relPath): Promise<FailureDtoV1 | Uint8Array>`
 *   (`core/ports/staging.ts`, Step C3's own commit) — port + fake only, the real adapter is
 *   WP-2's job, matching the page/pin family's own surface-3 precedent
 *   (`task-9-report.md`, "## Step C1", §1). `buildValidationInput`/`buildFinalizeInput`
 *   themselves are now straightforward to write (read `candidate.root` + each relevant
 *   `StagedFileV1.relPath` back through this method, decode UTF-8 for Gate's `manifestText`/
 *   `source`, keep raw bytes for finalize's `ChangedPageOpV1.newBytes`) — NOT the reason
 *   `turn.start` is still blocked; see Gap 4.
 *
 *   GAP 4 — NEW, BLOCKS `turn.start` TODAY (Step C3's own finding, discovered while
 *   composing `RunTurnInputV1.admission` for real, not merely assumed solvable because Gap 3
 *   closed). `AdmissionInputV1.workspace.readSet` (`core/turns/types.ts`'s
 *   `AdmissionWorkspaceMaterialV1.readSet: StagedTurnReadSetV1`, `core/ports/staging.ts:50-58`)
 *   is the send-time CAS baseline `runAdmission` durably persists and `finalizeTurn`
 *   re-checks before ever committing a write (turn-durability §7.5) — REQUIRED fields:
 *   `manifest: ReadSetFileSnapshotV1 | null` (`project.toml`'s own hash+size) and
 *   `chat: AppendBaseV1` (`{length, prefixSha256}`, NOT nullable). Verified there is no
 *   `core/ports` surface that can honestly produce either today: `ProjectStore.readManifest()`
 *   (`core/ports/project-store.ts:113`) returns the PARSED `ProjectManifestV1` DTO, never
 *   raw bytes/hash; `ChatReader`/`ChatMutations` (`core/ports/chat-store.ts`) expose record
 *   loading/creation only, never a raw append-base (byte length + prefix hash) read — no
 *   method on either port, or anywhere else in `KernelDeps`, can build one. `canonicalPages`
 *   entries ARE buildable (each one's `sha256`/`size` come straight from the SAME
 *   `PageReader.readSource()` call this handler already needs for `pages: StagingPageSourceV1[]`
 *   — see the recipe below), and `pins: []` is honest when `candidatePins` is genuinely empty
 *   (see the recipe's own note on that) — but `chat`'s REQUIRED, non-nullable shape has no
 *   honest fallback: fabricating `{length: 0, prefixSha256: "0".repeat(64)}` (or any other
 *   placeholder) would feed `turnTransactions.finalize`'s own real CAS check a FALSE baseline
 *   — exactly the class of bug the read-set exists to PREVENT (a concurrent chat mutation
 *   silently overwritten), not a merely-incomplete DTO. This is squarely the "fabricated
 *   state" this project's rules forbid, so it is not built here. Closing this needs a NEW
 *   `core/ports` primitive (e.g. a raw chat append-base read on `ChatReader`, and/or a raw
 *   manifest-bytes read on `ProjectStore`) — outside Step C3's authorized `core/ports/
 *   staging.ts`-only extension, so flagged forward exactly like Gap 3 was, not improvised
 *   around. Until it closes, `turn.start` cannot honestly build `AdmissionInputV1` at all, so
 *   it stays the sanctioned no-op (mirrors `preview-export.ts`'s own `export.start`
 *   precedent for the identical shape of gap).
 *
 *   THE RECIPE FOR `turn.start`, ONCE GAP 4 CLOSES (recorded so the next implementer does not
 *   re-derive any of this):
 *   - `AdmissionInputV1.targetChatId` and the agent's `backend`/`model`/`effort` triple: ALL
 *     FOUR are already durably readable via `context.deps.projectStore.readWorkspaceState()`
 *     (`WorkspaceStateV1.activeChatId`/`backend`/`model`/`effort`,
 *     `core/ports/project-store.ts:73-91`), read ASYNCHRONOUSLY inside `launchOperation`'s
 *     own `run` closure — exactly `project.ts`'s own `runProjectReadySequence` precedent. A
 *     `null` backend/model/effort/activeChatId is an IDEMPOTENT REFUSAL (nothing has been
 *     selected/no chat exists yet), logged and resolved with `[]`, never a fabricated
 *     default.
 *   - `pages: StagingPageSourceV1[]` (`CreateTurnWorkspaceInputV1`): one entry per
 *     `context.deps.pageReader.listSlugs()` result, `sourcePath` built from
 *     `` `${context.deps.projectStore.root}/pages/${pageSlug}.tsx` `` — the canonical
 *     page-file layout convention `core/turns/model/candidate.ts`'s own `PAGE_FILE_PATTERN`
 *     already documents ("the real staging store's own page-file convention"), never a
 *     fabricated path.
 *   - `manifestSlice: Uint8Array` (`pages.json`'s own bytes): `JSON.stringify({pages:
 *     <the SAME listSlugs() result>, active: <workspaceState.activePageSlug>})`, UTF-8
 *     encoded — the exact `ManifestSliceV1` shape (`core/ports/gate-runner.ts`) `pages.json`
 *     already carries.
 *   - `runtimeDocs: []` — no port anywhere in `KernelDeps` sources a `RUNTIME.md`/runtime
 *     type-declaration file's content for `core` to stage; a real, but SEPARATE, documented
 *     gap from Gap 4 (mirrors `kernel.ts`'s own `PLACEHOLDER_GIT_STATUS` precedent for "a
 *     real value would need a port that does not exist yet").
 *   - `candidatePins: []` — nothing on `HandlerContext`/`KernelDeps` tracks "which pins the
 *     composer currently shows as open" (the UI-side fact `AdmissionCandidatePinV1` needs);
 *     an empty list is the honest value when that fact is genuinely unknown at this layer,
 *     not a fabrication — it simply means this turn captures no pins, exactly like a
 *     turn genuinely sent with none open would. Flagged, not silently guessed.
 *   - `context.selection()` (the §12.2 selection-capture primitive Step C1 added): read
 *     synchronously at admission time for `AdmissionInputV1.selection`, matching
 *     kernel-command-contract §12.2's "captures ... authoritative selection" (never from the
 *     payload, which carries none).
 *   - LIVE EVENTS: `RunTurnDeps.publish` maps directly onto `context.publishOperationEvent`
 *     (Step C3's own live-publish primitive, `./types.ts`) — `turn.attemptStarted`/
 *     `turn.progress`/`turn.gateRejected` stream AS THEY HAPPEN, never batched. The very
 *     FIRST `turn.attemptStarted` this callback observes is also where `context.
 *     setActiveTurnId(event.payload.turnId)` belongs — admission itself never surfaces a
 *     `turnId` to this driver's own caller (it is minted INSIDE `runAdmission`), but attempt
 *     1 always starts immediately after a successful admission, so the FIRST
 *     `turn.attemptStarted` IS "admission just succeeded, with this turnId" for this
 *     purpose. `setActiveTurnId(null)` belongs at the very end, once `runTurn`'s own result
 *     is `terminalized`/`finalized` (never on `admission-rejected` — nothing was ever set).
 *   - THE ATTEMPT-HANDLE SLOT: `RunTurnDeps.onAttemptStarted` (Step C3's own additive
 *     `core/turns` hook, `run-turn.ts`) maps directly onto
 *     `context.turnRunner.setActiveAttempt` — call it with the REAL handle
 *     `onAttemptStarted` hands over (never a separately hand-wrapped
 *     `{requestCancel: () => real.cancel(run)}` — see the next paragraph for exactly why),
 *     and with `null` when `onAttemptStarted` fires again. This closes Gap 2's remaining
 *     producer side for real: `turn.cancel`'s own `handle.requestCancel()` (`./turn.ts`,
 *     below) then reaches the SAME `attempt.ts`-coordinated cancel path `startTurnAttempt`
 *     itself returns.
 *   - THE beginStopping-ILLEGAL RECONCILIATION (also-fix E-iv, addressed BY THIS DESIGN, not
 *     by suppression): an earlier envisioned recipe had `turn.start` wrap the raw
 *     `AgentBackend.cancel(run)` port call directly into a FRESH `TurnCancelHandle` object,
 *     bypassing `attempt.ts`'s own `cancelRequested` flag entirely. Under that design, a
 *     `turn.cancel` during `"running"` would (a) apply `requestCancel` on the machine
 *     directly (this handler's own first line, unconditional), moving it to `"stopping"`,
 *     THEN (b) call the raw-wrapped handle, which never sets `attempt.ts`'s own
 *     `cancelRequested` — so when the attempt's outcome later resolves,
 *     `attempt.ts`'s `finalizeOutcome` sees `cancelRequested === false` and tries
 *     `beginStopping` AGAIN from a machine already in `"stopping"` — illegal, a spurious
 *     warning. Registering `onAttemptStarted`'s own REAL handle instead (this recipe) fixes
 *     it at the ROOT: `handle.requestCancel()` (this handler's SECOND action, inside
 *     `launchOperation`) is `attempt.ts`'s own wrapped function, which sets
 *     `cancelRequested = true` itself before re-applying `requestCancel` on the machine —
 *     legal there too (the machine is already `"stopping"`, and `stopping -> stopping` is a
 *     `noOp: true` edge, per this file's own transition-table citation above) — so
 *     `finalizeOutcome` never re-attempts `beginStopping` at all. Proven directly:
 *     `run-turn.test.ts`'s own "the handle passed genuinely drives the real cancel path"
 *     test (Step C3) exercises exactly this handle end to end.
 *
 * HARD RULES OBSERVED: no cast anywhere; `wrap()` at the one async boundary inside
 * `turn.cancel`'s `launchOperation` closure; no module-level mutable state (every fact this
 * file reads/writes lives on `context`); `turn.cancel` composes `context.machines.turn`/
 * `context.turnRunner` verbatim, never a private re-implementation of the turn machine's own
 * transition table.
 */

// --- Shared: `kernel.stateChanged` construction for a real turn-machine transition ---------

function turnStateChangedEvent(
  action: `kernel.turn.${TurnAction}`,
  outcome: Extract<TransitionOutcome<TurnState, TurnAction>, { kind: "changed" }>,
  correlation: EventCorrelationV1,
): PublishableEventV1<"kernel.stateChanged"> {
  return {
    kind: "kernel.stateChanged",
    payload: {
      modelId: "kernel.turn.state",
      action,
      previousTag: outcome.from,
      nextTag: outcome.to,
      metadata: {},
    },
    correlation,
  };
}

// --- turn.start — documented no-op (Gap 4, this file's own header) ------------------------

/**
 * See this file's header, Gap 4: Gap 3 is closed (`StagingService.readCandidateFile` exists),
 * but composing `RunTurnInputV1.admission` needs a send-time read-set CAS baseline
 * (`AdmissionInputV1.workspace.readSet.chat`/`.manifest`) no `core/ports` surface can
 * honestly produce today — a genuinely new blocker, not the one this task closed. An
 * untouched `idle` phase is always safe to leave (mirrors `preview-export.ts`'s own
 * `export.start` precedent for the identical shape of gap) — this never begins the machine,
 * never launches an operation, and never fabricates a turnId/event for a turn that was never
 * actually admitted.
 */
function handleTurnStart(): CommandOutcomeV1 {
  return noOpOutcome();
}

// --- turn.cancel — real, end to end -------------------------------------------------------

/**
 * Always applies `requestCancel` first — legal from every cancelable phase the guard
 * (`capabilities/model/guards.ts`'s `turnCancelReason`) already let through, per
 * `turn-machine.ts`'s own table (this file's header). Then branches ONLY on whether a live
 * `AgentBackend` run is currently registered (`context.turnRunner.activeAttempt`):
 * - `null` — no live process (every phase except a currently-attempting `"running"`); the
 *   transition above is already the complete, correct action.
 * - non-null — a live run IS in flight; this genuinely stops it via the registered handle's
 *   own `requestCancel()`, inside `launchOperation` (the one sanctioned async boundary),
 *   never a second, competing terminal event — the real `turn.cancelled`/`turn.failed` is
 *   published by the STILL-RUNNING `turn.start` operation's own completion once its composed
 *   `runTurn` observes the confirmed cancellation.
 */
function handleTurnCancel(
  payload: CommandPayloadByKindV1["turn.cancel"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const applied = context.machines.turn.apply("requestCancel");

  if (applied.kind === "illegal") {
    // Defensive only — `turnCancelReason` already confirmed phase legality and turnId match
    // before dispatch ever reached this handler; unreachable in a correctly-wired Kernel,
    // kept explicit per this project's "never silently assume success" rule (mirrors
    // `project.ts`'s identical defensive posture for its own `tryApply` calls).
    console.warn(
      `core/kernel/handlers/turn: turn.cancel's requestCancel was illegal despite the guard confirming legality (turnId ${payload.turnId})`,
    );
    return noOpOutcome();
  }

  if (applied.kind === "no-op") {
    // §8.4 point 4 / turn-machine.ts's own noOp edges: a repeated cancel while already
    // "stopping" or "terminalizing" is an accepted no-op, not a failure — nothing further to
    // do, and nothing changed to report.
    return noOpOutcome();
  }

  const admissionEvent = turnStateChangedEvent("kernel.turn.requestCancel", applied, {
    turnId: payload.turnId,
  });

  const handle = context.turnRunner.activeAttempt(payload.turnId);
  if (handle === null) {
    return completedOutcome([admissionEvent]);
  }

  context.launchOperation("kernel.turn.cancel", async () => {
    await wrap(handle.requestCancel());
    // No event of its own: see this function's own doc comment above.
    return [];
  });

  return startedOutcome([admissionEvent]);
}

// --- The family map -------------------------------------------------------------------------

export const turnHandlers: FamilyHandlerMap<"turn"> = {
  "turn.start": handleTurnStart,
  "turn.cancel": handleTurnCancel,
};
