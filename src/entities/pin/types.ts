import type { PageSlug } from "../page"

/** First line of every comments JSONL (storage-identity §11.2). */
export interface CommentsHeader {
  readonly kind: "pins"
  readonly formatVersion: 1
  readonly projectId: string
  readonly pageSlug: PageSlug
}

/** Pin creation event; its initial folded status is `open` (storage-identity §11.2). */
export interface PinCreatedEvent {
  readonly kind: "pin:created"
  readonly recordId: string
  readonly pinId: string
  readonly element: string // anchored element id
  readonly fx: number // fractional x in [0,1]
  readonly fy: number // fractional y in [0,1]
  readonly text: string
  readonly ts: string
}

/**
 * Pin status transition (storage-identity §11.2). Status is an EVENT FOLD, never an
 * in-place field. A user change carries `actionId`; automatic resolution after a
 * successful apply carries the responsible `turnId`. Exactly one of the two is present.
 */
export interface PinStatusEvent {
  readonly kind: "pin:status"
  readonly recordId: string
  readonly pinId: string
  readonly status: "open" | "resolved"
  readonly actionId?: string
  readonly turnId?: string
  readonly ts: string
}

/** Any event line after a comments header (storage-identity §11.2). */
export type PinEvent = PinCreatedEvent | PinStatusEvent

/** Derived pin state: the fold of a comments log in file order (storage-identity §11.2). */
export interface Pin {
  readonly pinId: string
  readonly element: string
  readonly fx: number
  readonly fy: number
  readonly text: string
  readonly status: "open" | "resolved"
}
