import type {
  EventBus,
  EventBusPayloadError,
  EventEnvelopeV1,
  PublishableEventV1,
} from "core/mailbox";

import type { KernelCounters } from "./counters";

/**
 * The shared revision/publish semantics `kernel.ts`'s own `runLaunchedOperation`
 * (`launchOperation`'s terminal batch, one call per launched operation, at settlement) and
 * `publishOperationEvent` (`HandlerContext`'s live-publish primitive, kernel-assembly Task 9
 * Step C3 deliverable B — `RunTurnDeps.publish` streams `turn.attemptStarted`/`turn.progress`/
 * `turn.gateRejected` DURING a running turn, `core/turns/model/run-turn.ts:233`/`:314`, which
 * `launchOperation`'s own one-shot terminal batch cannot carry) both call, rather than each
 * hand-rolling its own copy of "advance iff non-empty, then publish through the SAME bus."
 *
 * REVISION SEMANTICS: the revision advances IF AND ONLY IF `events` is non-empty — never a
 * bare, unexplained bump, because "a revision bump is always explained by at least one published
 * event" is what every client recovering from `STALE_REVISION` relies on.
 *
 * THE SYNCHRONOUS HALF NOW STATES THE SAME RULE (2026-07-28, `dispatch.ts`'s own bump site).
 * This comment used to describe the async rule as deliberately NARROWER than `dispatch.ts`'s,
 * which advanced on the handler's disposition alone; that deviation was a live defect, not a
 * design — a zero-event `startedOutcome([])` moved the Kernel forward and published nothing, and
 * since the UI mirror learns revisions only from published envelopes it could never catch up.
 * Under KCC §6's Global Constraint "the transition changed authoritative state" and "there is an
 * event to publish" are the same predicate, so both halves of the Kernel state ONE invariant.
 *
 * CALLABLE ANY NUMBER OF TIMES. Unlike `launchOperation`'s own terminal call (exactly once,
 * when `run()` settles), the live-publish primitive may call this any number of times over
 * one operation's lifetime — each call is independent: its own revision bump (if any), its
 * own batch through the SAME `EventBus.publishTransition` every other event (synchronous
 * admission, a terminal batch, capability growth) already goes through, never a second,
 * parallel publish path.
 */
export interface OperationPublishDeps {
  readonly counters: KernelCounters;
  readonly eventBus: EventBus;
}

/**
 * `null` means "there was nothing to publish" (an empty `events` array) — distinct from
 * `EventBusPayloadError` (a real, if provably-unreachable-in-practice, schema failure) and
 * from a non-empty envelope array (the ordinary success case). Callers branch on all three:
 * `null` -> nothing to log or react to; `Error` -> log (the failure is never silently
 * dropped); an array -> the published envelopes, if a caller needs them.
 */
export function publishOperationEvents(
  deps: OperationPublishDeps,
  events: readonly PublishableEventV1[],
): EventBusPayloadError | readonly EventEnvelopeV1[] | null {
  if (events.length === 0) return null;
  deps.counters.advanceRevision();
  return deps.eventBus.publishTransition(events);
}
