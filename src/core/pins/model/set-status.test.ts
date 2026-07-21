import { describe, expect, test } from "bun:test"

import { eventPayloadV1SchemaByKind, isUuidv7, type FailureDtoV1 } from "core/protocol"
import { parsePageSlug, type PageSlug } from "entities/page"
import type { PinEvent } from "entities/pin"
import { createFakePinStore } from "core/ports/fakes"
import type { Clock } from "infrastructure/clock"

import { setPinStatus } from "./set-status"

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

const PAGE = slug("home")
const NOW = "2024-06-01T12:00:00.000Z"

function clockAt(iso: string): Clock {
  return { now: () => new Date(iso) }
}

function createdEvent(): PinEvent {
  return {
    kind: "pin:created",
    recordId: "0192f6f0-0000-7000-8000-000000000001",
    pinId: "0192f6f0-0000-7000-8000-0000000000a1",
    element: "btn-submit",
    fx: 0.5,
    fy: 0.5,
    text: "why is this red?",
    ts: "2024-01-01T00:00:00.000Z",
  }
}

const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk unavailable", details: {} }

describe("setPinStatus", () => {
  test("appends a pin:status event through PinMutations and returns the complete affected PinDtoV1", async () => {
    const pinStore = createFakePinStore()
    const clock = clockAt(NOW)

    const result = await setPinStatus(
      { pinMutations: pinStore, clock },
      { pageSlug: PAGE, pinId: "0192f6f0-0000-7000-8000-0000000000a1", status: "resolved", priorEvents: [createdEvent()] },
    )

    if ("code" in result) throw result
    expect(result.kind).toBe("updated")
    if (result.kind !== "updated") return

    expect(eventPayloadV1SchemaByKind["pins.changed"].safeParse(result.payload).success).toBe(true)
    expect(result.payload.pageSlug).toBe(PAGE)
    expect(result.payload.affectedPins).toHaveLength(1)
    const pin = result.payload.affectedPins[0]
    expect(pin?.pinId).toBe("0192f6f0-0000-7000-8000-0000000000a1")
    expect(pin?.status).toBe("resolved")
    expect(pin?.createdRecordId).toBe("0192f6f0-0000-7000-8000-000000000001")
    expect(pin?.updatedAt).toBe(NOW)
    expect(isUuidv7(pin?.latestRecordId ?? "")).toBe(true)
    expect(pin?.latestRecordId).not.toBe(pin?.createdRecordId)
  })

  test("appends the event via PinMutations.appendStandaloneEvent, and the DTO's causeId matches the appended event's actionId", async () => {
    const pinStore = createFakePinStore()
    const clock = clockAt(NOW)

    const result = await setPinStatus(
      { pinMutations: pinStore, clock },
      { pageSlug: PAGE, pinId: "0192f6f0-0000-7000-8000-0000000000a1", status: "resolved", priorEvents: [createdEvent()] },
    )

    if ("code" in result || result.kind !== "updated") throw new Error("expected an update")
    expect(pinStore.calls).toHaveLength(1)
    const call = pinStore.calls[0]
    if (call?.method !== "appendStandaloneEvent") throw new Error("expected appendStandaloneEvent")
    expect(call.pageSlug).toBe(PAGE)
    expect(call.event.kind).toBe("pin:status")
    if (call.event.kind !== "pin:status") return
    expect(call.event.pinId).toBe("0192f6f0-0000-7000-8000-0000000000a1")
    expect(call.event.status).toBe("resolved")
    expect(call.event.actionId).toBe(result.payload.causeId)
    expect(call.event.turnId).toBeUndefined()
  })

  test("reports not-found for a pinId absent from priorEvents, without appending anything", async () => {
    const pinStore = createFakePinStore()
    const clock = clockAt(NOW)

    const result = await setPinStatus(
      { pinMutations: pinStore, clock },
      { pageSlug: PAGE, pinId: "0192f6f0-0000-7000-8000-000000009999", status: "resolved", priorEvents: [createdEvent()] },
    )

    expect(result).toEqual({ kind: "not-found" })
    expect(pinStore.calls).toEqual([])
  })

  test("propagates an append failure", async () => {
    const pinStore = createFakePinStore()
    pinStore.failNext("appendStandaloneEvent", FAILURE)
    const clock = clockAt(NOW)

    const result = await setPinStatus(
      { pinMutations: pinStore, clock },
      { pageSlug: PAGE, pinId: "0192f6f0-0000-7000-8000-0000000000a1", status: "resolved", priorEvents: [createdEvent()] },
    )

    expect(result).toEqual(FAILURE)
  })

  test("reopening a resolved pin plumbs status \"open\" through to the event and the DTO", async () => {
    // Every other test in this file passes status: "resolved", so the implementation could
    // ignore its `status` argument entirely and hardcode "resolved" — verified: that
    // mutation survived the whole file. A reopen would then silently resolve the pin.
    // The port's own doc calls this "a user open/reopen/create action outside a turn", and
    // §13 says pins.changed "drives resolved/REOPENED pin UI".
    const clock = clockAt(NOW)
    const pinStore = createFakePinStore()
    const alreadyResolved: PinEvent = {
      kind: "pin:status",
      recordId: "0192f6f0-0000-7000-8000-000000000002",
      pinId: "0192f6f0-0000-7000-8000-0000000000a1",
      status: "resolved",
      actionId: "0192f6f0-0000-7000-8000-0000000000b1",
      ts: "2024-01-01T00:00:00.000Z",
    }

    const result = await setPinStatus(
      { pinMutations: pinStore, clock },
      {
        pageSlug: PAGE,
        pinId: "0192f6f0-0000-7000-8000-0000000000a1",
        status: "open",
        priorEvents: [createdEvent(), alreadyResolved],
      },
    )

    if ("code" in result) throw new Error(`expected success, got ${JSON.stringify(result)}`)
    if (result.kind !== "updated") throw new Error(`expected updated, got ${result.kind}`)
    expect(result.payload.affectedPins[0]?.status).toBe("open")
    // ...and the appended event itself, not just the projected DTO.
    const appended = pinStore.calls.find((c) => c.method === "appendStandaloneEvent")
    expect((appended?.event as { status?: string } | undefined)?.status).toBe("open")
    // §9 requires the affected record ids, and an empty array satisfies the schema.
    expect(result.payload.affectedRecordIds.length).toBeGreaterThan(0)
  })
})
