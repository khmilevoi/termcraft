import { describe, expect, test } from "bun:test"

import { eventPayloadV1SchemaByKind, isUuidv7, type FailureDtoV1, type FrameIdentityV1 } from "core/protocol"
import { createFakePinStore } from "core/ports/fakes"
import { createFrameTokenLedger, createGeometryTokenLedger, type GeometryAnchorV1 } from "core/preview"
import { parsePageSlug } from "entities/page"
import type { Clock } from "infrastructure/clock"

import { createPin } from "./create"

function slug(value: string) {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

const HOME = slug("home")

/**
 * `pin.create` (kernel-command-contract §8.2, §12.6 item 6): "The Kernel matches the
 * canonical ledger entry to the frame currently acknowledged as displayed and consumes it
 * once; stale incarnation/session/source/frame rejects." The token verification/consumption
 * is this file's own "capability guard" (frame/geometry token check) — `core/pins/types.ts`'s
 * own note on the seam this file fills. The negative case matters just as much as the
 * positive one: §8.1 says a frame token "cannot authorize `pin.create`" — feeding one where
 * a geometry token is expected must fail, never silently succeed.
 */

const NOW = "2024-06-01T12:00:00.000Z"

function clockAt(iso: string): Clock {
  return { now: () => new Date(iso) }
}

function identity(overrides: Partial<FrameIdentityV1> = {}): FrameIdentityV1 {
  return {
    previewSessionId: "0192f6f0-0000-7000-8000-0000000000a1",
    nonce: "a".repeat(32),
    sourceHash: "b".repeat(64),
    frameSeq: "1",
    ...overrides,
  }
}

function anchor(overrides: Partial<GeometryAnchorV1> = {}): GeometryAnchorV1 {
  return {
    identity: identity(),
    pageSlug: "home",
    elementId: "btn-submit",
    fx: 0.5,
    fy: 0.5,
    ...overrides,
  }
}

/** A frame-token ledger already acknowledged as displaying `identity()`. */
function ackedFrameTokenLedger(withIdentity = identity()) {
  const ledger = createFrameTokenLedger()
  const token = ledger.mint(withIdentity)
  const acked = ledger.acknowledge(token)
  if (acked instanceof Error) throw acked
  return ledger
}

const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk unavailable", details: {} }

describe("createPin", () => {
  test("consumes a resolving geometry token and appends a pin:created event, returning the complete new PinDtoV1", async () => {
    const pinStore = createFakePinStore()
    const clock = clockAt(NOW)
    const frameTokenLedger = ackedFrameTokenLedger()
    const geometryTokenLedger = createGeometryTokenLedger({ clock })
    const geometryToken = geometryTokenLedger.mint(anchor())

    const result = await createPin(
      { pinMutations: pinStore, clock, frameTokenLedger, geometryTokenLedger },
      { geometryToken, text: "why is this red?" },
    )

    if ("code" in result) throw result
    expect(result.kind).toBe("created")
    if (result.kind !== "created") return

    expect(eventPayloadV1SchemaByKind["pins.changed"].safeParse(result.payload).success).toBe(true)
    expect(result.payload.pageSlug).toBe("home")
    expect(result.payload.affectedPins).toHaveLength(1)
    const pin = result.payload.affectedPins[0]
    expect(pin?.pageSlug).toBe("home")
    expect(pin?.elementId).toBe("btn-submit")
    expect(pin?.fx).toBe(0.5)
    expect(pin?.fy).toBe(0.5)
    expect(pin?.text).toBe("why is this red?")
    expect(pin?.status).toBe("open")
    expect(pin?.updatedAt).toBe(NOW)
    expect(isUuidv7(pin?.pinId ?? "")).toBe(true)
    expect(pin?.createdRecordId).toBe(pin?.latestRecordId)
    expect(result.payload.causeId).toBe(pin?.pinId ?? "")
  })

  test("appends via PinMutations.appendStandaloneEvent with a pin:created event carrying the anchor's element/fx/fy and the input text", async () => {
    const pinStore = createFakePinStore()
    const clock = clockAt(NOW)
    const frameTokenLedger = ackedFrameTokenLedger()
    const geometryTokenLedger = createGeometryTokenLedger({ clock })
    const geometryToken = geometryTokenLedger.mint(anchor({ elementId: "btn-cancel", fx: 0.1, fy: 0.9 }))

    const result = await createPin(
      { pinMutations: pinStore, clock, frameTokenLedger, geometryTokenLedger },
      { geometryToken, text: "hmm" },
    )

    if ("code" in result || result.kind !== "created") throw new Error("expected created")
    expect(pinStore.calls).toHaveLength(1)
    const call = pinStore.calls[0]
    if (call?.method !== "appendStandaloneEvent") throw new Error("expected appendStandaloneEvent")
    expect(call.pageSlug).toBe(HOME)
    expect(call.event.kind).toBe("pin:created")
    if (call.event.kind !== "pin:created") return
    expect(call.event.element).toBe("btn-cancel")
    expect(call.event.fx).toBe(0.1)
    expect(call.event.fy).toBe(0.9)
    expect(call.event.text).toBe("hmm")
    const createdPin = result.payload.affectedPins[0]
    if (createdPin === undefined) throw new Error("expected an affected pin")
    expect(call.event.pinId).toBe(createdPin.pinId)
  })

  test("consumes the geometry token exactly once: a second createPin call with the same token is refused as GEOMETRY_TOKEN_INVALID", async () => {
    const pinStore = createFakePinStore()
    const clock = clockAt(NOW)
    const frameTokenLedger = ackedFrameTokenLedger()
    const geometryTokenLedger = createGeometryTokenLedger({ clock })
    const geometryToken = geometryTokenLedger.mint(anchor())

    const first = await createPin(
      { pinMutations: pinStore, clock, frameTokenLedger, geometryTokenLedger },
      { geometryToken, text: "one" },
    )
    if ("code" in first || first.kind !== "created") throw new Error("expected the first call to succeed")

    const second = await createPin(
      { pinMutations: pinStore, clock, frameTokenLedger, geometryTokenLedger },
      { geometryToken, text: "two" },
    )

    expect(second).toEqual({ kind: "rejected", code: "GEOMETRY_TOKEN_INVALID" })
    expect(pinStore.calls).toHaveLength(1) // the second attempt never appended anything
  })

  test("an unknown geometry token is refused as GEOMETRY_TOKEN_INVALID, without appending anything", async () => {
    const pinStore = createFakePinStore()
    const clock = clockAt(NOW)
    const frameTokenLedger = ackedFrameTokenLedger()
    const geometryTokenLedger = createGeometryTokenLedger({ clock })

    const result = await createPin(
      { pinMutations: pinStore, clock, frameTokenLedger, geometryTokenLedger },
      { geometryToken: "0192f6f0-0000-7000-8000-0000000000ff", text: "?" },
    )

    expect(result).toEqual({ kind: "rejected", code: "GEOMETRY_TOKEN_INVALID" })
    expect(pinStore.calls).toEqual([])
  })

  test("a geometry token whose bound identity no longer matches the currently displayed frame is refused as GEOMETRY_TOKEN_STALE", async () => {
    const pinStore = createFakePinStore()
    const clock = clockAt(NOW)
    // Acknowledged identity differs (a different frameSeq) from the token's own binding.
    const frameTokenLedger = ackedFrameTokenLedger(identity({ frameSeq: "2" }))
    const geometryTokenLedger = createGeometryTokenLedger({ clock })
    const geometryToken = geometryTokenLedger.mint(anchor({ identity: identity({ frameSeq: "1" }) }))

    const result = await createPin(
      { pinMutations: pinStore, clock, frameTokenLedger, geometryTokenLedger },
      { geometryToken, text: "?" },
    )

    expect(result).toEqual({ kind: "rejected", code: "GEOMETRY_TOKEN_STALE" })
    expect(pinStore.calls).toEqual([])
  })

  test("NEGATIVE: a frame token fed in place of a geometry token cannot authorize pin.create (§8.1: a frame token 'cannot authorize pin.create')", async () => {
    const pinStore = createFakePinStore()
    const clock = clockAt(NOW)
    const frameTokenLedger = createFrameTokenLedger()
    const geometryTokenLedger = createGeometryTokenLedger({ clock })
    const frameToken = frameTokenLedger.mint(identity())
    const acked = frameTokenLedger.acknowledge(frameToken)
    if (acked instanceof Error) throw acked

    // The frame token is a real, live, ACKNOWLEDGED token — but it was never minted BY the
    // geometry-token ledger, so it must not be mistaken for one.
    const result = await createPin(
      { pinMutations: pinStore, clock, frameTokenLedger, geometryTokenLedger },
      { geometryToken: frameToken, text: "should never work" },
    )

    expect(result).toEqual({ kind: "rejected", code: "GEOMETRY_TOKEN_INVALID" })
    expect(pinStore.calls).toEqual([])
  })

  test("no live displayed frame at all (nothing ever acknowledged) refuses without consulting the geometry ledger's own state", async () => {
    const pinStore = createFakePinStore()
    const clock = clockAt(NOW)
    const frameTokenLedger = createFrameTokenLedger() // nothing acknowledged
    const geometryTokenLedger = createGeometryTokenLedger({ clock })
    const geometryToken = geometryTokenLedger.mint(anchor())

    const result = await createPin(
      { pinMutations: pinStore, clock, frameTokenLedger, geometryTokenLedger },
      { geometryToken, text: "?" },
    )

    expect(result).toEqual({ kind: "rejected", code: "GEOMETRY_TOKEN_STALE" })
    expect(pinStore.calls).toEqual([])
  })

  test("propagates an append failure without fabricating a pins.changed payload", async () => {
    const pinStore = createFakePinStore()
    pinStore.failNext("appendStandaloneEvent", FAILURE)
    const clock = clockAt(NOW)
    const frameTokenLedger = ackedFrameTokenLedger()
    const geometryTokenLedger = createGeometryTokenLedger({ clock })
    const geometryToken = geometryTokenLedger.mint(anchor())

    const result = await createPin(
      { pinMutations: pinStore, clock, frameTokenLedger, geometryTokenLedger },
      { geometryToken, text: "?" },
    )

    expect(result).toEqual(FAILURE)
  })

  test("empty pin text is allowed, matching pinDtoV1Schema's own allowance", async () => {
    const pinStore = createFakePinStore()
    const clock = clockAt(NOW)
    const frameTokenLedger = ackedFrameTokenLedger()
    const geometryTokenLedger = createGeometryTokenLedger({ clock })
    const geometryToken = geometryTokenLedger.mint(anchor())

    const result = await createPin(
      { pinMutations: pinStore, clock, frameTokenLedger, geometryTokenLedger },
      { geometryToken, text: "" },
    )

    if ("code" in result || result.kind !== "created") throw new Error("expected created")
    expect(result.payload.affectedPins[0]?.text).toBe("")
  })
})
