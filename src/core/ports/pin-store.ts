import type { FailureDtoV1 } from "core/protocol"
import type { PageSlug } from "entities/page"
import type { Pin, PinEvent } from "entities/pin"

/**
 * The pin read/write surface `core` consumes. `PinReader.fold` mirrors `store/index.ts`'s
 * `PinStore.fold` exactly (an empty array for a page with no comments log yet, never
 * distinguished from "no open pins" — storage-identity §11.2). `PinMutations` covers only
 * the STANDALONE pin write (a user open/reopen/create action outside a turn); the turn's
 * own automatic `pin:status resolved` append is `turn-transactions.ts`'s
 * `TurnFinalizeInputV1.resolvedPins`, not this port — the two paths differ in whether a
 * `WriteMutex` permit is already held by an in-flight turn transaction or must be acquired
 * fresh for a standalone action, and collapsing them would hide that difference from a
 * caller that needs to reason about it.
 *
 * `entities/pin`'s `Pin`/`PinEvent` are reused verbatim (item 3 of code-structure.md) —
 * neither imports a store submodule.
 *
 * `appendStandaloneEvent` with a `PinStatusEvent` is `pin.setStatus` — one of the six
 * commands blocker B3 names as unreachable through `store`'s current public surface; B3's
 * resolution (named domain methods grown onto `store`'s `TransactionEngine`) is upstream
 * work a sibling agent owns in this same slice.
 */
export interface PinReader {
  fold(pageSlug: PageSlug): Promise<FailureDtoV1 | readonly Pin[]>
}

export interface PinMutations {
  /** A standalone `pin:created`/`pin:status` event — not the turn's automatic resolution. */
  appendStandaloneEvent(pageSlug: PageSlug, event: PinEvent): Promise<FailureDtoV1 | undefined>
}
