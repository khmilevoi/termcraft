import { wrap } from "@reatom/core";

import type { TransitionOutcome, TurnAction, TurnState } from "core/machines";
import type { EventCorrelationV1, PublishableEventV1 } from "core/mailbox";
import type { CommandPayloadByKindV1 } from "core/protocol";

import type { CommandOutcomeV1, FamilyHandlerMap, HandlerContext } from "./types";
import { completedOutcome, noOpOutcome, startedOutcome } from "./types";

/**
 * `turn.start` / `turn.cancel` — kernel-assembly WP-1 task 9, Step C2, the `turn` family.
 *
 * Both `.superpowers/sdd/task9-family-turn-report.md` (the original NEEDS_CONTEXT
 * investigation) and Step C1 (`.superpowers/sdd/task-9-report.md`, "## Step C1" / "C1 fix
 * round 2") are read in full before this file. Step C1 closed Gap 1 in full
 * (`context.turnRunner.machine` is the SAME full `StateMachine<TurnState, TurnAction>`
 * `kernel.ts` holds) and built Gap 2's storage (`context.turnRunner.setActiveAttempt` /
 * `activeAttempt`), but flagged that storage as having no legitimate populating caller yet.
 * This file (Step C2) re-verified that finding against the CURRENT source rather than
 * trusting it, and it is only PARTIALLY still true:
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
 *   `handle.requestCancel()` — which traces straight to `core/turns/model/attempt.ts`'s
 *   `AgentBackend.cancel(run)` once a real producer populates the slot (see below) — GENUINELY
 *   stopping the backend, never just the phase flip alone (Gap 2's whole point). Proven with a
 *   directly-injected fake `TurnCancelHandle` (`turn.test.ts`), independent of whether
 *   `turn.start` itself can populate the slot today.
 *
 * - `turn.start` stays the documented no-op it already was on the `notYetImplementedHandlers`
 *   stand-in (`./index.ts`) — composing `runTurn` (`core/turns`) end to end hits a NEW,
 *   independently-verified port-level gap this file calls Gap 3 (Gap 1/Gap 2 are the family
 *   report's own numbering; this is the next one Step C2's own investigation found, not
 *   previously named):
 *
 *   GAP 3 — no port exposes the frozen candidate's own file CONTENT, only its structural
 *   metadata. `RunTurnInputV1.buildValidationInput` (`core/turns/model/run-turn.ts:143`) must
 *   turn a `TurnCandidateV1` into `RunTurnValidationMaterialV1` (`run-turn.ts:117-120`:
 *   `manifestText: string`, `pages: TurnValidationPageInputV1[]` each carrying `source:
 *   string`) — RAW TEXT `GateRunner.runManifestSlice`/`runPage` need
 *   (`core/ports/gate-runner.ts:71-80`). `RunTurnInputV1.buildFinalizeInput`
 *   (`run-turn.ts:145-150`) has the identical need for the changed pages' own new byte
 *   content. But `TurnCandidateV1` (`core/turns/model/candidate.ts:58-64`) carries only
 *   `root`/`totalBytes`/`presentSlugs`/`changes` — hashes and sizes, never bytes (that file's
 *   own header: "the diff never touches content... no second full source snapshot merely for
 *   diffing") — and `StagingService` (`core/ports/staging.ts:92-99`) exposes exactly three
 *   methods (`createTurnWorkspace`/`snapshotToCandidate`/`retireWorkspace`), none of which
 *   reads a candidate file's content back by path. `ProjectStore.readManifest()`
 *   (`core/ports/project-store.ts:113`) is no substitute either: it returns the PARSED
 *   `ProjectManifestV1` DTO, not raw TOML/JSON text, and — separately — it describes the
 *   PROJECT's own manifest, not the turn's own `pages.json` MANIFEST SLICE the agent may have
 *   edited inside its candidate (`CreateTurnWorkspaceInputV1.manifestSlice`,
 *   `core/ports/staging.ts:64-65`, is synthesized FRESH per turn before admission — reading it
 *   back post-candidate, after the agent may have changed it, is exactly what is missing).
 *   There is no cast-free, non-fabricated way to close this from `core/kernel`: reading
 *   `candidate.root` off the filesystem directly would violate `core` importing nothing but
 *   `entities/`/its own `ports/` (`docs/architecture/code-structure.md` item 7,
 *   `closeout-global-constraints.md`'s own restatement); inventing placeholder text for Gate
 *   to validate would be exactly the "fabricated state" this project's rules forbid. Closing
 *   this needs a NEW `core/ports/staging.ts` method (e.g. `readCandidateFile(root, relPath):
 *   Promise<FailureDtoV1 | Uint8Array>`) — a landed module outside this task's authorized
 *   `types.ts`/`kernel.ts` file scope, so not built here; flagged forward exactly like the
 *   page/pin family's own surface-3 precedent (`task-9-report.md`, "## Step C1", §1).
 *
 *   TWO OTHER QUESTIONS THIS INVESTIGATION RESOLVED AS *NOT* BLOCKING, DOCUMENTED SO THE NEXT
 *   IMPLEMENTER DOES NOT RE-DERIVE THEM:
 *   - `AdmissionInputV1.targetChatId` and the agent's `backend`/`model`/`effort` triple: ALL
 *     FOUR are already durably readable via `context.deps.projectStore.readWorkspaceState()`
 *     (`WorkspaceStateV1.activeChatId`/`backend`/`model`/`effort`,
 *     `core/ports/project-store.ts:73-91` — `model.select`'s own `selectModel` is what
 *     persists the triple there, `core/chats/model/model-select.ts`), read ASYNCHRONOUSLY
 *     inside `launchOperation`'s own `run` closure — exactly `project.ts`'s own
 *     `runProjectReadySequence` precedent for the identical read. No new `HandlerContext`
 *     primitive is needed for this half.
 *   - `RunTurnDeps.publish` (`run-turn.ts:107-112`) is typed to carry only
 *     `turn.attemptStarted`/`turn.progress`/`turn.gateRejected` — excluding `turn.started` —
 *     and `HandlerContext.launchOperation` has no mid-flight, single-event publish primitive
 *     (only a terminal batch once `run()` resolves). This is real but NOT a hard blocker: a
 *     `run` closure can implement `publish` by ACCUMULATING these events in a local array and
 *     merging them into the final batch once `runTurn` settles, sharing one `stateRevision`
 *     bump with the terminal event — exactly the "several events legitimately carry the same
 *     `stateRevision`" case §4 already documents (`core/kernel/model/counters.ts`'s own header).
 *     The cost is real (progress arrives in one batch at completion instead of streamed live)
 *     and must stay documented wherever `turn.start` is actually implemented, but it needs no
 *     new primitive here either.
 *   - `context.selection()` (the §12.2 selection-capture primitive Step C1 added,
 *     `handlers/types.ts`): this is where `AdmissionInputV1.selection` (`core/turns/types.ts`)
 *     would come from once `turn.start`'s own composition resumes — read synchronously at
 *     admission time, matching `kernel-command-contract` §12.2's "captures ... authoritative
 *     selection" (never from the payload, which carries none). Named here, not silently
 *     forgotten, even though nothing calls it yet.
 *   - The recipe for closing Gap 2's remaining PRODUCER side once Gap 3 closes: `turn.start`'s
 *     own `launchOperation` closure would wrap the ONE `AgentBackend` instance it looks up via
 *     `context.deps.agentRegistry.get(backendId)` so its `startTurn` call captures the `AgentRun`
 *     `attempt.ts` creates per attempt, then calls
 *     `context.turnRunner.setActiveAttempt({ requestCancel: () => real.cancel(run) })` and
 *     clears it (`setActiveAttempt(null)`) once that attempt's own `run.outcome` settles — no
 *     `core/turns` file needs to change for this; the wrapping happens entirely on the
 *     `RunTurnDeps.agentBackend` seam `turn.start` already builds. Not built here since it has
 *     no real caller until Gap 3 closes (shipping it unused would itself be undocumented,
 *     untested surface) — recorded so the next implementer does not have to re-derive it.
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

// --- turn.start — documented no-op (Gap 3, this file's own header) ------------------------

/**
 * See this file's header, Gap 3: composing `runTurn` end to end needs a `core/ports` change
 * (`StagingService` cannot read a candidate file's own content back) outside this task's
 * authorized `types.ts`/`kernel.ts` scope. An untouched `idle` phase is always safe to leave
 * (mirrors `preview-export.ts`'s own `export.start` precedent for the identical shape of
 * gap) — this never begins the machine, never launches an operation, and never fabricates a
 * turnId/event for a turn that was never actually admitted.
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
