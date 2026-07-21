import { wrap } from "@reatom/core";
import * as errore from "errore";

import type { KernelCounters } from "core/kernel/model/counters";
import {
  type AcceptedCommandV1,
  type CanonicalHashError,
  type CommandDecodeError,
  type CommandEnvelopeV1,
  type CommandPayloadByKindV1,
  type CommandRejectionCode,
  type CommandResultV1,
  type RejectedCommandV1,
  type UInt64String,
  type UUIDv7,
  type UnavailableReason,
  decodeCommandEnvelope,
  primaryReason,
} from "core/protocol";

import type {
  GuardRegistry,
  HandlerRegistry,
  KernelStateSnapshot,
  TargetExtractor,
} from "../types";
import { type DedupeLedger, DedupeRejectionError } from "./dedupe-ledger";
import type { EventBus } from "./event-bus";
import {
  type RevisionGuardCommand,
  type RevisionGuardDecision,
  type TurnCancelProbe,
  checkRevisionGuard,
} from "./revision-guard";

/**
 * The Kernel command mailbox's dispatch pipeline (kernel-command-contract §12.1).
 *
 * §12.1's six steps, verbatim, in order — "The order is normative, not stylistic":
 *
 * 1. "The UI resolves a trigger through the action registry, checks local applicability
 *    and the mirrored Kernel capability, generates one UUIDv7 `commandId`, and sends the
 *    current mirrored revision." — the UI's side, not this module's.
 * 2. "The mailbox validates the closed DTO and protocol, installs or finds the dedupe
 *    entry, and performs the revision check."
 * 3. "It extracts exactly `CapabilityTargetByKindV1[kind]` by §10.1 and evaluates the
 *    authoritative guard over that target. A failure records and returns `Rejected`
 *    without a model transition; payload-only freshness/token/mutex checks remain the
 *    owning command's subsequent validation and cannot alter capability parity."
 * 4. "It calls one or more named model actions in a single Reatom frame. Cross-model
 *    orchestration is a named Kernel action, never UI-side sequencing."
 * 5. "If state changed, the mailbox advances `stateRevision` once, derives
 *    capabilities, records `Accepted`, and publishes contiguous state/domain events."
 * 6. "For async work, the owning service starts after the state transition. Its wrapped
 *    completion signal returns through the mailbox and causes another legal named
 *    transition."
 *
 * Step 5's "derives capabilities" is the capability projector's job (§5: "Calls the
 * exact guard functions used by dispatch and emits typed capability entries whenever
 * their inputs change"), not dispatch's — it reacts to the SAME state this module
 * mutates, from outside this pipeline, and neither exists yet (6C). Step 6's async
 * service kickoff is likewise not this module's call to make: `HandlerRegistry` (6C) is
 * the "one or more named model actions" of step 4, and whatever starts an async
 * operation does so as part of, or in reaction to, that action — `signal-ingress.ts`
 * owns the RETURN half of step 6, not this file.
 *
 * DECODE BEFORE DEDUPE, deliberately. §12.1 step 2 lists them in that order — "validates
 * the closed DTO and protocol, installs or finds the dedupe entry" — and there is a
 * correctness reason to keep it that way, not just a stylistic one: §8.5's dedupe ledger
 * keys its `Map` on `commandId` as a validated `UUIDv7` (`dedupe-ledger.ts`'s
 * `run(envelopeRaw, commandId, execute)` takes it as a typed parameter, not something it
 * extracts and validates itself), and a raw envelope that fails decode may not even
 * carry one — there is no id to key an entry on in the first place. More importantly,
 * §8.5's exactly-once guarantee is a promise about SUBMITTED COMMANDS ("For a
 * first-seen id, the ledger stores a canonical hash of the complete envelope..."); a
 * envelope that never parsed was never one. Recording a dedupe entry for a decode
 * failure would let one buggy, one-time malformed submission permanently poison that
 * commandId: a client that fixes its bug and resubmits the SAME id with a NOW-valid
 * envelope would come back `COMMAND_ID_REUSE_MISMATCH` forever, even though the
 * malformed attempt was never a command to begin with. So a decode failure returns
 * straight out of `dispatch()`, below, without the dedupe ledger ever being consulted —
 * see `dispatch.test.ts`'s "a malformed envelope never poisons the dedupe ledger" test.
 *
 * A decode failure is returned as the raw `CommandDecodeError`, not shoehorned into a
 * `RejectedCommandV1`: §8.3's `RejectedCommandV1.commandId` is a `UUIDv7`, and a
 * completely malformed envelope (a missing/malformed `commandId` field, most acutely)
 * may not have one to report. Deciding what — if anything — to echo back to a caller
 * that sent unparseable bytes is a transport-layer concern outside the Kernel's typed
 * DTO contract, not something this module invents a placeholder id for.
 */

/**
 * A 6C-supplied dependency (`extractTarget`, `evaluateGuard`, `readKernelState`, `handle`)
 * threw. These are uncontrolled code at this module's boundary, so their failures become
 * values here rather than escaping `dispatch`'s declared `Error | T` return.
 */
export class MailboxHandlerError extends errore.createTaggedError({
  name: "MailboxHandlerError",
  message: "dispatching $kind threw",
}) {}

export interface DispatchDeps {
  readonly counters: KernelCounters;
  readonly dedupeLedger: DedupeLedger;
  readonly eventBus: EventBus;
  readonly cancelProbe: TurnCancelProbe;
  /** §10.2's `currentKernelState`, read fresh on every command — see `../types`. */
  readonly readKernelState: () => KernelStateSnapshot;
  readonly extractTarget: TargetExtractor;
  readonly evaluateGuard: GuardRegistry;
  readonly handle: HandlerRegistry;
}

export interface Dispatch {
  readonly dispatch: (
    raw: unknown,
  ) => Promise<CommandDecodeError | CanonicalHashError | CommandResultV1>;
}

/**
 * Creates one Kernel's dispatch pipeline. Like `createDedupeLedger`/`createEventBus`/
 * `createKernelCounters`, this must be constructed inside an active Reatom
 * `context.start(...)` frame — it `wrap`s the dedupe ledger's asynchronous re-entry
 * (`runFirstSeenWrapped`/`finalizeResultWrapped`, below) against whatever frame is
 * active right here, right now, at construction time.
 */
export function createDispatch(deps: DispatchDeps): Dispatch {
  /**
   * Steps 4-5: call the handler, then — unless it reports no change — advance the revision
   * and publish. The revision CHECK and the GUARD (both pure reads, §8.4/§10.2) already ran
   * before this is called; see `runFirstSeen` below.
   *
   * A PLAIN FUNCTION, deliberately, not a Reatom `action`. §6's "within one Reatom
   * transaction frame" is already satisfied here without one: this body is entirely
   * synchronous, and Reatom v1001 coalesces every write in a single synchronous tick into
   * one notification regardless of whether an outer action wraps them. Measured on the
   * installed version — a computed observing two atoms written by two inner actions
   * notifies exactly once either way, and an action frame does NOT roll its writes back
   * when the body throws. So an outer action would buy only a trace name while implying a
   * transactional guarantee it does not provide.
   *
   * The atoms this touches belong to other units that already own their own named actions
   * (`kernel.advanceRevision`, `mailbox.publishTransition`, and in 6C each state machine's
   * transition), which is where the trace names that matter live.
   */
  function applyTransition(
    envelope: CommandEnvelopeV1,
    currentRevision: UInt64String,
  ): CommandResultV1 {
    const outcome = deps.handle(envelope);

    if (outcome.disposition === "no-op") {
      if (outcome.events.length > 0) {
        // §8.3 ties "no-op" to no transition; §9 ties every domain event to one that
        // DID happen. A handler returning both is a 6C contract violation this module
        // cannot represent in `CommandResultV1` (there is no rejection code for "the
        // handler misbehaved") — logged per the errore rule against silently swallowing
        // an error that is not otherwise propagated, then the events are discarded.
        console.warn(
          `core/mailbox: handler for "${envelope.kind}" returned events with disposition "no-op" — discarding them`,
        );
      }
      return accepted(
        envelope.commandId,
        currentRevision,
        currentRevision,
        "no-op",
        outcome.operationId,
      );
    }

    const resultingRevision = deps.counters.advanceRevision();
    const published = deps.eventBus.publishTransition(outcome.events);
    if (published instanceof Error) {
      // The revision has already moved by this point, and nothing in this pipeline can
      // roll a committed Reatom transition back. `publishTransition` failing here means
      // a handler (6C) produced an event payload that does not match its own kind's
      // schema — a contract violation on the PRODUCER's side, not a reachable protocol
      // outcome for a well-formed Kernel. Logged loudly rather than swallowed; the
      // accepted result still reflects the state change that genuinely occurred.
      console.error(
        `core/mailbox: publishTransition rejected "${envelope.kind}"'s events after the revision already ` +
          `advanced to ${resultingRevision}:`,
        published.message,
      );
    }

    return accepted(
      envelope.commandId,
      currentRevision,
      resultingRevision,
      outcome.disposition,
      outcome.operationId,
    );
  }

  /**
   * Steps 2 (its revision-check half)-5 for a first-seen command. Pure orchestration
   * up to `applyTransition`; nothing here writes an atom on its own.
   *
   * Every injected dependency below — `extractTarget`, `evaluateGuard`, `readKernelState`,
   * `handle` — is 6C's code from this module's point of view, i.e. uncontrolled at this
   * boundary, so a throw from any of them is converted to a value here (errore rule 12).
   * Letting it propagate would break the declared `Error | T` return AND do lasting damage:
   * `dedupe-ledger` stores the in-flight promise BEFORE execution, so a rejected promise
   * stays recorded, and every later retry of that same `commandId` would inherit the
   * rejection even after the handler was fixed. That is exactly the permanent-poisoning
   * failure the DECODE BEFORE DEDUPE note above guards against, one step further in.
   */
  function runFirstSeen(envelope: CommandEnvelopeV1): CommandResultV1 {
    const outcome = errore.try({
      try: () => runFirstSeenUnguarded(envelope),
      catch: (cause: Error) => new MailboxHandlerError({ kind: envelope.kind, cause }),
    });
    if (outcome instanceof Error) {
      // Not silently swallowed (errore rule 21): a handler that throws is a 6C contract
      // violation the caller cannot act on, so it is logged loudly and reported as the
      // §11.1 typed fallback rather than as a protocol-level rejection code that would
      // misattribute the failure to the command.
      console.error(`core/mailbox: dispatch of "${envelope.kind}" threw:`, outcome.message);
      return rejected(envelope.commandId, deps.counters.stateRevision(), "CAPABILITY_UNAVAILABLE", [
        { code: "CAPABILITY_UNAVAILABLE" },
      ]);
    }
    return outcome;
  }

  function runFirstSeenUnguarded(envelope: CommandEnvelopeV1): CommandResultV1 {
    const currentRevision = deps.counters.stateRevision();

    const revisionDecision = checkRevisionGuard({
      command: toRevisionGuardCommand(envelope),
      currentRevision,
      cancelProbe: deps.cancelProbe,
    });

    if (revisionDecision.kind === "rejected") {
      return rejected(envelope.commandId, revisionDecision.currentRevision, revisionDecision.code, [
        buildRevisionRejectionReason(revisionDecision, deps.cancelProbe),
      ]);
    }

    if (revisionDecision.kind === "accepted-no-op") {
      // §8.4 rule 4: a repeat `turn.cancel` while stopping/terminalizing "returns
      // accepted no-op for the same turn" — no guard, no handler, no revision change,
      // no event; the guard/handler steps below are skipped entirely for this path.
      return accepted(envelope.commandId, currentRevision, currentRevision, "no-op");
    }

    // §12.1 step 3.
    const target = deps.extractTarget(envelope.kind, envelope.payload);
    const guardDecision = deps.evaluateGuard(envelope.kind, target, deps.readKernelState());

    if (!guardDecision.available) {
      // "A failure records and returns Rejected without a model transition" — recording
      // happens implicitly: this return value IS what the dedupe ledger records for
      // `envelope.commandId` (see `dispatch`, below).
      return rejected(
        envelope.commandId,
        currentRevision,
        primaryReason(guardDecision.reasons).code,
        guardDecision.reasons,
      );
    }

    return applyTransition(envelope, currentRevision);
  }

  // `dedupeLedger.run` always defers `execute` by at least one microtask
  // (`Promise.resolve().then(execute)`, `dedupe-ledger.ts`), and its own returned
  // promise resolves through another `.then` on top of that — TWO async boundaries
  // re-entering Reatom (`applyTransition` writes atoms; `toDedupeRejection`, below,
  // reads `counters.stateRevision()`), which the project's binding Reatom rule requires
  // `wrap` at, independently, since nothing guarantees they run in the same microtask.
  // Both wraps are captured ONCE here, at `createDispatch`'s own construction time —
  // not fresh inside every `dispatch()` call — because there is exactly one Kernel
  // Reatom context for this mailbox's whole process lifetime (§5's "Kernel Reatom
  // context" row), and every command must land in THAT context no matter what
  // non-Reatom code (an IPC handler, a test) happens to call `dispatch()` from, or how
  // long after construction it does so.
  const runFirstSeenWrapped = wrap(runFirstSeen);
  const finalizeResultWrapped = wrap(
    (outcome: CanonicalHashError | DedupeRejectionError | CommandResultV1) =>
      outcome instanceof DedupeRejectionError ? toDedupeRejection(outcome, deps.counters) : outcome,
  );

  function dispatch(
    raw: unknown,
  ): Promise<CommandDecodeError | CanonicalHashError | CommandResultV1> {
    // Step 2, first clause — see this file's module comment for why this must finish,
    // successfully, before the dedupe ledger is ever consulted.
    const envelope = decodeCommandEnvelope(raw);
    if (envelope instanceof Error) return Promise.resolve(envelope);

    // Step 2's remaining two clauses, plus steps 3-5, all happen inside `runFirstSeen`
    // — but ONLY for a first-seen `commandId`. `dedupeLedger.run` short-circuits a
    // duplicate straight to the stored result, per §8.5/§9: "A duplicate command result
    // does not replay prior events" and performs no revision check of its own.
    return deps.dedupeLedger
      .run(raw, envelope.commandId, () => Promise.resolve(runFirstSeenWrapped(envelope)))
      .then(finalizeResultWrapped);
  }

  return { dispatch };
}

function accepted(
  commandId: UUIDv7,
  acceptedRevision: UInt64String,
  resultingRevision: UInt64String,
  disposition: "completed" | "started" | "no-op",
  operationId?: UUIDv7,
): AcceptedCommandV1 {
  const base = {
    protocolVersion: 1 as const,
    commandId,
    status: "accepted" as const,
    acceptedRevision,
    resultingRevision,
    disposition,
  };
  return operationId === undefined ? base : { ...base, operationId };
}

function rejected(
  commandId: UUIDv7,
  currentRevision: UInt64String,
  code: CommandRejectionCode,
  reasons: readonly [UnavailableReason, ...UnavailableReason[]],
): RejectedCommandV1 {
  return { protocolVersion: 1, commandId, status: "rejected", currentRevision, code, reasons };
}

/**
 * `turn.cancel`'s payload is `{ turnId }` (§8.2, `command-payload.ts`'s
 * `turnCancelPayloadSchema`) — already validated by `decodeCommandEnvelope` before this
 * runs. `CommandEnvelopeV1` (the type `decodeCommandEnvelope` returns) is not a
 * discriminated union correlating `kind` with `payload`'s exact shape, so narrowing past
 * the `kind` check still needs one cast; it re-states a fact decode already checked, it
 * does not re-validate anything.
 */
function toRevisionGuardCommand(envelope: CommandEnvelopeV1): RevisionGuardCommand {
  if (envelope.kind !== "turn.cancel") {
    return { kind: envelope.kind, expectedRevision: envelope.expectedRevision };
  }
  const payload = envelope.payload as CommandPayloadByKindV1["turn.cancel"];
  return {
    kind: "turn.cancel",
    expectedRevision: envelope.expectedRevision,
    turnId: payload.turnId,
  };
}

/**
 * Expands `checkRevisionGuard`'s compact `{code, currentRevision}` decision into a full
 * `UnavailableReason` DTO. `STALE_REVISION` and `TURN_NOT_ACTIVE` need nothing beyond
 * what the decision already carries; `TURN_ID_MISMATCH`/`CANCEL_TOO_LATE` both name the
 * ACTIVE turn's id in their reason (matching `TURN_ALREADY_ACTIVE`/`TURN_RUNNING`'s same
 * pattern in `unavailable-reason.ts`) — `revision-guard.ts`'s decision does not carry
 * that id, so it is re-read from the same injected probe `checkRevisionGuard` itself
 * just consulted, exhaustively switched over `RevisionGuardRejectionCode`'s four values.
 */
function buildRevisionRejectionReason(
  decision: Extract<RevisionGuardDecision, { kind: "rejected" }>,
  cancelProbe: TurnCancelProbe,
): UnavailableReason {
  switch (decision.code) {
    case "STALE_REVISION":
      return { code: "STALE_REVISION", requiredRevision: decision.currentRevision };
    case "TURN_NOT_ACTIVE":
      return { code: "TURN_NOT_ACTIVE" };
    case "TURN_ID_MISMATCH":
    case "CANCEL_TOO_LATE": {
      // Both codes only fire when `checkRevisionGuard` already confirmed a turn is
      // active (its own rules 5/6) — re-consulting the same probe here is cheap and
      // keeps this module from inventing a turnId the guard itself did not report.
      const active = cancelProbe.activeTurn();
      if (active === null) {
        console.warn(
          `core/mailbox: cancel probe reported no active turn while building a ${decision.code} reason`,
        );
        return { code: "CAPABILITY_UNAVAILABLE" };
      }
      return { code: decision.code, turnId: active.turnId };
    }
  }
}

/**
 * §8.5's three dedupe rejection codes are all `detailsFreeReason`s (`unavailable-reason.ts`)
 * — `{code}`, nothing more. `err.code`'s declared type is `string | number`, not
 * `DedupeRejectionCode`: every `$variable` in an `errore.createTaggedError` message
 * template is typed that widely by the library itself (`VarProps` in its own `.d.ts`),
 * regardless of what `dedupe-ledger.ts` actually constructs it with at each call site.
 * The `if` chain below re-narrows it at the value level; the trailing fallback exists
 * only for a `DedupeRejectionError` this module did not itself construct and cannot
 * trust blindly — logged per the errore rule against silently swallowing a value that
 * does not fit, not because `dedupe-ledger.ts` is expected to ever produce it today.
 */
function toDedupeRejection(err: DedupeRejectionError, counters: KernelCounters): RejectedCommandV1 {
  const reason = dedupeReasonFor(err.code);
  // `err.commandId` is `string | number` for the same `VarProps` reason as `err.code`
  // above; `dedupe-ledger.ts`'s `reject()` only ever constructs it from an already
  // `UUIDv7`-typed parameter, so this narrows a fact the type system cannot see, not a
  // real runtime possibility.
  return rejected(err.commandId as UUIDv7, counters.stateRevision(), reason.code, [reason]);
}

function dedupeReasonFor(code: string | number): UnavailableReason {
  if (code === "COMMAND_ID_REUSE_MISMATCH") return { code };
  if (code === "COMMAND_ID_EXPIRED") return { code };
  if (code === "COMMAND_DEDUPE_CAPACITY") return { code };
  console.warn(
    `core/mailbox: unexpected dedupe rejection code "${String(code)}" — falling back to CAPABILITY_UNAVAILABLE`,
  );
  return { code: "CAPABILITY_UNAVAILABLE" };
}
