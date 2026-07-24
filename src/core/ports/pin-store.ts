import type { FailureDtoV1 } from "core/protocol";
import type { PageSlug } from "entities/page";
import type { Pin, PinEvent } from "entities/pin";

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
 *
 * `readEvents`/`findPageForPin` close "surface 3"
 * (`.superpowers/sdd/task9-family-page-pin-report.md`): the pin-to-page resolution primitive
 * that report proved missing for `pin.setStatus`'s handler
 * (`core/kernel/model/handlers/page-pin.ts`) to compose `core/pins/model/set-status.ts`'s
 * `setPinStatus` without fabricating a `pageSlug` or a raw event log. Port + fake only here —
 * the real adapter (WP-2, `store`) implements both against the actual comments JSONL.
 */
export interface PinReader {
  fold(pageSlug: PageSlug): Promise<FailureDtoV1 | readonly Pin[]>;
  /**
   * The page's complete, unfolded pin-event log — the raw `PinEvent[]` `fold()`'s own
   * projection is built from, but never returns itself. `core/pins/model/set-status.ts`'s
   * `SetPinStatusInputV1.priorEvents` needs exactly this: the raw log, not `fold()`'s
   * folded `Pin[]`, because `Pin` (`entities/pin`) cannot carry the `createdRecordId`/
   * `latestRecordId`/`updatedAt` a `PinDtoV1` requires (`core/pins/model/pin-projection.ts`'s
   * own header names this exact gap). An empty array for a page with no comments log yet,
   * mirroring `fold()`'s own rule.
   */
  readEvents(pageSlug: PageSlug): Promise<FailureDtoV1 | readonly PinEvent[]>;
  /**
   * Resolves which page owns a standalone `pinId`. Needed because `pin.setStatus`'s payload
   * and capability target (kernel-command-contract §8.2/§10.1) carry only `{ pinId, status }`
   * — never a `pageSlug` — at any layer (verified against `core/protocol/model/
   * command-payload.ts`'s `pinSetStatusPayloadSchema` and `core/capabilities/model/
   * target.ts`'s `pin.setStatus` extractor), while every other `PinReader`/`PinMutations`
   * method here is scoped by an explicit `pageSlug` parameter. `null` is a genuine miss — no
   * page's pin log currently contains a `pin:created` for this id — never conflated with a
   * real I/O fault, which surfaces as `FailureDtoV1` instead (mirrors `core/ports/
   * projections.ts`'s own "a missing/malformed entry is a MISS, never an error" convention).
   */
  findPageForPin(pinId: string): Promise<FailureDtoV1 | PageSlug | null>;
}

export interface PinMutations {
  /** A standalone `pin:created`/`pin:status` event — not the turn's automatic resolution. */
  appendStandaloneEvent(pageSlug: PageSlug, event: PinEvent): Promise<FailureDtoV1 | undefined>;
}
