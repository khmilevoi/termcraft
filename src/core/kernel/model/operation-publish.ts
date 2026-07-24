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
 * REVISION SEMANTICS (unchanged from `launchOperation`'s own documented rule, `kernel.ts`'s
 * report appendix): the revision advances IF AND ONLY IF `events` is non-empty — never a
 * bare, unexplained bump. This is deliberately narrower than `dispatch.ts`'s own SYNCHRONOUS
 * rule (`applyTransition` advances on disposition alone, even for a zero-event admission),
 * because an async completion (or a mid-operation tick) that genuinely has nothing to publish
 * must not silently bump `stateRevision` with no event to explain it — see `kernel.ts`'s own
 * report appendix for the full argument this reuses verbatim.
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
