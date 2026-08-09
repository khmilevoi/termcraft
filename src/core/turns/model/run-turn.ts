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
  ChatReader,
  GateRunner,
  PinReader,
  SessionCheckpointService,
  StagingService,
  TurnTransactionService,
} from "core/ports";
import type { Clock } from "infrastructure/clock";
import { trace } from "infrastructure/debug-log";

import type { AdmissionInputV1, AdmissionOutcomeV1, TurnContextV1 } from "../types";
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
import { fallbackToFreshSession } from "./session-plan";
import {
  type TerminalizeTurnDeps,
  type TerminalizeTurnResultV1,
  terminalizeTurn,
} from "./terminalize";
import {
  type RunTurnValidationInputV1,
  type TurnValidationDeps,
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
 * FINALIZE FAILURES DO BRIDGE INTO `terminalizeTurn`: `finalize.ts`'s own header marks the
 * `finalizing -> terminalizing` edge on a CAS-mismatch/deadline-exceeded failure "deliberately
 * NOT driven here... reached by a caller this function does not own" — THIS driver is that
 * caller. A `finalizeTurn` result of `{kind:"failed", failure}` means `beginFinalization`
 * already succeeded (the machine IS in `"finalizing"`), so leaving it there and merely
 * returning the failure (an earlier version of this file's own bug) strands the turn machine
 * in `"finalizing"` permanently — every later `chat.*`/`turn.*`/`export.*` command in the same
 * process is then guard-rejected `CAPABILITY_UNAVAILABLE` forever, not just this one turn.
 *
 * `{kind:"illegal"}` ALSO BRIDGES — CORRECTED (fixlane-K1-turn-spine.json's domain finding):
 * the claim "the machine never left its PREVIOUS phase, nothing to unwind" is true ONLY for
 * `beginFinalization`-illegal (defensive-only here — this driver's own strictly synchronous
 * sequencing from "validation passed" to the `finalizeTurn` call, with no `await` in between,
 * proves the machine is still `"validating"` at that call; unreachable in practice). It is
 * FALSE for `markCommitted`/`settle`-illegal: `finalize.ts`'s own body only ever reaches
 * `deps.machine.apply("markCommitted")` AFTER `turnTransactions.finalize` has ALREADY
 * returned a real, durable `TurnCommitV1` (its own `if ("code" in result) return
 * {kind:"failed",...}` runs first) — so by the time either of THOSE two applies can be
 * illegal, a commit already durably exists, and the machine left `"finalizing"` via some
 * OTHER already-applied transition (almost always a concurrent `turn.cancel`'s `requestCancel`
 * landing in the pre-intent window between `beginFinalization` and this durable write — legal
 * by the turn machine's own table, `turn-machine.ts`'s own comment: "Phase-legal; the
 * pre/post-intent CANCEL_TOO_LATE split is the guard layer's"). Returning
 * `{kind:"finalized", result:{kind:"illegal"}}` for THAT case would report a false success
 * (the caller's own `handlers/turn.ts` maps `finalized`+non-`committed` as a generic
 * `turn.failed`, but never terminalizes/settles the machine) while leaving it stranded
 * outside `terminal`/`idle` exactly like the failed-branch bug above — so this branch bridges
 * identically, and never returns `finalized` for anything but a genuine `committed` result.
 */

export interface RunTurnDeps {
  readonly machine: StateMachine<TurnState, TurnAction>;
  readonly clock: Clock;
  readonly pinReader: PinReader;
  readonly turnTransactions: TurnTransactionService;
  readonly staging: StagingService;
  /** Only `readAppendBase` is needed — threaded straight through to `AdmissionDeps` (`admission.ts`'s own header, step 1b). */
  readonly chatReader: Pick<ChatReader, "readAppendBase">;
  readonly agentBackend: AgentBackend;
  readonly gateRunner: GateRunner;
  readonly deadlines: TurnDeadlines;
  /**
   * Needed ONLY for {@link fallbackToFreshSession} (design-agent-feedback-loop repair, Task 9):
   * when a resume the checkpoint judged legitimate is rejected by the backend itself
   * (`outcome.cause === "resume-rejected"`), this driver builds a fresh-session plan through
   * the SAME port `evaluateSessionPlan` already used upstream to produce attempt 1's own plan
   * — never a second, independently derived seed-selection path.
   */
  readonly sessionCheckpoint: SessionCheckpointService;
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
  /**
   * Optional, additive hook (fixlane-K1-turn-spine.json's kernel finding) closing the durable
   * "commit-intent recorded" bit's own remaining producer-side gap — `core/kernel/model
   * /kernel.ts`'s own `commitIntentRecordedAtom` (fed to `revision-guard.ts`'s
   * `durableIntentRecorded` and `capabilities/model/guards.ts`'s `commitIntentRecorded`,
   * §8.4 rule 6 / §7.2's "in finalizing after durable intent, cancellation is forbidden")
   * was permanently `false` because no production handler ever called
   * `HandlerContext.setCommitIntentRecorded`. Mirrors `onAttemptStarted`'s own producer-hook
   * shape exactly: this driver calls it, `handlers/turn.ts` wires it onto the Kernel-held
   * mutator (`context.setCommitIntentRecorded`).
   *
   * Called with `true` the MOMENT `finalizeTurn` reports that `turnTransactions.finalize`
   * ALREADY returned a durable `TurnCommitV1` — both the `"committed"` result AND the
   * `"illegal"` result reaching THIS driver mean that (see this file's header, "`{kind:
   * "illegal"}` ALSO BRIDGES" for why `markCommitted`/`settle`-illegal still implies a real
   * commit). Never called `true` for `"failed"` (no write ever durably landed) or for a
   * `beginFinalization`-illegal (unreachable here). `handlers/turn.ts` is responsible for
   * clearing it back to `false` once ITS OWN `runTurn` call settles — UNLIKE `onSettled` below,
   * this bit has no settle-time hook of its own (it only ever fires `true`, never `false`), so
   * that post-`await` clear stays this driver's caller's own job, not something `onSettled`
   * could absorb.
   */
  readonly onCommitIntentRecorded?: (recorded: boolean) => void;
  /** Threaded straight through to both {@link FinalizeTurnDeps.onSettled} and {@link TerminalizeTurnDeps.onSettled} — see either doc comment for the full rationale (fix-bundle spec §1.5). */
  readonly onSettled?: () => void;
  /**
   * Called exactly once, with the admitted {@link TurnContextV1}, the moment admission
   * succeeds — before the first attempt starts and never on a rejected admission.
   *
   * Exists because `RunTurnInputV1.buildFinalizeInput` receives only
   * `{turnId, attempt, candidate, validation}`, and one field of the finalize material it must
   * produce — `sentPins` — is knowable ONLY from admission: §12.2 item 1's "captures ... only
   * currently open, resolvable pins" is decided inside `runAdmission`, which re-folds each
   * candidate page and writes the surviving ids onto `context.userRecord.pins`. Without this
   * hook the Kernel handler had no path to that set at all and hardcoded `sentPins: []`, so
   * `resolveSentPinAppends` never had anything to resolve and a pin the agent had just
   * addressed stayed open forever.
   *
   * Deliberately the whole context rather than the pin ids alone: it is the value admission
   * already produced, and narrowing it here would invite a second, drifting definition of what
   * "the admitted turn" is.
   */
  readonly onAdmitted?: (context: TurnContextV1) => void;
}

/**
 * What `runTurnValidation` needs beyond `turnId`/`attempt` — built from the frozen candidate.
 *
 * Every field is now WHOLE-TREE rather than per-page (task 14): the caller supplies the
 * candidate's manifest text, its full tree inventory, every tree file's source text, and the
 * candidate's absolute `design/` root. WHICH pages exist, and which file each one lives in, is
 * decided inside `runTurnValidation` by decoding that manifest — never by a caller-assembled
 * page list, which is the slug-shaped page identity the design tree retires.
 */
export type RunTurnValidationMaterialV1 = Omit<RunTurnValidationInputV1, "turnId" | "attempt">;

/**
 * `finalizeTurn`'s domain-specific fields — everything this driver cannot derive itself (the
 * agent's own record text/warnings, the Gate-validated page diff, which sent pins resolved).
 * `candidateRoot` is omitted for the same reason as `turnId`/`stagedReadSet`/`createdAt`:
 * this driver already holds `candidate.root` itself (the freeze this exact attempt just
 * produced) and supplies it directly at the `finalizeTurn` call site below — a caller's
 * `buildFinalizeInput` has no legitimate way to know it independently.
 */
export type RunTurnFinalizeMaterialV1 = Omit<
  FinalizeTurnInputV1,
  "turnId" | "targetChatId" | "stagedReadSet" | "createdAt" | "candidateRoot"
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
    chatReader: deps.chatReader,
  };
  const admission = await wrap(runAdmission(admissionDeps, input.admission));
  if (admission.kind !== "workspace-ready") {
    // DIAGNOSTIC (infrastructure/debug-log): admission refused before any attempt could
    // start -- the turn never reaches the agent at all; recording why here is the only way
    // to see that distinct from an attempt that started and then failed.
    trace("core.turns.runTurn.admissionRejected", { outcome: admission });
    return { kind: "admission-rejected", outcome: admission };
  }

  const context = admission.context;
  deps.onAdmitted?.(context);

  /** One of the three sanctioned bridging edges into `terminalizing` — see this file's header. */
  function bridge(action: "beginSnapshot" | "beginTerminalization" | "requestCancel"): void {
    const moved = deps.machine.apply(action);
    if (moved.kind === "illegal") {
      console.warn(
        `core/turns/run-turn: ${action} illegal (${moved.code}) for turn ${context.turnId}`,
      );
    }
  }

  /**
   * `candidateRoot` is REQUIRED at every call site below — CORRECTED (review finding #4): an
   * earlier version treated it as optional and omitted it at every call site that fired
   * before THIS iteration's own `freezeTurnCandidate` call, on the false assumption that "no
   * candidate frozen yet this iteration" meant "no candidate exists at all". That is false
   * once retries exist: a gate-triggered retry (`validation.kind === "retry"`, below) leaves
   * the PRIOR attempt's already-frozen candidate live, then loops back to the top with a
   * fresh `attempt` number — so a NEXT-iteration cancellation/failure/deadline-expiry that
   * fires before ITS OWN freeze was silently abandoning the PREVIOUS attempt's candidate
   * forever, on the ordinary gate-retry path this whole task exists to close. Note also that
   * `freezeTurnCandidate` reuses the SAME turnId-keyed root on every attempt of one turn
   * (`store/adapters/staging.ts`'s `candidateDestRoot`; the in-memory fake's identical
   * `/fake-candidate/${turnId}` keying) — so a retry never leaves a SECOND, distinct
   * candidate directory behind; it is always the one true candidate for this turn, which
   * every call site below must still retire even when THIS iteration never got to (re)freeze
   * it. `candidateRoot` is `null` only before the FIRST successful freeze of this turn —
   * the one case where no candidate has ever existed.
   */
  async function terminalize(
    outcome: TurnTerminalOutcome,
    text: string,
    reason: string | undefined,
    candidateRoot: string | null,
  ): Promise<RunTurnResultV1> {
    const terminalizeDeps: TerminalizeTurnDeps = {
      machine: deps.machine,
      turnTransactions: deps.turnTransactions,
      staging: deps.staging,
      ...(deps.onSettled !== undefined ? { onSettled: deps.onSettled } : {}),
    };
    const result = await wrap(
      terminalizeTurn(terminalizeDeps, {
        turnId: context.turnId,
        targetChatId: context.targetChatId,
        outcome,
        text,
        ...(reason !== undefined ? { reason } : {}),
        createdAt: deps.clock.now().toISOString(),
        candidateRoot,
      }),
    );
    // DIAGNOSTIC (infrastructure/debug-log): the turn's own terminal record -- the text and outcome
    // this driver decided to persist, whether that write itself landed durably or not.
    trace("core.turns.runTurn.terminalized", { turnId: context.turnId, outcome, reason, result });
    return { kind: "terminalized", result };
  }

  let attempt: TurnAttempt = 1;
  let userMessage = input.baseTask.userMessage;
  /**
   * The session plan THIS attempt runs under. Attempt 1 uses the turn's plan (resolved once,
   * upstream of this driver — `input.baseTask.session`); a Gate retry replaces it with a
   * RESUME of the attempt it is correcting (design-agent-feedback-loop repair, Task 8).
   *
   * WHY A RESUME IS VALID HERE WHILE CROSS-TURN RESUME IS NOT. The SDK indexes sessions by
   * cwd, and every TURN gets a fresh workspace (`store/sandbox/model/staging-store.ts`) —
   * which is why a session id from a PREVIOUS turn is unresolvable and produced the measured
   * `No conversation found with session ID: …`. Within ONE turn the workspace is IDENTICAL
   * across attempts, so the session the rejected attempt created is still addressable from the
   * same cwd. Measured (spike 12, observation C): resuming from the same cwd succeeded and read
   * back exactly the context the rejected attempt had already written —
   * `cache_read_input_tokens: 17739` against the earlier attempt's own
   * `cache_creation_input_tokens: 17739` — at roughly a tenth of the cost ($0.0104 vs $0.1065),
   * because that context was served from cache instead of re-sent.
   *
   * WHY THIS MATTERS MORE THAN IT LOOKS. A fresh retry session re-reads RUNTIME.md, REATOM.md,
   * runtime.d.ts and every page file to apply what were, in the measured production run, four
   * one-token type annotations — and re-hits the same path errors on the way. The diagnostics
   * ride as `promptDelta` (see the retry branch below) rather than as a new first message
   * precisely so the resumed session reads them as the next turn of a conversation it already
   * remembers, not as a cold start.
   */
  let session = input.baseTask.session;
  /**
   * The most recently frozen candidate's own root, across every attempt this turn has run so
   * far — hoisted above the retry loop (review finding #4) instead of being declared fresh
   * inside it, precisely so a retry's own abandonment (see `terminalize`'s own doc just
   * above) never loses track of what still needs retiring. Reassigned the moment THIS
   * iteration's own freeze succeeds; every earlier `terminalize(...)` call site in a given
   * iteration reads whatever a PRIOR iteration already set. `null` until the first successful
   * freeze this turn has ever produced.
   */
  let candidateRoot: string | null = null;
  /**
   * ONCE PER TURN (design-agent-feedback-loop repair, Task 9). A backend that rejects every
   * resume must not spin the whole attempt budget on session fallbacks — the SECOND
   * `"resume-rejected"` outcome in one turn terminalizes ordinarily instead of retrying again.
   * Set the moment the fallback is ATTEMPTED (not only on its success), so a `selectSeed`
   * failure inside it never leaves this driver willing to try the fallback path a second time
   * on a later, unrelated resume rejection.
   */
  let sessionFallbackUsed = false;

  for (;;) {
    // DIAGNOSTIC (infrastructure/debug-log): marks the start of this turn's Nth attempt -- the retry
    // loop otherwise leaves no record of how many times a turn actually re-ran the agent.
    trace("core.turns.runTurn.attemptLoop", { turnId: context.turnId, attempt });
    // Defense in depth matching the brief's own loop bound — unreachable via this driver's
    // own sequencing (validation's own "retry" never yields a `nextAttempt` beyond
    // `MAX_TURN_ATTEMPTS`), but never silently trusted either.
    if (attempt > MAX_TURN_ATTEMPTS) {
      bridge("requestCancel");
      return terminalize(
        "failed",
        "the turn exceeded its attempt budget",
        undefined,
        candidateRoot,
      );
    }

    const deadline = deps.deadlines.check();
    if (deadline.kind === "expired") {
      bridge("requestCancel");
      return terminalize("failed", deadlineExceededText(deadline.bound), undefined, candidateRoot);
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
      session,
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
      // REVIEW ROUND 1, FINDING 2: `fence.ts`'s own `beginAttempt` counter increments
      // unconditionally on EVERY `startTurnAttempt` call, independent of this driver's local
      // `attempt` bookkeeping — and a session fallback deliberately leaves `attempt` unchanged
      // (this file's own comment at the fallback call site) so it never spends a Gate-retry
      // slot. That is correct for `canRetryAfterGate`'s own local accounting, but it means the
      // fence's independent hard `MAX_TURN_ATTEMPTS` counter can run out ONE ATTEMPT BEFORE this
      // driver's local counter expects it to — reachable ONLY when a fallback already fired this
      // turn (`sessionFallbackUsed`): without one, the local counter and the fence counter never
      // diverge, and `canRetryAfterGate` already refuses a 5th attempt from this driver's own
      // side first, so this branch stays genuinely unreachable exactly as it always was.
      //
      // Every reachable path into THIS branch after a fallback is the Gate rejecting the
      // candidate repeatedly until the fence — not the driver's own count — ran dry, which is
      // honestly `GATE_RETRY_EXHAUSTED`, not the generic `PERSISTENCE_FAILED` a raw,
      // non-`OperationalFailureCode` fence message would otherwise fall back to
      // (`handlers/turn.ts`'s `terminalFailureDto`, `isOperationalFailureCode` gate). Reusing
      // that closed code rather than adding a new one: `OPERATIONAL_FAILURE_CODES_V1` is a
      // count-asserted, wire-schema-bound 30-entry registry, and this failure IS a Gate-retry
      // exhaustion in substance — just discovered one attempt later than the driver's own local
      // count alone would have found it.
      return terminalize(
        "failed",
        `attempt fence rejected: ${started.message}`,
        sessionFallbackUsed ? "GATE_RETRY_EXHAUSTED" : String(started.reason),
        candidateRoot,
      );
    }
    if (started.kind === "illegal") {
      // `beginAttempt` itself was illegal — the phase never left "workspace-ready".
      bridge("requestCancel");
      return terminalize(
        "failed",
        `attempt could not start (${started.code})`,
        started.code,
        candidateRoot,
      );
    }

    // Step C3's own hook (this file's `RunTurnDeps.onAttemptStarted` doc comment) — the live
    // handle is registered BEFORE awaiting its own outcome, and cleared (`null`) the moment
    // that outcome resolves, so a caller's registered handle is never stale.
    deps.onAttemptStarted?.(started.handle);
    const outcome = await wrap(started.handle.outcome);
    deps.onAttemptStarted?.(null);
    // DIAGNOSTIC (infrastructure/debug-log): this attempt outcome as seen by the turn driver --
    // recorded here too (not only in attempt.ts) so the branch decisions below (retry, finalize,
    // terminalize) are traceable against the exact outcome that drove them.
    trace("core.turns.runTurn.attemptOutcome", { turnId: context.turnId, attempt, outcome });

    if (outcome.kind === "cancelled") {
      bridge("beginTerminalization");
      return terminalize("cancelled", "the turn was cancelled", undefined, candidateRoot);
    }
    if (outcome.kind === "failed") {
      // A REJECTED RESUME IS RECOVERABLE, AND THE RECOVERY WAS ALREADY WRITTEN.
      // `fallbackToFreshSession` (`./session-plan.ts`) was defined and tested with no
      // production caller since the session-resume slice landed (`docs/mvp-remaining-work.md`'s
      // own row, closed by this task). MEASURED cost of the gap, 2026-08-09: a turn
      // terminalized `BACKEND_FAILED: No conversation found with session ID: 28b861a5`, and the
      // user abandoned the chat and retyped the message into a new one within 20 seconds.
      //
      // ONCE PER TURN (`sessionFallbackUsed`, hoisted above this loop) — a backend that rejects
      // every resume must not spin the whole attempt budget chasing a fault no retry fixes.
      //
      // NOT A GATE RETRY: `attempt` is deliberately left UNCHANGED here, unlike the Gate-retry
      // branch below (which advances it to `validation.nextAttempt`). This is a pure backend
      // fault, not a Gate rejection of the candidate — spending one of the Gate's own 3 real
      // retries on it would cut the author's actual retry budget to 2 for a failure they did
      // nothing to cause. (The underlying `TurnFence`'s own hard `MAX_TURN_ATTEMPTS` ceiling
      // still counts this retry regardless — every `startTurnAttempt` call mints a lease via
      // `fence.beginAttempt()` independent of this driver's own `attempt` variable — but that
      // ceiling is a separate, harder budget this task does not relax.)
      //
      // Checked and attempted BEFORE `bridge("beginTerminalization")`: that transition is
      // terminal for this loop (a later `startTurnAttempt` would find the machine no longer
      // `"workspace-ready"`), so the fallback must run first and `continue` the loop on
      // success — bridging only on the paths that actually terminalize below.
      if (outcome.cause === "resume-rejected" && !sessionFallbackUsed) {
        sessionFallbackUsed = true;
        const fallback = await wrap(
          fallbackToFreshSession(
            { sessionCheckpoint: deps.sessionCheckpoint, deadlines: deps.deadlines },
            context.targetChatId,
          ),
        );
        if (!("code" in fallback)) {
          // `attempt.ts`'s `finalizeOutcome` already drove `running -> stopping`
          // (`beginStopping`) unconditionally before this outcome ever reached this driver — the
          // machine is NOT back in `workspace-ready` the way a Gate retry's own
          // `validating -> workspace-ready` (`retryAfterGate`, driven inside `validation.ts`)
          // leaves it. `retryAfterSessionFallback` (`stopping -> workspace-ready`,
          // `core/machines/model/turn-machine.ts`) is the edge this task added for exactly this
          // gap — see that file's own comment on the transition-table row for why no pre-existing
          // edge covered it. Not routed through `bridge(...)` above: that helper is documented as
          // "one of the three sanctioned bridging edges INTO terminalizing" — this edge goes the
          // other way, back into `workspace-ready`, so it is applied directly here instead,
          // mirroring `validation.ts`'s own `retryAfterGate` call exactly (apply, warn-if-illegal,
          // never throw).
          const retried = deps.machine.apply("retryAfterSessionFallback");
          if (retried.kind === "illegal") {
            console.warn(
              `core/turns/run-turn: retryAfterSessionFallback illegal (${retried.code}) for turn ${context.turnId}`,
            );
          }
          // A fresh-session plan for the NEXT attempt, sent as a first message again (never a
          // resume's `promptDelta` channel — see `session`'s own doc comment above for why the
          // two channels are mutually exclusive by construction).
          //
          // REVIEW ROUND 1, FINDING 1: `classifyBackendErrorCause`'s guard 1 is
          // `SessionPlan.kind === "resume"` — it does NOT distinguish a cross-turn resume (the
          // turn's OWN starting plan) from an INTRA-turn resume Task 8's own Gate-retry branch
          // built a few lines below (`session = {kind: "resume", sessionId, promptDelta:
          // folded}`). If the backend rejects THAT resume, `session` here already carries the
          // accumulated Gate diagnostics in its `promptDelta` — and reassigning `session` to the
          // fresh plan without capturing them first would silently discard exactly the
          // information the fresh attempt most needs to avoid reproducing the same invalid
          // candidate. This is the identical class of bug the defensive branch below (`session`'s
          // own "DO NOT simplify" comment) already guards against for a different edge — folding
          // here the same way, via the same append-only `appendPromptFold` convention, rather than
          // silently starting the fresh attempt with none of what Gate already found wrong.
          const rejectedSession = session;
          session = fallback;
          userMessage =
            rejectedSession.kind === "resume" && rejectedSession.promptDelta !== null
              ? appendPromptFold(input.baseTask.userMessage, rejectedSession.promptDelta)
              : input.baseTask.userMessage;
          continue;
        }
        // The fallback itself could not build a fresh-session plan (a `selectSeed` failure) —
        // terminalize on THAT failure, since it is the actual reason no further attempt is
        // possible, not the original resume rejection this branch was trying to recover from.
        bridge("beginTerminalization");
        return terminalize("failed", fallback.safeMessage, fallback.code, candidateRoot);
      }
      bridge("beginTerminalization");
      // `"BACKEND_FAILED"` (`core/protocol/model/failure.ts`'s own closed vocabulary) rather
      // than `undefined`: this `reason` is what `terminalize.ts`'s widened
      // `TerminalizeTurnResultV1` now echoes back to `handlers/turn.ts`, which is otherwise
      // unable to tell an agent-backend failure apart from Gate exhaustion on `turn.failed`
      // (both terminalize as an ordinary `"recorded"` outcome) — see that file's header.
      return terminalize("failed", outcome.message, "BACKEND_FAILED", candidateRoot);
    }
    if (outcome.kind === "backend-unhealthy") {
      // See this file's header: BACKEND-UNHEALTHY DIVERGENCE.
      bridge("beginTerminalization");
      return terminalize(
        "failed",
        "the backend could not confirm a clean exit",
        "unhealthy_unconfirmed_exit",
        candidateRoot,
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
      return terminalize(
        "failed",
        deadlineExceededText(postAttemptDeadline.bound),
        undefined,
        candidateRoot,
      );
    }

    bridge("beginSnapshot");
    const freezeDeps: FreezeTurnCandidateDeps = { machine: deps.machine, staging: deps.staging };
    const freeze = await wrap(freezeTurnCandidate(freezeDeps, { workspace: context.workspace }));

    if (freeze.kind === "illegal") {
      bridge("requestCancel");
      return terminalize(
        "failed",
        `candidate freeze rejected (${freeze.code})`,
        freeze.code,
        candidateRoot,
      );
    }
    if (freeze.kind === "failed") {
      bridge("requestCancel");
      return terminalize("failed", freeze.failure.safeMessage, freeze.failure.code, candidateRoot);
    }

    const candidate = freeze.candidate;
    // This iteration successfully (re)froze the turn's one candidate — see this file's own
    // `terminalize` doc comment for why every earlier-in-a-LATER-iteration call site needs
    // this hoisted binding rather than a loop-local `const`.
    candidateRoot = candidate.root;
    const material = input.buildValidationInput(candidate);
    const validationDeps: TurnValidationDeps = {
      machine: deps.machine,
      gateRunner: deps.gateRunner,
      publish: deps.publish,
    };
    const validation: TurnValidationResultV1 = await wrap(
      runTurnValidation(validationDeps, { turnId: context.turnId, attempt, ...material }),
    );

    if (validation.kind === "exhausted") {
      bridge("beginTerminalization");
      return terminalize(
        "failed",
        validation.failure.safeMessage,
        validation.failure.code,
        candidateRoot,
      );
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
        // already back in "workspace-ready" (see the comment above). This iteration's own
        // freeze already succeeded (`candidateRoot` was just set above), so it still needs
        // retiring here.
        bridge("requestCancel");
        return terminalize("failed", folded.message, undefined, candidateRoot);
      }
      // DIAGNOSTIC (infrastructure/debug-log): the Gate diagnostics text folded into the next attempt
      // prompt -- the actual content that changes what gets sent to the agent on a retry.
      trace("core.turns.runTurn.gateRetry", {
        turnId: context.turnId,
        rejectedAttempt: attempt,
        nextAttempt: validation.nextAttempt,
        foldedAddition: folded,
      });

      // `outcome` is the `completed` variant here (narrowed above at the top of this
      // iteration), so `sessionId` is a non-optional `string` — the retry RESUMES the
      // rejected attempt's own session rather than starting fresh (see this file's `session`
      // doc comment above for the full rationale and the measured spike-12 evidence). The
      // fold rides as `promptDelta`, not as a fresh first message.
      //
      // `agent/session/model/prompt.ts:13` reads `task.session.promptDelta ?? task.userMessage`
      // — on a resume the delta IS what is sent and `userMessage` is not sent at all, so the
      // two channels are mutually exclusive by construction, and exactly one of the two
      // branches below carries the fold.
      if (outcome.sessionId) {
        session = { kind: "resume", sessionId: outcome.sessionId, promptDelta: folded };
        userMessage = input.baseTask.userMessage;
        attempt = validation.nextAttempt;
        continue;
      }

      // DEFENSIVE, not expected to fire today: a real `completed` outcome's `sessionId` is a
      // non-optional `string`, never empty in practice. If the outcome type ever widens to
      // admit a completed attempt without a usable session id, `session` is left UNCHANGED
      // here rather than reverting to `input.baseTask.session` — that reversion would discard
      // an already-established resume chain on any retry past the very first one (on the
      // FIRST retry the two are identical, since `session` has not been reassigned yet, but
      // they diverge on a later one). Leaving it unchanged means the next attempt keeps
      // resuming whatever this driver was already resuming.
      //
      // WHICH CHANNEL prompt.ts:13's rule will read for that (unchanged) `session` depends on
      // ITS OWN kind and delta — round-1 review finding: `input.baseTask.session` is NOT
      // always a "fresh" plan with no `promptDelta` slot. WP-7's same-process chat resume
      // (`store/adapters/session-checkpoint.ts`'s `renderPromptDelta`,
      // `core/turns/model/session-plan.ts`'s `evaluateSessionPlan`) can hand this driver a
      // "resume" plan whose `promptDelta` is already a real, non-null transcript — and so can
      // an earlier iteration of the primary branch just above, on a SECOND defensive fallback
      // within the same turn. Either way `userMessage` is then a DEAD channel `prompt.ts`
      // never reads, so appending the fold there would reach neither channel the agent
      // actually reads — exactly the silent-loss failure mode this whole task exists to
      // prevent. The fold rides whichever channel the rule will actually pick: appended onto
      // an existing non-null `promptDelta` (never clobbering the original text — the same
      // append-only convention `appendPromptFold` and `ui/app/model/intent.ts`'s draft-append
      // rule both already use), or onto `userMessage` only when `session` has no `promptDelta`
      // to carry it (a "fresh" plan, or a "resume" with a null delta — precisely the case
      // `?? task.userMessage` itself falls through to).
      //
      // DO NOT simplify this back to an unconditional `userMessage = appendPromptFold(...)`
      // without re-checking `agent/session/model/prompt.ts:13`'s channel-selection rule first.
      if (session.kind === "resume" && session.promptDelta !== null) {
        session = { ...session, promptDelta: appendPromptFold(session.promptDelta, folded) };
        userMessage = input.baseTask.userMessage;
      } else {
        userMessage = appendPromptFold(input.baseTask.userMessage, folded);
      }
      attempt = validation.nextAttempt;
      continue;
    }

    // validation.kind === "passed"
    const finalizeDeps: FinalizeTurnDeps = {
      machine: deps.machine,
      turnTransactions: deps.turnTransactions,
      deadlines: deps.deadlines,
      staging: deps.staging,
      ...(deps.onSettled !== undefined ? { onSettled: deps.onSettled } : {}),
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
        candidateRoot: candidate.root,
        ...finalizeMaterial,
      }),
    );

    if (finalizeResult.kind === "failed") {
      // See this file's header, "FINALIZE FAILURES DO BRIDGE INTO terminalizeTurn": without
      // this bridge the machine is already in "finalizing" (beginFinalization succeeded
      // inside finalizeTurn) and would be stranded there forever. `finalizeTurn` itself never
      // reached its own candidate-retirement call on this exit (see its header — that only
      // runs after a durable commit), so the candidate this attempt froze is still live;
      // passing `candidateRoot` here is what lets `terminalizeTurn`'s own retirement close
      // it instead of leaking it (review finding #4).
      bridge("beginTerminalization");
      return terminalize(
        "failed",
        finalizeResult.failure.safeMessage,
        finalizeResult.failure.code,
        candidateRoot,
      );
    }

    // CANCELLED BEFORE ANY WRITE (defect fix, 2026-07-26). `beginFinalization` is refused only
    // when the machine has ALREADY left `validating`, and the one other edge out of that phase
    // is `requestCancel` (`turn-machine.ts`'s table) — so this is a real user cancel that landed
    // while the Gate was still compiling/linting/smoke-testing the candidate, which is exactly
    // when a cancel is most likely (a multi-page validation takes real time, and the composer
    // shows `esc cancel` throughout).
    //
    // `finalizeTurn` returns at that apply, BEFORE `turnTransactions.finalize` — nothing was
    // committed, no page bytes written, no chat mutation. This branch used to fall through to
    // the one below and record "the turn's commit landed durably" verbatim into the chat: the
    // user pressed Esc and was told their edit had been saved. It must not touch
    // `onCommitIntentRecorded` either — that bit means a durable commit exists.
    if (finalizeResult.kind === "illegal" && finalizeResult.at === "beginFinalization") {
      // No `bridge("beginTerminalization")` here, unlike the two branches around it: the only
      // edge out of `validating` other than `beginFinalization` is `requestCancel`, which lands
      // ON `terminalizing` — so the machine is already there, and bridging would only log a
      // spurious "illegal" warning on an ordinary Esc.
      return terminalize(
        "cancelled",
        "the turn was cancelled before its changes were written",
        undefined,
        candidateRoot,
      );
    }

    // `finalizeResult.kind` is `"committed"`, or `"illegal"` at `markCommitted`/`settle` — and
    // both of THOSE mean `turnTransactions.finalize` already returned a durable `TurnCommitV1`
    // (see this file's header, "`{kind:"illegal"}` ALSO BRIDGES").
    deps.onCommitIntentRecorded?.(true);

    if (finalizeResult.kind === "illegal") {
      // Corrected (see this file's header): NEVER report this as `finalized` — a durable
      // commit exists, but the machine left "finalizing" via some other already-applied
      // transition (almost always a raced `turn.cancel`), so `markCommitted`/`settle` is now
      // illegal. Bridge to terminalizing exactly like the "failed" branch above, so the
      // machine still settles to `terminal`/`idle` instead of being stranded. `markCommitted`
      // going illegal means `finalizeTurn` returned before its own candidate-retirement call
      // too (see its header) — `candidateRoot` here retires it via `terminalizeTurn` instead.
      bridge("beginTerminalization");
      return terminalize(
        "failed",
        "the turn's commit landed durably, but the turn machine could not settle onto it (a concurrent cancel most likely raced the pre-intent window)",
        finalizeResult.code,
        candidateRoot,
      );
    }

    // DIAGNOSTIC (infrastructure/debug-log): the turn's successful finalize result -- the durable
    // commit this attempt generation work produced.
    trace("core.turns.runTurn.finalized", {
      turnId: context.turnId,
      attempt,
      result: finalizeResult,
    });
    return { kind: "finalized", result: finalizeResult };
  }
}
