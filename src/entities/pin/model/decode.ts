import * as errore from "errore"
import { z } from "zod"

import { rfc3339UtcSchema } from "infrastructure/clock"
import { canonicalUuidv7Schema } from "infrastructure/uuid"
import { pageSlugSchema } from "entities/page"
import type { CommentsHeader, Pin, PinCreatedEvent, PinEvent, PinStatusEvent } from "../types"

/**
 * A schema, identity, or fold violation in a comments header/event (storage-identity
 * §11.2). Decoders and the fold return this as a value — corruption is data, not an
 * exception. Unknown extra fields are IGNORED (forward-compatible: every schema below
 * is a plain `z.object`, which strips unrecognized keys rather than rejecting them).
 */
export class PinDecodeError extends errore.createTaggedError({
  name: "PinDecodeError",
  message: "pin decode failed [$code]: $reason",
}) {}

function fail(code: string, reason: string): PinDecodeError {
  return new PinDecodeError({ code, reason })
}

/** Maps the first Zod issue to a `PinDecodeError` (decoders fail on the first violation, like the hand-rolled checks they replace). */
function toDecodeError(error: z.ZodError): PinDecodeError {
  const issue = error.issues[0]
  const code = issue !== undefined && issue.path.length > 0 ? issue.path.join(".") : "SHAPE"
  return fail(code, issue?.message ?? "invalid input")
}

/** A fraction in the closed unit interval [0,1] (a pin's normalized anchor coordinate). */
const fractionSchema = z.number().min(0).max(1)

const commentsHeaderSchema = z.object({
  kind: z.literal("pins"),
  formatVersion: z.literal(1),
  projectId: canonicalUuidv7Schema,
  pageSlug: pageSlugSchema,
})

const pinCreatedEventSchema = z.object({
  kind: z.literal("pin:created"),
  recordId: canonicalUuidv7Schema,
  pinId: canonicalUuidv7Schema,
  element: z.string().min(1),
  fx: fractionSchema,
  fy: fractionSchema,
  text: z.string(), // empty-allowed on a pin, unlike an identity string
  ts: rfc3339UtcSchema,
})

const pinStatusEventSchema = z.object({
  kind: z.literal("pin:status"),
  recordId: canonicalUuidv7Schema,
  pinId: canonicalUuidv7Schema,
  status: z.enum(["open", "resolved"]),
  actionId: canonicalUuidv7Schema.optional(),
  turnId: canonicalUuidv7Schema.optional(),
  ts: rfc3339UtcSchema,
})

/**
 * Exactly one of `actionId`/`turnId` is required on a status event (storage-identity
 * §11.2). Checked on the parsed union, not on an individual member — `discriminatedUnion`
 * only accepts plain object members, so the cross-field XOR rule lives here instead.
 */
const pinEventSchema = z
  .discriminatedUnion("kind", [pinCreatedEventSchema, pinStatusEventSchema])
  .superRefine((val, ctx) => {
    if (val.kind !== "pin:status") return
    const hasAction = val.actionId !== undefined
    const hasTurn = val.turnId !== undefined
    if (hasAction === hasTurn) {
      ctx.addIssue({ code: "custom", message: "exactly one of `actionId`/`turnId` is required" })
    }
  })

/**
 * Decode a comments JSONL header (storage-identity §11.2): `kind = "pins"`,
 * `formatVersion = 1`, canonical `projectId`, and a valid `pageSlug`.
 */
export function decodeCommentsHeader(value: unknown): CommentsHeader | PinDecodeError {
  const result = commentsHeaderSchema.safeParse(value)
  if (!result.success) return toDecodeError(result.error)
  return result.data
}

/**
 * Decode one comments event line by its `kind` (storage-identity §11.2). Unknown kind
 * or any invalid field is a `PinDecodeError`; extra fields are ignored.
 */
export function decodePinEvent(value: unknown): PinEvent | PinDecodeError {
  const result = pinEventSchema.safeParse(value)
  if (!result.success) return toDecodeError(result.error)
  return result.data
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
