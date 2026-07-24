import { wrap } from "@reatom/core";

import type {
  StateMachine,
  TurnAction,
  TurnAttempt,
  TurnState,
  TurnTerminalOutcome,
} from "core/machines";
import type { PublishableEventV1 } from "core/mailbox";
import type {
  AgentBackend,
  AgentTask,
  GateRunner,
  PinReader,
  StagingService,
  TurnTransactionService,
} from "core/ports";
import type { Clock } from "infrastructure/clock";

import type { AdmissionInputV1, AdmissionOutcomeV1 } from "../types";
import { type AdmissionDeps, runAdmission } from "./admission";
import { type TurnAttemptDeps, type TurnAttemptOutcomeV1, startTurnAttempt } from "./attempt";
import {
  type FreezeTurnCandidateDeps,
  type TurnCandidateV1,
  freezeTurnCandidate,
} from "./candidate";
import type { TurnDeadlines } from "./deadlines";
import { MAX_TURN_ATTEMPTS } from "./fence";
import {
  type FinalizeTurnDeps,
  type FinalizeTurnInputV1,
  type FinalizeTurnResultV1,
  finalizeTurn,
} from "./finalize";
import {
  type TurnGateFoldInputV1,
  appendPromptFold,
  foldGateDiagnosticsIntoPrompt,
} from "./prompt";
import {
  type TerminalizeTurnDeps,
  type TerminalizeTurnResultV1,
  terminalizeTurn,
} from "./terminalize";
import {
  type TurnValidationDeps,
  type TurnValidationPageInputV1,
  type TurnValidationResultV1,
  runTurnValidation,
} from "./validation";

/**
 * `runTurn` — the composed turn driver (kernel-command-contract §7.2's full arc; this
 * slice's own plan, task 6/B2): admission -> the attempt/freeze/validate retry loop (up to
 * `MAX_TURN_ATTEMPTS`) -> `finalizeTurn` on a passing candidate.
 *
 * PURE COMPOSITION: every state read or transition below either (a) happens INSIDE one of
 * the six landed functions this file only calls (`runAdmission`, `startTurnAttempt`,
 * `freezeTurnCandidate`, `runTurnValidation`, `finalizeTurn`, `terminalizeTurn`), or (b) is
 * one of the few phase-bridging edges those files' own headers document as belonging to
 * "whichever caller decided" — `beginSnapshot` after a completed attempt (`attempt.ts`'s own
 * header), and `beginTerminalization`/`requestCancel` before a `terminalizeTurn` call
 * (`terminalize.ts`'s own header lists exactly these three routes into `terminalizing`).
 * This file drives no OTHER transition and never inspects `machine.phase()` to make a
 * business decision — every branch below decides on a typed result one of the six functions
 * already returned.
 *
 * THE BRIDGE HELPER: `bridge(action)` applies exactly one of those three sanctioned
 * transitions and warns (never throws, never silently drops) if the phase table rejects it
 * — matching `attempt.ts`'s own `console.warn`-on-illegal pattern for its internal
 * `beginStopping`/`requestCancel` calls. In every reachable call site below the transition
 * is legal by construction (proven per call site in this file's own review); the warning
 * exists only so a violated invariant is visible rather than silently absorbed, and
 * `terminalizeTurn`'s own `illegal` check remains the final safety net either way.
 *
 * BACKEND-UNHEALTHY DIVERGENCE (documented, not silently reproduced — CLAUDE.md "Design is a
 * source of truth" applies the identical discipline to behavior, not only visuals): §7.2's
 * table sends an unconfirmed process-tree exit to its own `backend-unhealthy` phase —
 * workspace quarantine, no new turn until a full health check clears it — never through
 * `terminalizing`/`terminal`. That supervisor-level quarantine path is out of this task's
 * six-function scope (the plan's 6F description still lists "the `backend-unhealthy` path
 * and workspace quarantine" as separate, not-yet-composed work). Rather than leave a turn
 * stuck outside `terminal` with no typed result at all, this driver folds an
 * attempt-outcome `"backend-unhealthy"` into an ordinary terminal `failed` record. A later
 * work package that composes the real quarantine/health-check supervisor should replace this
 * branch, not extend it.
 *
 * FINALIZE FAILURES STAY OUT OF SCOPE HERE TOO: `finalize.ts`'s own header marks the
 * `finalizing -> terminalizing` edge on a CAS-mismatch/deadline-exceeded failure "deliberately
 * NOT driven here... reached by a caller this function does not own" — this driver is not
 * that caller either (the brief's own step 3 is "`finalizeTurn` -> return
 * `committed`/`failed`", nothing more), so a finalize failure is returned as-is, not chained
 * into `terminalizeTurn`.
 */

export interface RunTurnDeps {
  readonly machine: StateMachine<TurnState, TurnAction>;
  readonly clock: Clock;
  readonly pinReader: PinReader;
  readonly turnTransactions: TurnTransactionService;
  readonly staging: StagingService;
  readonly agentBackend: AgentBackend;
  readonly gateRunner: GateRunner;
  readonly deadlines: TurnDeadlines;
  readonly publish: (
    event:
      | PublishableEventV1<"turn.attemptStarted">
      | PublishableEventV1<"turn.progress">
      | PublishableEventV1<"turn.gateRejected">,
  ) => void;
  readonly foldGateDiagnosticsIntoPrompt: typeof foldGateDiagnosticsIntoPrompt;
  /**
   * Optional, additive hook (kernel-assembly Task 9, Step C3) closing the turn family's own
   * remaining "Gap 2 producer side" gap (`.superpowers/sdd/task-9-report.md`, "Step C2
   * turn" / "C1 fix round 2"): composing this monolithic driver never used to surface a live
   * attempt's own cancel handle to ITS caller (`RunTurnResultV1`'s three members carry no
   * handle, and `startTurnAttempt`'s own `TurnAttemptHandle` is consumed entirely inside this
   * file's own loop). Called with the live handle the MOMENT an attempt starts (right after
   * `startTurnAttempt` returns `{kind: "started", handle}`, before this driver's own `await
   * wrap(started.handle.outcome)`), and again with `null` the moment that SAME attempt's
   * outcome settles (right after that same await resolves) — once per attempt, including
   * every retry, never overlapping (a NEW attempt's own `onAttemptStarted(handle)` call only
   * ever follows the PREVIOUS attempt's `onAttemptStarted(null)`, since this driver's loop is
   * sequential, never concurrent). Never called at all when admission itself is rejected (no
   * attempt ever starts).
   *
   * Deliberately typed against the narrow `{requestCancel}` shape, not the full
   * `TurnAttemptHandle` (`{outcome, requestCancel}`): a caller registering this handle
   * elsewhere (`core/kernel`'s `turn.start`, once its own remaining `core/ports` blocker
   * closes) has no legitimate use for reading `.outcome` a second time — this driver already
   * awaits it itself — so widening the type here would only invite an unused, redundant read.
   * Passing the REAL `started.handle` (not a re-wrapped copy) is what lets a caller's
   * `handle.requestCancel()` reach `attempt.ts`'s own `cancelRequested` coordination
   * (`./attempt.ts`'s own header, ordering (a)/(b)) — genuinely stopping the live run, and
   * — just as importantly — marking `cancelRequested` true BEFORE this driver's own
   * `finalizeOutcome` ever re-checks it, so a caller-driven cancel never trips the "`beginStopping`
   * illegal" defensive warning `attempt.ts` logs for a redundant same-state transition.
   */
  readonly onAttemptStarted?: (
    handle: { readonly requestCancel: () => Promise<void> } | null,
  ) => void;
}

/** What `runTurnValidation` needs beyond `turnId`/`attempt` — built from the frozen candidate. */
export interface RunTurnValidationMaterialV1 {
  readonly manifestText: string;
  readonly pages: readonly TurnValidationPageInputV1[];
}

/** `finalizeTurn`'s domain-specific fields — everything this driver cannot derive itself (the agent's own record text/warnings, the Gate-validated page diff, which sent pins resolved). */
export type RunTurnFinalizeMaterialV1 = Omit<
  FinalizeTurnInputV1,
  "turnId" | "targetChatId" | "stagedReadSet" | "createdAt"
>;

export interface RunTurnInputV1 {
  readonly admission: AdmissionInputV1;
  /**
   * Attempt 1's task. `workspacePath` is overridden every attempt from the minted turn
   * workspace (unknown until `runAdmission` succeeds); `userMessage` is overridden on a
   * retry with `baseTask.userMessage` plus the previous attempt's folded Gate diagnostics —
   * never accumulated across more than one retry (prompt.ts's own freshness barrier).
   */
  readonly baseTask: Omit<AgentTask, "fence">;
  /**
   * Builds this attempt's Gate input from the frozen candidate. Reading the candidate's
   * actual page bytes off `candidate.root` is the caller's job — `freezeTurnCandidate`'s own
   * diff is hash-only by design ("the diff never touches content", `candidate.ts`'s header),
   * and this driver never performs a raw file read itself.
   */
  readonly buildValidationInput: (candidate: TurnCandidateV1) => RunTurnValidationMaterialV1;
  /** Builds finalize's domain-specific fields once Gate has passed this attempt. */
  readonly buildFinalizeInput: (args: {
    readonly turnId: string;
    readonly attempt: Extract<TurnAttemptOutcomeV1, { kind: "completed" }>;
    readonly candidate: TurnCandidateV1;
    readonly validation: Extract<TurnValidationResultV1, { kind: "passed" }>;
  }) => RunTurnFinalizeMaterialV1;
}

export type RunTurnResultV1 =
  | {
      readonly kind: "admission-rejected";
      readonly outcome: Exclude<AdmissionOutcomeV1, { kind: "workspace-ready" }>;
    }
  | { readonly kind: "terminalized"; readonly result: TerminalizeTurnResultV1 }
  | { readonly kind: "finalized"; readonly result: FinalizeTurnResultV1 };

function deadlineExceededText(bound: "stream-silence" | "absolute"): string {
  return `the turn's ${bound} deadline expired before the next attempt could start`;
}

export async function runTurn(deps: RunTurnDeps, input: RunTurnInputV1): Promise<RunTurnResultV1> {
  const admissionDeps: AdmissionDeps = {
    machine: deps.machine,
    clock: deps.clock,
    pinReader: deps.pinReader,
    turnTransactions: deps.turnTransactions,
    staging: deps.staging,
  };
  const admission = await wrap(runAdmission(admissionDeps, input.admission));
  if (admission.kind !== "workspace-ready")
    return { kind: "admission-rejected", outcome: admission };

  const context = admission.context;

  /** One of the three sanctioned bridging edges into `terminalizing` — see this file's header. */
  function bridge(action: "beginSnapshot" | "beginTerminalization" | "requestCancel"): void {
    const moved = deps.machine.apply(action);
    if (moved.kind === "illegal") {
      console.warn(
        `core/turns/run-turn: ${action} illegal (${moved.code}) for turn ${context.turnId}`,
      );
    }
  }

  async function terminalize(
    outcome: TurnTerminalOutcome,
    text: string,
    reason?: string,
  ): Promise<RunTurnResultV1> {
    const terminalizeDeps: TerminalizeTurnDeps = {
      machine: deps.machine,
      turnTransactions: deps.turnTransactions,
    };
    const result = await wrap(
      terminalizeTurn(terminalizeDeps, {
        turnId: context.turnId,
        targetChatId: context.targetChatId,
        outcome,
        text,
        ...(reason !== undefined ? { reason } : {}),
        createdAt: deps.clock.now().toISOString(),
      }),
    );
    return { kind: "terminalized", result };
  }

  let attempt: TurnAttempt = 1;
  let userMessage = input.baseTask.userMessage;

  for (;;) {
    // Defense in depth matching the brief's own loop bound — unreachable via this driver's
    // own sequencing (validation's own "retry" never yields a `nextAttempt` beyond
    // `MAX_TURN_ATTEMPTS`), but never silently trusted either.
    if (attempt > MAX_TURN_ATTEMPTS) {
      bridge("requestCancel");
      return terminalize("failed", "the turn exceeded its attempt budget");
    }

    const deadline = deps.deadlines.check();
    if (deadline.kind === "expired") {
      bridge("requestCancel");
      return terminalize("failed", deadlineExceededText(deadline.bound));
    }

    const attemptDeps: TurnAttemptDeps = {
      machine: deps.machine,
      agentBackend: deps.agentBackend,
      deadlines: deps.deadlines,
      publish: deps.publish,
    };
    const task: Omit<AgentTask, "fence"> = {
      ...input.baseTask,
      workspacePath: context.workspace.root,
      userMessage,
    };
    const started = startTurnAttempt(attemptDeps, {
      turnId: context.turnId,
      fence: context.fence,
      task,
    });

    if (started instanceof Error) {
      // The fence rejected minting the next lease AFTER `beginAttempt` already moved the
      // machine to "running" (attempt.ts's own call order) — bridge through stopping first.
      bridge("requestCancel");
      bridge("beginTerminalization");
      return terminalize(
        "failed",
        `attempt fence rejected: ${started.message}`,
        String(started.reason),
      );
    }
    if (started.kind === "illegal") {
      // `beginAttempt` itself was illegal — the phase never left "workspace-ready".
      bridge("requestCancel");
      return terminalize("failed", `attempt could not start (${started.code})`, started.code);
    }

    // Step C3's own hook (this file's `RunTurnDeps.onAttemptStarted` doc comment) — the live
    // handle is registered BEFORE awaiting its own outcome, and cleared (`null`) the moment
    // that outcome resolves, so a caller's registered handle is never stale.
    deps.onAttemptStarted?.(started.handle);
    const outcome = await wrap(started.handle.outcome);
    deps.onAttemptStarted?.(null);

    if (outcome.kind === "cancelled") {
      bridge("beginTerminalization");
      return terminalize("cancelled", "the turn was cancelled");
    }
    if (outcome.kind === "failed") {
      bridge("beginTerminalization");
      return terminalize("failed", outcome.message);
    }
    if (outcome.kind === "backend-unhealthy") {
      // See this file's header: BACKEND-UNHEALTHY DIVERGENCE.
      bridge("beginTerminalization");
      return terminalize(
        "failed",
        "the backend could not confirm a clean exit",
        "unhealthy_unconfirmed_exit",
      );
    }

    // outcome.kind === "completed"
    // Re-checked here, not only at the loop top: an attempt that finishes past the
    // deadline must terminalize immediately rather than pay for a freeze + full Gate
    // validation whose candidate `finalizeTurn`'s own internal check would reject anyway.
    // The machine is already "stopping" (attempt.ts's own `beginStopping` on natural
    // completion), so `beginTerminalization` is the legal bridge — the same one the
    // "failed"/"backend-unhealthy" branches just above use from this exact phase.
    const postAttemptDeadline = deps.deadlines.check();
    if (postAttemptDeadline.kind === "expired") {
      bridge("beginTerminalization");
      return terminalize("failed", deadlineExceededText(postAttemptDeadline.bound));
    }

    bridge("beginSnapshot");
    const freezeDeps: FreezeTurnCandidateDeps = { machine: deps.machine, staging: deps.staging };
    const freeze = await wrap(freezeTurnCandidate(freezeDeps, { workspace: context.workspace }));

    if (freeze.kind === "illegal") {
      bridge("requestCancel");
      return terminalize("failed", `candidate freeze rejected (${freeze.code})`, freeze.code);
    }
    if (freeze.kind === "failed") {
      bridge("requestCancel");
      return terminalize("failed", freeze.failure.safeMessage, freeze.failure.code);
    }

    const candidate = freeze.candidate;
    const material = input.buildValidationInput(candidate);
    const validationDeps: TurnValidationDeps = {
      machine: deps.machine,
      gateRunner: deps.gateRunner,
      publish: deps.publish,
    };
    const validation: TurnValidationResultV1 = await wrap(
      runTurnValidation(validationDeps, {
        turnId: context.turnId,
        attempt,
        manifestText: material.manifestText,
        pages: material.pages,
      }),
    );

    if (validation.kind === "exhausted") {
      bridge("beginTerminalization");
      return terminalize("failed", validation.failure.safeMessage, validation.failure.code);
    }

    if (validation.kind === "retry") {
      // `validation.ts` already drove `retryAfterGate` (validating -> workspace-ready)
      // before returning "retry" — nothing to bridge on the success path.
      const fold: TurnGateFoldInputV1 = {
        rejectedAttempt: attempt,
        nextAttempt: validation.nextAttempt,
        diagnostics: validation.diagnostics,
      };
      const folded = deps.foldGateDiagnosticsIntoPrompt(fold);
      if (folded instanceof Error) {
        // The freshness barrier tripped — unreachable given this driver's own strictly
        // consecutive attempt numbering, but handled rather than assumed. The machine is
        // already back in "workspace-ready" (see the comment above).
        bridge("requestCancel");
        return terminalize("failed", folded.message);
      }
      userMessage = appendPromptFold(input.baseTask.userMessage, folded);
      attempt = validation.nextAttempt;
      continue;
    }

    // validation.kind === "passed"
    const finalizeDeps: FinalizeTurnDeps = {
      machine: deps.machine,
      turnTransactions: deps.turnTransactions,
      deadlines: deps.deadlines,
    };
    const finalizeMaterial = input.buildFinalizeInput({
      turnId: context.turnId,
      attempt: outcome,
      candidate,
      validation,
    });
    const finalizeResult = await wrap(
      finalizeTurn(finalizeDeps, {
        turnId: context.turnId,
        targetChatId: context.targetChatId,
        stagedReadSet: context.workspace.readSet,
        createdAt: deps.clock.now().toISOString(),
        ...finalizeMaterial,
      }),
    );
    return { kind: "finalized", result: finalizeResult };
  }
}
