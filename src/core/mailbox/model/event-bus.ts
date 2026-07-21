import { action } from "@reatom/core";
import * as errore from "errore";
import type { z } from "zod";

import type { KernelCounters } from "core/kernel/model/counters";
import {
  type EventKindV1,
  type EventPayloadByKindV1,
  type UInt64String,
  type UUIDv7,
  eventPayloadV1SchemaByKind,
  isEventKindV1,
} from "core/protocol";

/**
 * The Kernel's in-process control-event mailbox (kernel-command-contract §9, §13.3).
 *
 * Publication and subscription are the whole job: assign `eventSeq`/`stateRevision`
 * to events a caller hands it, deliver them to every current subscriber in one
 * contiguous run per transition, and hand a fresh subscriber a `kernel.snapshot`
 * before anything else. It has no opinion about WHICH events a transition produces or
 * WHETHER a command was accepted — §9: "A rejected command emits no domain event";
 * that decision is the mailbox's caller's, not this bus's. This file only enforces
 * the mechanism once the caller has decided to publish.
 */

/**
 * The 14 optional correlation identities `EventEnvelopeV1.correlation` carries
 * (§9, KCC:767-782), transcribed verbatim. `core/protocol` does not export this shape
 * yet — no `event-envelope.ts` exists there today, only the payload side (§9's
 * `EventPayloadByKindV1`) has landed — so it lives here, in the one module that
 * currently needs it, rather than being invented a second time under a different
 * name later. A future `core/protocol/model/event-envelope.ts` should absorb both this
 * type and `EventEnvelopeV1` below; nothing in either is mailbox-specific.
 */
export interface EventCorrelationV1 {
  readonly commandId?: UUIDv7;
  readonly operationId?: UUIDv7;
  readonly transactionId?: UUIDv7;
  readonly turnId?: UUIDv7;
  readonly pageRemovePlanId?: UUIDv7;
  readonly restorePlanId?: UUIDv7;
  readonly restoreActionId?: UUIDv7;
  readonly commitPlanId?: UUIDv7;
  readonly migrationPlanId?: UUIDv7;
  readonly migrationActionId?: UUIDv7;
  readonly previewSessionId?: UUIDv7;
  readonly frameTokenId?: UUIDv7;
  readonly geometryTokenId?: UUIDv7;
  readonly pinId?: UUIDv7;
}

/**
 * The control-event envelope (§9, KCC:761-784) — see `EventCorrelationV1`'s comment
 * for why it is declared here rather than in `core/protocol`. `stateRevision` and
 * `eventSeq` are always the mailbox's own counters, never caller-supplied: §9 states
 * "The mailbox assigns `eventSeq` at publication," and `PublishableEventV1` below
 * mirrors that by never accepting either field as input in the first place.
 */
export interface EventEnvelopeV1<K extends EventKindV1 = EventKindV1> {
  readonly protocolVersion: 1;
  readonly kernelInstanceId: UUIDv7;
  readonly eventSeq: UInt64String;
  readonly stateRevision: UInt64String;
  readonly kind: K;
  readonly correlation?: EventCorrelationV1;
  readonly payload: EventPayloadByKindV1[K];
}

/**
 * One event a caller wants published as part of a transition. Deliberately missing
 * `eventSeq`/`stateRevision`/`kernelInstanceId` — publication is what stamps those
 * (§9) — so there is no field here through which a caller could smuggle a
 * caller-chosen sequence number into the stream.
 */
export interface PublishableEventV1<K extends EventKindV1 = EventKindV1> {
  readonly kind: K;
  readonly payload: EventPayloadByKindV1[K];
  readonly correlation?: EventCorrelationV1;
}

/**
 * Raised when a caller asks the bus to publish an event whose payload does not
 * satisfy `eventPayloadV1SchemaByKind` for its own `kind` (or whose `kind` is not a
 * known `EventKindV1` at all). §9: an unmapped/invalid payload "is a protocol error
 * inside the same-version in-process implementation" — this is that error, raised at
 * the boundary between an internal producer and the mirror-facing stream so a
 * malformed DTO is caught here rather than reaching a subscriber.
 */
export class EventBusPayloadError extends errore.createTaggedError({
  name: "EventBusPayloadError",
  message: "event payload for $kind rejected: $reason",
}) {}

/**
 * A subscriber callback threw. Subscribers are uncontrolled code at a boundary, so their
 * failures are converted to values here and logged rather than propagated: one broken
 * mirror must not stop delivery to the others, and it must never wedge the bus.
 */
export class EventBusSubscriberError extends errore.createTaggedError({
  name: "EventBusSubscriberError",
  message: "subscriber threw while handling $kind",
}) {}

/**
 * `kernel.snapshot`'s payload (§9, KCC:793) needs "all seven model snapshots" and
 * "complete capabilities" — 6C's `reatom*StateMachine` factories and capability
 * projection, which do not exist yet. This factory takes a provider for exactly that
 * remaining part: everything in the payload EXCEPT `eventSeq`. The bus itself owns
 * `eventSeq` the same way it owns every other envelope's (see `EventEnvelopeV1`'s
 * comment) and stamps it fresh on every snapshot delivery, so 6C's provider never has
 * to reach into the counters to keep that field honest.
 */
export interface EventBusDeps {
  readonly counters: KernelCounters;
  readonly buildSnapshotPayload: () => Omit<EventPayloadByKindV1["kernel.snapshot"], "eventSeq">;
}

export interface EventBus {
  /**
   * Publishes the events produced by one atomic transition as a single contiguous
   * run (§9: "Events produced by one transition are enqueued contiguously before the
   * next command or internal signal is handled"). Every event in `events` shares one
   * `stateRevision`, read once at the start of the run — callers producing a
   * progress-only run (§9: "Progress events increment only `eventSeq`") simply do not
   * call `counters.advanceRevision()` before publishing, and the run picks up
   * whatever `stateRevision` is already current. Returns the stamped envelopes, or an
   * `EventBusPayloadError` — publishing NOTHING — if any payload fails its kind's
   * schema; a partially-published transition would break the "several events
   * therefore carry the same `stateRevision`" guarantee for anything reading the tail.
   */
  readonly publishTransition: (
    events: readonly PublishableEventV1[],
  ) => EventBusPayloadError | readonly EventEnvelopeV1[];
  /**
   * Registers `handler` and immediately — synchronously, before returning — delivers
   * one `kernel.snapshot` envelope built from the injected provider and the counters'
   * CURRENT values, not a fresh assignment: attaching a subscriber is not itself a
   * transition. Only events published after this call reach `handler`; §9: "There is
   * no event-resume token, replay buffer, or reconnect promise in v1," so a late
   * subscriber never sees what came before its own snapshot. Returns an unsubscribe
   * function, or an `EventBusPayloadError` if the injected snapshot provider's own
   * payload fails its schema.
   */
  readonly subscribe: (
    handler: (envelope: EventEnvelopeV1) => void,
  ) => EventBusPayloadError | (() => void);
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "invalid payload";
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
}

/** Validates every event's payload before ANY of them is stamped — see `publishTransition`'s comment on why this is all-or-nothing. */
function validateBatch(
  events: readonly PublishableEventV1[],
): EventBusPayloadError | readonly PublishableEventV1[] {
  for (const event of events) {
    if (!isEventKindV1(event.kind)) {
      return new EventBusPayloadError({
        kind: String(event.kind),
        reason: `unknown event kind "${String(event.kind)}"`,
      });
    }
    const schema = eventPayloadV1SchemaByKind[event.kind];
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) {
      return new EventBusPayloadError({ kind: event.kind, reason: firstIssue(parsed.error) });
    }
  }
  return events;
}

function buildEnvelope(
  event: PublishableEventV1,
  kernelInstanceId: UUIDv7,
  stateRevision: UInt64String,
  eventSeq: UInt64String,
): EventEnvelopeV1 {
  const envelope: EventEnvelopeV1 = {
    protocolVersion: 1,
    kernelInstanceId,
    eventSeq,
    stateRevision,
    kind: event.kind,
    payload: event.payload,
  };
  return event.correlation === undefined
    ? envelope
    : { ...envelope, correlation: event.correlation };
}

/**
 * Creates one Kernel's in-process event bus. A factory, not module-level state, for
 * the same reason as `createKernelCounters`: it is scoped to a single Kernel process
 * lifetime, and module-level subscriber/queue state would let two kernels in one
 * process — or one test after another — leak events into each other.
 *
 * Must be constructed and driven inside an active Reatom `context.start(...)` frame:
 * `publishTransition` is a named action (the transition it stamps touches the
 * counters' atoms via their own named actions), matching the "a transition touching
 * several atoms is ONE named action" rule.
 */
export function createEventBus({ counters, buildSnapshotPayload }: EventBusDeps): EventBus {
  const subscribers = new Set<(envelope: EventEnvelopeV1) => void>();

  // A queue of already-VALIDATED batches, plus a re-entrancy guard. Both exist to
  // satisfy "events produced by one transition are enqueued contiguously": a
  // subscriber handler can synchronously call `publishTransition` again while THIS
  // run is still notifying subscribers (for example, reacting to a transition's
  // first event by kicking off another transition). Without the guard, that nested
  // call would start emitting its own events interleaved inside the current run's
  // `for` loop. Queuing instead defers the nested run until the current run's `while`
  // loop below comes back around for another batch — so the nested transition's
  // events still arrive as one contiguous group, right after the run that triggered
  // it, never spliced into its middle.
  const pendingBatches: (readonly PublishableEventV1[])[] = [];
  let isDraining = false;

  function notify(envelope: EventEnvelopeV1): void {
    // Iterate a SNAPSHOT of the subscriber set. A handler that subscribes from inside its
    // own callback would otherwise be visited by this same loop — JS `Set` iteration sees
    // elements added during iteration — and would receive its snapshot (already reflecting
    // the current event) plus the very same event again, breaking §9's "then subsequent
    // events" and §13.3's strict eventSeq monotonicity for that subscriber's stream.
    for (const handler of [...subscribers]) deliver(handler, envelope);
  }

  /**
   * Calls one subscriber, converting a throw into a logged value.
   *
   * A subscriber is uncontrolled code at a boundary. Letting it throw would unwind out of
   * drain() past `isDraining = false`, wedging the flag true and turning every later
   * publish into a silent no-op — the whole Kernel event stream lost without a trace. One
   * broken mirror must not stop delivery to the others, and per errore rule 21 an error
   * that is not propagated still has to leave a trace.
   */
  function deliver(handler: (envelope: EventEnvelopeV1) => void, envelope: EventEnvelopeV1): void {
    const failure = errore.try({
      try: () => handler(envelope),
      catch: (cause: Error) => new EventBusSubscriberError({ kind: envelope.kind, cause }),
    });
    if (failure instanceof Error) {
      console.warn(`core/mailbox: subscriber threw on ${envelope.kind}:`, failure.message);
    }
  }

  function drain(): readonly EventEnvelopeV1[] {
    isDraining = true;
    try {
      return drainBatches();
    } finally {
      // `finally`, not a trailing assignment: see the notify() comment — an escaping
      // throw would otherwise leave the bus permanently wedged.
      isDraining = false;
    }
  }

  function drainBatches(): readonly EventEnvelopeV1[] {
    const emitted: EventEnvelopeV1[] = [];
    for (let batch = pendingBatches.shift(); batch !== undefined; batch = pendingBatches.shift()) {
      // Read ONCE per batch: "their stateRevision is the revision after that
      // transition" (§9) — every event in this batch shares it. Reading it fresh per
      // batch, rather than once for the whole drain, is what lets a nested
      // transition queued mid-drain (see the comment above) carry a DIFFERENT
      // revision if its caller advanced one in between.
      const stateRevision = counters.stateRevision();
      for (const event of batch) {
        const envelope = buildEnvelope(
          event,
          counters.kernelInstanceId,
          stateRevision,
          counters.nextEventSeq(),
        );
        emitted.push(envelope);
        notify(envelope);
      }
    }
    return emitted;
  }

  const publishTransition = action((events: readonly PublishableEventV1[]) => {
    const validated = validateBatch(events);
    if (validated instanceof Error) return validated;

    pendingBatches.push(validated);
    // A nested call arriving while `drain()` is already running does not drain
    // itself — see the `pendingBatches` comment above. Its own envelopes are not
    // known yet at this point (the active `drain()` call will produce them once its
    // `while` loop reaches this batch), so it returns an empty array here rather
    // than a promise-like placeholder; subscribers still receive its events, in
    // order, immediately after the currently-draining transition finishes.
    if (isDraining) return [] as readonly EventEnvelopeV1[];

    return drain();
  }, "mailbox.publishTransition");

  function subscribe(
    handler: (envelope: EventEnvelopeV1) => void,
  ): EventBusPayloadError | (() => void) {
    const snapshotPayload = { ...buildSnapshotPayload(), eventSeq: counters.eventSeq() };
    const parsed = eventPayloadV1SchemaByKind["kernel.snapshot"].safeParse(snapshotPayload);
    if (!parsed.success) {
      return new EventBusPayloadError({
        kind: "kernel.snapshot",
        reason: firstIssue(parsed.error),
      });
    }

    // Delivered through the same protected path as live events. A subscriber that throws
    // on its very first callback would otherwise take down subscribe() itself, so a
    // single broken mirror could not even be registered — and the caller would get an
    // exception where its signature promises an `Error | unsubscribe` value.
    deliver(handler, {
      protocolVersion: 1,
      kernelInstanceId: counters.kernelInstanceId,
      eventSeq: counters.eventSeq(),
      stateRevision: counters.stateRevision(),
      kind: "kernel.snapshot",
      payload: parsed.data,
    });

    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  }

  return { publishTransition, subscribe };
}
