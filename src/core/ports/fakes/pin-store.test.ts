import { describe, expect, test } from "bun:test"

import { parsePageSlug } from "entities/page"
import type { PageSlug } from "entities/page"
import type { FailureDtoV1 } from "core/protocol"
import type { PinEvent } from "entities/pin"
import { createFakePinStore } from "./pin-store"

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "pins log unreadable", details: {} }

const created: PinEvent = {
  kind: "pin:created",
  recordId: "r1",
  pinId: "p1",
  element: "btn-1",
  fx: 0.5,
  fy: 0.5,
  text: "looks off",
  ts: "2024-01-01T00:00:00.000Z",
}

describe("createFakePinStore", () => {
  test("fold() on a page with no log yet returns an empty array, never an error", async () => {
    const store = createFakePinStore()
    const result = await store.fold(slug("home"))
    if ("code" in result) throw new Error("unexpected failure")
    expect(result).toEqual([])
  })

  test("appendStandaloneEvent() then fold() reflects the real entities/pin fold", async () => {
    const store = createFakePinStore()
    await store.appendStandaloneEvent(slug("home"), created)
    const result = await store.fold(slug("home"))
    if ("code" in result) throw new Error("unexpected failure")
    expect(result).toEqual([{ pinId: "p1", element: "btn-1", fx: 0.5, fy: 0.5, text: "looks off", status: "open" }])
  })

  test("appendStandaloneEvent() with a status transition resolves the pin", async () => {
    const store = createFakePinStore()
    await store.appendStandaloneEvent(slug("home"), created)
    await store.appendStandaloneEvent(slug("home"), {
      kind: "pin:status",
      recordId: "r2",
      pinId: "p1",
      status: "resolved",
      actionId: "action-1",
      ts: "2024-01-01T00:01:00.000Z",
    })
    const result = await store.fold(slug("home"))
    if ("code" in result) throw new Error("unexpected failure")
    expect(result[0]?.status).toBe("resolved")
  })

  test("failNext() queues one failure for the named method", async () => {
    const store = createFakePinStore()
    store.failNext("fold", FAILURE)
    const first = await store.fold(slug("home"))
    expect(first).toEqual(FAILURE)
    const second = await store.fold(slug("home"))
    expect("code" in second).toBe(false)
  })

  test("records calls in order with their page slugs", async () => {
    const store = createFakePinStore()
    await store.appendStandaloneEvent(slug("home"), created)
    await store.fold(slug("home"))
    expect(store.calls.map((c) => c.method)).toEqual(["appendStandaloneEvent", "fold"])
  })
})
