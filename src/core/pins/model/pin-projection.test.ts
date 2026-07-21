import { describe, expect, test } from "bun:test"

import { pinDtoV1Schema } from "core/protocol"
import { parsePageSlug, type PageSlug } from "entities/page"
import type { PinEvent } from "entities/pin"

import { PinProjectionError, projectPinEvents } from "./pin-projection"

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

const PAGE = slug("home")

function created(overrides: Partial<Extract<PinEvent, { kind: "pin:created" }>> = {}): PinEvent {
  return {
    kind: "pin:created",
    recordId: "0192f6f0-0000-7000-8000-000000000001",
    pinId: "0192f6f0-0000-7000-8000-0000000000a1",
    element: "btn-submit",
    fx: 0.5,
    fy: 0.5,
    text: "why is this red?",
    ts: "2024-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function status(overrides: Partial<Extract<PinEvent, { kind: "pin:status" }>> = {}): PinEvent {
  return {
    kind: "pin:status",
    recordId: "0192f6f0-0000-7000-8000-000000000002",
    pinId: "0192f6f0-0000-7000-8000-0000000000a1",
    status: "resolved",
    actionId: "0192f6f0-0000-7000-8000-000000000003",
    ts: "2024-01-01T00:01:00.000Z",
    ...overrides,
  }
}

describe("projectPinEvents", () => {
  test("a bare pin:created projects to an open pin with matching created/latest record ids", () => {
    const result = projectPinEvents(PAGE, [created()])
    if (result instanceof Error) throw result
    expect(result).toEqual([
      {
        pinId: "0192f6f0-0000-7000-8000-0000000000a1",
        pageSlug: PAGE,
        elementId: "btn-submit",
        fx: 0.5,
        fy: 0.5,
        text: "why is this red?",
        status: "open",
        createdRecordId: "0192f6f0-0000-7000-8000-000000000001",
        latestRecordId: "0192f6f0-0000-7000-8000-000000000001",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ])
  })

  test("produces a schema-valid PinDtoV1", () => {
    const result = projectPinEvents(PAGE, [created()])
    if (result instanceof Error) throw result
    expect(pinDtoV1Schema.safeParse(result[0]).success).toBe(true)
  })

  test("a later pin:status updates status/latestRecordId/updatedAt but keeps createdRecordId from the ORIGINAL creation event", () => {
    const result = projectPinEvents(PAGE, [created(), status()])
    if (result instanceof Error) throw result
    expect(result[0]).toMatchObject({
      status: "resolved",
      createdRecordId: "0192f6f0-0000-7000-8000-000000000001",
      latestRecordId: "0192f6f0-0000-7000-8000-000000000002",
      updatedAt: "2024-01-01T00:01:00.000Z",
    })
  })

  test("the LAST status wins across several status events, file order authoritative", () => {
    const result = projectPinEvents(PAGE, [
      created(),
      status({ recordId: "0192f6f0-0000-7000-8000-000000000002", status: "resolved", ts: "2024-01-01T00:01:00.000Z" }),
      status({ recordId: "0192f6f0-0000-7000-8000-000000000004", status: "open", actionId: undefined, turnId: "0192f6f0-0000-7000-8000-000000000005", ts: "2024-01-01T00:02:00.000Z" }),
    ])
    if (result instanceof Error) throw result
    expect(result[0]?.status).toBe("open")
    expect(result[0]?.latestRecordId).toBe("0192f6f0-0000-7000-8000-000000000004")
  })

  test("does not mutate element/fx/fy/text on a status event — only pin:created sets them", () => {
    const result = projectPinEvents(PAGE, [created({ fx: 0.25, fy: 0.75 }), status()])
    if (result instanceof Error) throw result
    expect(result[0]).toMatchObject({ fx: 0.25, fy: 0.75, elementId: "btn-submit" })
  })

  test("returns pins in creation order across multiple pins", () => {
    const second = created({
      recordId: "0192f6f0-0000-7000-8000-000000000010",
      pinId: "0192f6f0-0000-7000-8000-0000000000b2",
      ts: "2024-01-01T00:05:00.000Z",
    })
    const result = projectPinEvents(PAGE, [second, created()])
    if (result instanceof Error) throw result
    expect(result.map((p) => p.pinId)).toEqual(["0192f6f0-0000-7000-8000-0000000000b2", "0192f6f0-0000-7000-8000-0000000000a1"])
  })

  test("a duplicate pin:created for the same pinId is corruption", () => {
    const result = projectPinEvents(PAGE, [created(), created({ recordId: "0192f6f0-0000-7000-8000-000000000099" })])
    expect(result).toBeInstanceOf(PinProjectionError)
  })

  test("a pin:status before its pin:created is corruption", () => {
    const result = projectPinEvents(PAGE, [status()])
    expect(result).toBeInstanceOf(PinProjectionError)
  })

  test("an empty log projects to an empty array, never an error", () => {
    const result = projectPinEvents(PAGE, [])
    expect(result).toEqual([])
  })
})
