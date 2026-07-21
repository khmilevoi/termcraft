/**
 * The event-envelope types the UI mirror reads — the ONE place `ui` imports
 * `EventEnvelopeV1`/`EventCorrelationV1` (D2 in the phase-7 plan).
 *
 * These live in `core/mailbox`'s barrel today; that file's own comment flags a future
 * `core/protocol/model/event-envelope.ts` that should absorb them. Centralising the import
 * here means the eventual move is a one-line edit, and nothing else under `ui/` ever touches
 * `core/mailbox` — every other `ui` file imports the envelope types from `ui/kernel`.
 */
import type { EventEnvelopeV1 } from "core/mailbox";
import type { EventKindV1 } from "core/protocol";

export type { EventCorrelationV1, EventEnvelopeV1 } from "core/mailbox";

/** An event envelope narrowed to one kind — its `payload` is `EventPayloadByKindV1[K]`. */
export type EventOf<K extends EventKindV1> = EventEnvelopeV1<K>;

/**
 * The DISTRIBUTED envelope union — one member per `EventKindV1`, each correlating its own
 * `kind` to its own `payload`. Unlike `EventEnvelopeV1` (a single interface whose default
 * `payload` is the whole payload union), switching on a value of this type narrows `payload`
 * to the exact per-kind shape. The mirror reducer consumes this; the App casts the port's
 * `EventEnvelopeV1` to it at the one subscribe boundary (sound — every envelope IS some
 * `EventEnvelopeV1<K>`).
 */
export type AnyEventEnvelope = { [K in EventKindV1]: EventOf<K> }[EventKindV1];
