import { describe, expect, mock, test } from "bun:test"
import { context } from "@reatom/core"

import { uuidv7 } from "infrastructure/uuid"

import { createSignalIngress } from "./signal-ingress"
import type { TurnBackendLeaseV1, TurnFenceProbe } from "../types"

interface FakeSignal extends TurnBackendLeaseV1 {
  readonly progressText: string
}

function lease(overrides: Partial<TurnBackendLeaseV1> = {}): TurnBackendLeaseV1 {
  return { turnId: uuidv7(), attempt: 1, leaseNonce: "nonce-a", ...overrides }
}

function signalFor(l: TurnBackendLeaseV1, progressText = "hello"): FakeSignal {
  return { ...l, progressText }
}

function fakeProbe(active: TurnBackendLeaseV1 | null): TurnFenceProbe {
  return { currentLease: () => active }
}

describe("createSignalIngress — §12.2 step 3: exact-match acceptance", () => {
  test("a signal whose lease exactly matches the active one is accepted", () => {
    const active = lease()
    const onAccepted = mock((_signal: FakeSignal) => {})
    const { deliver } = context.start(() =>
      createSignalIngress<FakeSignal>({ fenceProbe: fakeProbe(active), onAccepted }),
    )

    deliver(signalFor(active))

    expect(onAccepted.mock.calls.length).toBe(1)
    expect(onAccepted.mock.calls[0]?.[0]).toEqual(signalFor(active))
  })

  test("no active lease drops every signal, even one that would otherwise match", () => {
    const would = lease()
    const onAccepted = mock((_signal: FakeSignal) => {})
    const { deliver, droppedCount } = context.start(() =>
      createSignalIngress<FakeSignal>({ fenceProbe: fakeProbe(null), onAccepted }),
    )

    deliver(signalFor(would))

    expect(onAccepted.mock.calls.length).toBe(0)
    expect(droppedCount()).toBe(1)
  })
})

// §13.3: "Old turnId, old attempt, and old leaseNonce events are independently
// rejected; a matrix covers every one-field and multi-field mismatch."
describe("createSignalIngress — §13.3 full mismatch matrix", () => {
  const active = lease({ turnId: uuidv7(), attempt: 2, leaseNonce: "active-nonce" })

  const cases: { readonly name: string; readonly signalLease: TurnBackendLeaseV1 }[] = [
    { name: "turnId only differs", signalLease: { ...active, turnId: uuidv7() } },
    { name: "attempt only differs", signalLease: { ...active, attempt: active.attempt + 1 } },
    { name: "leaseNonce only differs", signalLease: { ...active, leaseNonce: "stale-nonce" } },
    { name: "turnId + attempt differ", signalLease: { ...active, turnId: uuidv7(), attempt: active.attempt + 1 } },
    { name: "turnId + leaseNonce differ", signalLease: { ...active, turnId: uuidv7(), leaseNonce: "stale-nonce" } },
    {
      name: "attempt + leaseNonce differ",
      signalLease: { ...active, attempt: active.attempt + 1, leaseNonce: "stale-nonce" },
    },
    {
      name: "all three differ",
      signalLease: { turnId: uuidv7(), attempt: active.attempt + 1, leaseNonce: "stale-nonce" },
    },
  ]

  for (const { name, signalLease } of cases) {
    test(`${name}: dropped and counted, onAccepted never called`, () => {
      const onAccepted = mock((_signal: FakeSignal) => {})
      const { deliver, droppedCount } = context.start(() =>
        createSignalIngress<FakeSignal>({ fenceProbe: fakeProbe(active), onAccepted }),
      )

      deliver(signalFor(signalLease))

      expect(onAccepted.mock.calls.length).toBe(0)
      expect(droppedCount()).toBe(1)
    })
  }

  test("an exact match among the matrix's near-misses is still accepted (control case)", () => {
    const onAccepted = mock((_signal: FakeSignal) => {})
    const { deliver, droppedCount } = context.start(() =>
      createSignalIngress<FakeSignal>({ fenceProbe: fakeProbe(active), onAccepted }),
    )

    deliver(signalFor(active))

    expect(onAccepted.mock.calls.length).toBe(1)
    expect(droppedCount()).toBe(0)
  })
})

describe("createSignalIngress — dropped-count bookkeeping and diagnostics", () => {
  test("droppedCount accumulates across multiple mismatched signals", () => {
    const active = lease()
    const { deliver, droppedCount } = context.start(() =>
      createSignalIngress<FakeSignal>({ fenceProbe: fakeProbe(active), onAccepted: () => {} }),
    )

    deliver(signalFor(lease({ turnId: uuidv7() })))
    deliver(signalFor(lease({ attempt: 99 })))
    deliver(signalFor(active)) // a genuine accept must not bump the drop counter

    expect(droppedCount()).toBe(2)
  })

  test("onStaleDropped receives the dropped signal and the active lease at drop time", () => {
    const active = lease()
    const stale = signalFor(lease({ leaseNonce: "old-nonce" }))
    const onStaleDropped = mock((_info: { signal: FakeSignal; activeLease: TurnBackendLeaseV1 | null }) => {})
    const { deliver } = context.start(() =>
      createSignalIngress<FakeSignal>({
        fenceProbe: fakeProbe(active),
        onAccepted: () => {},
        onStaleDropped,
      }),
    )

    deliver(stale)

    expect(onStaleDropped.mock.calls.length).toBe(1)
    expect(onStaleDropped.mock.calls[0]?.[0]).toEqual({ signal: stale, activeLease: active })
  })

  test("onStaleDropped is never called for an accepted signal", () => {
    const active = lease()
    const onStaleDropped = mock((_info: unknown) => {})
    const { deliver } = context.start(() =>
      createSignalIngress<FakeSignal>({ fenceProbe: fakeProbe(active), onAccepted: () => {}, onStaleDropped }),
    )

    deliver(signalFor(active))

    expect(onStaleDropped.mock.calls.length).toBe(0)
  })
})

describe("createSignalIngress — wrap re-enters the constructing frame at the async boundary", () => {
  test("deliver still correctly reaches onAccepted when invoked from completely outside any context.start(...)", async () => {
    // §6: "Service callbacks return to the same mailbox through wrap; they never set
    // model atoms directly." `deliver` is built once, inside `context.start(...)`
    // below, then handed out and invoked much later from a bare `setTimeout` callback —
    // as far outside a Reatom frame as external, uncontrolled backend code gets.
    const active = lease()
    const onAccepted = mock((_signal: FakeSignal) => {})
    const { deliver, droppedCount } = context.start(() =>
      createSignalIngress<FakeSignal>({ fenceProbe: fakeProbe(active), onAccepted }),
    )

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        deliver(signalFor(active))
        resolve()
      }, 0)
    })

    expect(onAccepted.mock.calls.length).toBe(1)
    // The decisive half of this test: `recordDrop` is a Reatom action writing an atom
    // (`droppedCountAtom`) created in the SAME construction-time frame `droppedCount`
    // itself is wrapped against. Sending a MISMATCHED signal from the same external
    // `setTimeout` boundary, then reading the count back, only agrees if `deliver`
    // actually re-entered that frame — an unwrapped `deliver` would write the drop into
    // whatever frame happens to be ambient in the `setTimeout` callback instead, and
    // `droppedCount()` would still read back 0.
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        deliver(signalFor(lease({ turnId: uuidv7() })))
        resolve()
      }, 0)
    })
    expect(droppedCount()).toBe(1)
  })

  test("the fence is re-read on every delivery, so a retry's new lease takes effect at once", () => {
    // §12.2 step 4: "A retry keeps turnId, increments attempt, and replaces leaseNonce. An
    // event from any earlier attempt is stale even if it arrives before cancellation
    // cleanup." The whole matrix above builds one ingress per case with a fixed probe, so
    // it pins the SHAPE of the comparison but not that the lease is read live — caching
    // currentLease() at construction time survives every one of those cases.
    const turnId = uuidv7()
    const attemptOne: TurnBackendLeaseV1 = { turnId, attempt: 1, leaseNonce: "nonce-1" }
    const attemptTwo: TurnBackendLeaseV1 = { turnId, attempt: 2, leaseNonce: "nonce-2" }

    let active: TurnBackendLeaseV1 = attemptOne
    const onAccepted = mock((_signal: FakeSignal) => {})
    const { deliver, droppedCount } = context.start(() =>
      createSignalIngress<FakeSignal>({
        fenceProbe: { currentLease: () => active },
        onAccepted,
      }),
    )

    deliver(signalFor(attemptOne))
    expect(onAccepted.mock.calls.length).toBe(1)

    active = attemptTwo

    // The in-flight attempt-1 event is now stale and must be dropped.
    deliver(signalFor(attemptOne))
    expect(droppedCount()).toBe(1)
    expect(onAccepted.mock.calls.length).toBe(1)

    // The new attempt's own events are accepted.
    deliver(signalFor(attemptTwo))
    expect(onAccepted.mock.calls.length).toBe(2)
    expect(droppedCount()).toBe(1)
  })
})
