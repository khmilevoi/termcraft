import { describe, expect, test } from "bun:test"
import { context } from "@reatom/core"

import type { EventPayloadByKindV1 } from "core/protocol"
import { createKernelCounters } from "core/kernel/model/counters"
import { uuidv7 } from "infrastructure/uuid"

import { createEventBus, type EventEnvelopeV1, type PublishableEventV1 } from "./event-bus"

/**
 * Unwraps a test result, failing loudly instead of continuing on bad setup. Typed as
 * `Exclude<T, Error>` rather than the more obvious `(result: Error | T) => T` — with an
 * unconstrained `T`, TS's inference for a UNION parameter shape widens `T` to the
 * whole argument type instead of the non-`Error` branch, silently defeating the
 * narrowing this helper exists for.
 */
function unwrap<T>(result: T): Exclude<T, Error> {
  if (result instanceof Error) throw result
  return result as Exclude<T, Error>
}

/**
 * A minimal valid `kernel.snapshot` payload MINUS `eventSeq` — the bus owns that field
 * (see `event-bus.ts`'s `EventBusDeps` comment) and stamps it itself. Every other field
 * here is the smallest value that satisfies `kernelSnapshotPayloadV1Schema`.
 */
function fakeSnapshotPayload(): Omit<EventPayloadByKindV1["kernel.snapshot"], "eventSeq"> {
  return {
    models: {
      project: null,
      turn: null,
      restore: null,
      commit: null,
      export: null,
      preview: null,
      migration: null,
    },
    projectId: null,
    activePageSlug: null,
    activeChatId: null,
    trust: null,
    capabilities: [],
    pageDescriptors: [],
    gitStatus: { repositoryId: "repo", head: null, sequencerState: "none", scopes: {} },
  }
}

/** A trivial, always-schema-valid event: `selection.changed`'s payload may be bare `null`. */
function selectionEvent(correlation?: PublishableEventV1["correlation"]): PublishableEventV1<"selection.changed"> {
  return { kind: "selection.changed", payload: null, correlation }
}

describe("createEventBus", () => {
  test("eventSeq strictly increases across mixed state/progress events", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })

      counters.advanceRevision() // an authoritative transition
      const stateEnvelopes = unwrap(bus.publishTransition([selectionEvent(), selectionEvent()]))
      // no advanceRevision here — models a progress-only run
      const progressEnvelopes = unwrap(bus.publishTransition([selectionEvent()]))

      const seqs = [...stateEnvelopes, ...progressEnvelopes].map((e) => e.eventSeq)
      expect(seqs).toEqual(["1", "2", "3"])
    })
  })

  test("several events from one transition share one stateRevision", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })

      counters.advanceRevision()
      const envelopes = unwrap(bus.publishTransition([selectionEvent(), selectionEvent(), selectionEvent()]))

      expect(envelopes.map((e) => e.stateRevision)).toEqual(["1", "1", "1"])
    })
  })

  test("a subscriber receives one kernel.snapshot before any live event", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })
      const received: EventEnvelopeV1[] = []

      const unsubscribe = unwrap(bus.subscribe((envelope) => received.push(envelope)))
      unwrap(bus.publishTransition([selectionEvent()]))

      expect(received.length).toBe(2)
      expect(received[0]?.kind).toBe("kernel.snapshot")
      expect(received.filter((e) => e.kind === "kernel.snapshot")).toHaveLength(1)
      unsubscribe()
    })
  })

  test("a late subscriber gets a CURRENT snapshot, not a replay of earlier events", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })

      counters.advanceRevision()
      unwrap(bus.publishTransition([selectionEvent(), selectionEvent()])) // eventSeq 1, 2 — before anyone subscribes

      const received: EventEnvelopeV1[] = []
      unwrap(bus.subscribe((envelope) => received.push(envelope)))

      expect(received).toHaveLength(1)
      expect(received[0]?.kind).toBe("kernel.snapshot")
      expect(received[0]?.eventSeq).toBe("2") // current eventSeq, not a re-delivery of 1 and 2
    })
  })

  test("unsubscribe stops delivery", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })
      const received: EventEnvelopeV1[] = []

      const unsubscribe = unwrap(bus.subscribe((envelope) => received.push(envelope)))
      unsubscribe()
      unwrap(bus.publishTransition([selectionEvent()]))

      expect(received).toHaveLength(1) // only the initial snapshot
    })
  })

  test("two transitions do not interleave", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })
      const idA = uuidv7()
      const idB = uuidv7()
      const order: string[] = []
      let triggeredNested = false

      unwrap(
        bus.subscribe((envelope) => {
          if (envelope.kind === "kernel.snapshot") return
          const label = envelope.correlation?.commandId === idA ? "A" : "B"
          order.push(label)
          // On transition A's very first event, synchronously publish a second
          // transition from inside the subscriber callback — the only way to force
          // reentrancy in single-threaded JS without real concurrency.
          if (!triggeredNested && label === "A" && order.length === 1) {
            triggeredNested = true
            unwrap(bus.publishTransition([selectionEvent({ commandId: idB }), selectionEvent({ commandId: idB })]))
          }
        }),
      )

      counters.advanceRevision()
      unwrap(
        bus.publishTransition([
          selectionEvent({ commandId: idA }),
          selectionEvent({ commandId: idA }),
          selectionEvent({ commandId: idA }),
        ]),
      )

      expect(order).toEqual(["A", "A", "A", "B", "B"])
    })
  })

  test("a payload that fails its kind schema is rejected rather than published", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })
      const received: EventEnvelopeV1[] = []
      unwrap(bus.subscribe((envelope) => received.push(envelope)))

      // selectionChangedPayloadV1Schema is `selectionDtoV1Schema.nullable()` — a bare
      // `{ pageSlug }` satisfies neither the `null` branch nor the full DTO shape.
      const badEvent = {
        kind: "selection.changed",
        payload: { pageSlug: "x" },
      } as unknown as PublishableEventV1<"selection.changed">

      const result = bus.publishTransition([badEvent])
      expect(result instanceof Error).toBe(true)
      expect(received).toHaveLength(1) // only the initial snapshot; nothing was published

      // The rejected publish must not have burned an eventSeq: the next valid publish
      // still starts at "1".
      const followUp = unwrap(bus.publishTransition([selectionEvent()]))
      expect(followUp[0]?.eventSeq).toBe("1")
    })
  })

  // --- Regression tests for the review's Critical/Important findings -----------------

  test("a throwing subscriber does not wedge the bus or stop delivery to the others", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })

      const healthy: EventEnvelopeV1[] = []
      unwrap(
        bus.subscribe(() => {
          throw new Error("mirror exploded")
        }),
      )
      unwrap(bus.subscribe((envelope) => healthy.push(envelope)))

      // Without try/finally around drain, the first throw would unwind past
      // `isDraining = false` and every later publish would silently emit nothing.
      const first = unwrap(bus.publishTransition([selectionEvent()]))
      const second = unwrap(bus.publishTransition([selectionEvent()]))

      expect(first).toHaveLength(1)
      expect(second).toHaveLength(1)
      // snapshot + two live events — the healthy mirror is unaffected by its noisy peer.
      expect(healthy).toHaveLength(3)
    })
  })

  test("both subscribers receive every event — delivery is a real fan-out", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })

      const a: EventEnvelopeV1[] = []
      const b: EventEnvelopeV1[] = []
      unwrap(bus.subscribe((e) => a.push(e)))
      unwrap(bus.subscribe((e) => b.push(e)))

      bus.publishTransition([selectionEvent()])

      expect(a).toHaveLength(2)
      expect(b).toHaveLength(2)
      expect(a[1]?.eventSeq).toBe(b[1]?.eventSeq)
    })
  })

  test("subscribing from inside a handler does not deliver the in-flight event twice", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })

      const late: EventEnvelopeV1[] = []
      unwrap(
        bus.subscribe(() => {
          if (late.length === 0) unwrap(bus.subscribe((e) => late.push(e)))
        }),
      )

      bus.publishTransition([selectionEvent()])

      // The late subscriber's snapshot already reflects the in-flight event, so receiving
      // that same event again would repeat an eventSeq in its own stream — §13.3 requires
      // strict monotonicity, and §9 promises a snapshot "then SUBSEQUENT events".
      const seqs = late.map((e) => e.eventSeq)
      expect(new Set(seqs).size).toBe(seqs.length)
    })
  })

  test("an unknown event kind is rejected as a value, not a thrown TypeError", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })

      const bogus = { kind: "totally.bogus", payload: {} } as unknown as PublishableEventV1
      const result = bus.publishTransition([bogus])

      // §9: an unknown kind "is a protocol error ... not silently interpreted".
      expect(result instanceof Error).toBe(true)
    })
  })

  test("a snapshot reports the current event sequence and revision inside its payload", () => {
    context.start(() => {
      const counters = createKernelCounters()
      const bus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload })

      bus.publishTransition([selectionEvent()])
      counters.advanceRevision()

      const received: EventEnvelopeV1[] = []
      unwrap(bus.subscribe((e) => received.push(e)))

      const snapshot = received[0]
      expect(snapshot?.kind).toBe("kernel.snapshot")
      expect(snapshot?.stateRevision).toBe(counters.stateRevision())
      // §13.3: "a snapshot reports the current event sequence and revision" — the DTO
      // payload is what crosses to the mirror, so the envelope field alone is not enough.
      expect((snapshot?.payload as { eventSeq: string }).eventSeq).toBe(counters.eventSeq())
    })
  })
})
