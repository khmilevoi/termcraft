import * as errore from "errore"

import { isRfc3339Utc } from "infrastructure/clock"
import { isCanonicalUuidv7 } from "infrastructure/uuid"
import { parsePageSlug } from "entities/page"
import type { PageSlug } from "entities/page"
import type { CommentsHeader, Pin, PinCreatedEvent, PinEvent, PinStatusEvent } from "../types"

/**
 * A schema, identity, or fold violation in a comments header/event (storage-identity
 * §11.2). Decoders and the fold return this as a value — corruption is data, not an
 * exception. Unknown extra fields are IGNORED (forward-compatible).
 */
export class PinDecodeError extends errore.createTaggedError({
  name: "PinDecodeError",
  message: "pin decode failed [$code]: $reason",
}) {}

type Obj = Record<string, unknown>

function fail(code: string, reason: string): PinDecodeError {
  return new PinDecodeError({ code, reason })
}

function asObject(value: unknown): Obj | PinDecodeError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("SHAPE", "record is not a JSON object")
  return value as Obj
}

function reqString(obj: Obj, key: string): string | PinDecodeError {
  const v = obj[key]
  if (typeof v !== "string" || v.length === 0) return fail("FIELD", `\`${key}\` must be a non-empty string`)
  return v
}

function reqUuid(obj: Obj, key: string): string | PinDecodeError {
  const v = reqString(obj, key)
  if (v instanceof Error) return v
  if (!isCanonicalUuidv7(v)) return fail("IDENTITY", `\`${key}\` is not a canonical UUIDv7`)
  return v
}

function reqTs(obj: Obj): string | PinDecodeError {
  const v = reqString(obj, "ts")
  if (v instanceof Error) return v
  if (!isRfc3339Utc(v)) return fail("TIMESTAMP", "`ts` is not a UTC RFC 3339 timestamp")
  return v
}

/** A fraction in the closed unit interval [0,1] (a pin's normalized anchor coordinate). */
function reqFraction(obj: Obj, key: string): number | PinDecodeError {
  const v = obj[key]
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return fail("FIELD", `\`${key}\` must be a finite number in [0,1]`)
  return v
}

/** Text is empty-allowed on a pin, unlike an identity string. */
function reqText(obj: Obj): string | PinDecodeError {
  const v = obj["text"]
  if (typeof v !== "string") return fail("FIELD", "`text` must be a string")
  return v
}

function decodeCreated(obj: Obj): PinCreatedEvent | PinDecodeError {
  const recordId = reqUuid(obj, "recordId")
  if (recordId instanceof Error) return recordId
  const pinId = reqUuid(obj, "pinId")
  if (pinId instanceof Error) return pinId
  const element = reqString(obj, "element")
  if (element instanceof Error) return element
  const fx = reqFraction(obj, "fx")
  if (fx instanceof Error) return fx
  const fy = reqFraction(obj, "fy")
  if (fy instanceof Error) return fy
  const text = reqText(obj)
  if (text instanceof Error) return text
  const ts = reqTs(obj)
  if (ts instanceof Error) return ts
  return { kind: "pin:created", recordId, pinId, element, fx, fy, text, ts }
}

function decodeStatus(obj: Obj): PinStatusEvent | PinDecodeError {
  const recordId = reqUuid(obj, "recordId")
  if (recordId instanceof Error) return recordId
  const pinId = reqUuid(obj, "pinId")
  if (pinId instanceof Error) return pinId
  const status = obj["status"]
  if (status !== "open" && status !== "resolved") return fail("FIELD", "`status` must be open or resolved")
  const ts = reqTs(obj)
  if (ts instanceof Error) return ts
  const hasAction = obj["actionId"] !== undefined
  const hasTurn = obj["turnId"] !== undefined
  if (hasAction === hasTurn) return fail("IDENTITY", "exactly one of `actionId`/`turnId` is required")
  if (hasAction) {
    const actionId = reqUuid(obj, "actionId")
    if (actionId instanceof Error) return actionId
    return { kind: "pin:status", recordId, pinId, status, actionId, ts }
  }
  const turnId = reqUuid(obj, "turnId")
  if (turnId instanceof Error) return turnId
  return { kind: "pin:status", recordId, pinId, status, turnId, ts }
}

/**
 * Decode a comments JSONL header (storage-identity §11.2): `kind = "pins"`,
 * `formatVersion = 1`, canonical `projectId`, and a valid `pageSlug`.
 */
export function decodeCommentsHeader(value: unknown): CommentsHeader | PinDecodeError {
  const obj = asObject(value)
  if (obj instanceof Error) return obj
  if (obj["kind"] !== "pins") return fail("KIND", "header `kind` must be \"pins\"")
  if (obj["formatVersion"] !== 1) return fail("VERSION", "header `formatVersion` must be 1")
  const projectId = reqUuid(obj, "projectId")
  if (projectId instanceof Error) return projectId
  if (typeof obj["pageSlug"] !== "string") return fail("FIELD", "`pageSlug` must be a slug string")
  const pageSlug = parsePageSlug(obj["pageSlug"])
  if (pageSlug instanceof Error) return fail("IDENTITY", pageSlug.message)
  return { kind: "pins", formatVersion: 1, projectId, pageSlug: pageSlug as PageSlug }
}

/**
 * Decode one comments event line by its `kind` (storage-identity §11.2). Unknown kind
 * or any invalid field is a `PinDecodeError`; extra fields are ignored.
 */
export function decodePinEvent(value: unknown): PinEvent | PinDecodeError {
  const obj = asObject(value)
  if (obj instanceof Error) return obj
  switch (obj["kind"]) {
    case "pin:created":
      return decodeCreated(obj)
    case "pin:status":
      return decodeStatus(obj)
    default:
      return fail("KIND", `unknown event kind ${JSON.stringify(obj["kind"])}`)
  }
}

/**
 * Fold a comments log into pin state (storage-identity §11.2): FILE ORDER is
 * authoritative — never a timestamp/UUID comparison. `pin:created` establishes a pin
 * with status `open`; each later `pin:status` for that pinId sets its status (the last
 * one wins). A second `pin:created` for one pinId, or a `pin:status` before its
 * `pin:created`, is CORRUPTION. Pins are returned in creation order.
 */
export function foldPins(events: readonly PinEvent[]): readonly Pin[] | PinDecodeError {
  const byId = new Map<string, { pin: Pin; order: number }>()
  let order = 0
  for (const event of events) {
    if (event.kind === "pin:created") {
      if (byId.has(event.pinId)) return fail("FOLD", `duplicate pin:created for pinId ${event.pinId}`)
      byId.set(event.pinId, {
        order: order++,
        pin: { pinId: event.pinId, element: event.element, fx: event.fx, fy: event.fy, text: event.text, status: "open" },
      })
      continue
    }
    const existing = byId.get(event.pinId)
    if (existing === undefined) return fail("FOLD", `pin:status before pin:created for pinId ${event.pinId}`)
    existing.pin = { ...existing.pin, status: event.status }
  }
  return [...byId.values()].sort((a, b) => a.order - b.order).map((entry) => entry.pin)
}
