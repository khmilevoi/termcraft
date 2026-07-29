import type { FailureDtoV1 } from "core/protocol";
import type { PageSlug } from "entities/page";
import type { Pin, PinEvent } from "entities/pin";

import type { ReadSetAppendBaseV1 } from "./staging";

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
 *
 * `readAppendBase` is the pin-log analogue of `ChatReader.readAppendBase`
 * (`core/ports/chat-store.ts`) — same "Gap 4" precedent (kernel-assembly Task 9), closed here
 * for pins by phase-8 WP-6 (`docs/superpowers/specs/2026-07-25-mvp-phase-8-design.md` §WP-6:
 * "`candidatePins` and `readSet.pins` are populated from the active page's open pins"). Before
 * this method existed, `core/kernel/model/handlers/turn.ts` could only leave
 * `AdmissionWorkspaceMaterialV1.readSet.pins` an honest `[]` — never the SAME shape of gap
 * `runtimeDocs` is in ("no port sources this at all"), but a narrower one: `readSet.pins`
 * genuinely matters for `store/transaction/model/wrappers.ts`'s `buildFinalizeCasPrecondition`,
 * which compares each entry against the live per-page comments log and fails
 * `StaleError({part: "pins:<slug>"})` on drift, so an empty list there silently disabled that
 * concurrency check for every pin edit. `ReadSetAppendBaseV1` is reused verbatim from
 * `./staging` — the same cross-port-file reuse `ChatReader.readAppendBase` already relies on.
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
  /**
   * The page's comments-log send-time append-base — `{length, prefixSha256}` ({@link
   * ReadSetAppendBaseV1}), turn-durability §7.5's own CAS baseline `turn.start` durably
   * captures at admission and `finalizeTurn` re-checks before ever committing a write. See
   * this interface's own header for the full "Gap 4 pin analogue" citation.
   *
   * Mirrors `fold()`/`readEvents()`'s own "no comments log yet" rule, NOT
   * `ChatReader.readAppendBase`'s: a page with no comments log at all returns the honest
   * empty base `{length: 0, prefixSha256: <sha256 of zero bytes>}` — the exact value
   * `store/transaction/model/wrappers.ts`'s own `emptyBefore()` produces for a missing file,
   * and the exact fact `buildFinalizeCasPrecondition` compares its own
   * `readPinsBefore(fs, pinsJsonlPath(slug))` result against. This deliberately diverges
   * from `ChatReader.readAppendBase`, which treats a missing file as a genuine failure — that
   * method is only ever called immediately after `turnTransactions.admit(...)` durably
   * appends to that exact chat file, so a miss there is unexpected; a page's comments log,
   * by contrast, legitimately does not exist until its first pin is created, exactly like
   * `readEvents()`'s own `[]`-for-missing-log convention. Only a genuine I/O or decode fault
   * is a `FailureDtoV1` here.
   *
   * Port + fake only here — the real adapter is `store/adapters/pin-store.ts`'s job,
   * mirroring `ChatReader.readAppendBase`'s identical division.
   */
  readAppendBase(pageSlug: PageSlug): Promise<FailureDtoV1 | ReadSetAppendBaseV1>;
}

export interface PinMutations {
  /** A standalone `pin:created`/`pin:status` event — not the turn's automatic resolution. */
  appendStandaloneEvent(pageSlug: PageSlug, event: PinEvent): Promise<FailureDtoV1 | undefined>;
}
