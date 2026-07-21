import * as errore from "errore";

import type { PinDtoV1 } from "core/protocol";
import type { PageSlug } from "entities/page";
import type { PinEvent } from "entities/pin";

/**
 * Folds a page's raw pin-event log into complete `PinDtoV1`s (kernel-command-contract §9:
 * `PinDtoV1` needs `createdRecordId`, `latestRecordId`, `updatedAt`, `elementId`).
 *
 * KNOWN DIVERGENCE (phase-6 plan §5, verbatim): "`PinDtoV1` needs `createdRecordId`,
 * `latestRecordId`, `updatedAt`, which `entities/pin`'s `foldPins` does not carry — either
 * the Kernel folds record ids itself or `entities/pin` extends `Pin`." This file is that
 * first option: `entities/pin`'s own `Pin`/`foldPins` stay untouched (out of this agent's
 * file assignment), and this module runs its OWN fold directly over the same `PinEvent`
 * union, additionally tracking each pin's creating/latest record id and last-touched
 * timestamp — the two pieces of information `Pin` structurally cannot carry today.
 *
 * The corruption rules are deliberately identical to `entities/pin`'s `foldPins` (a second
 * `pin:created` for one `pinId`, or a `pin:status` before its `pin:created`) — same log,
 * same fold semantics, just enriched — so this module can never legitimately disagree with
 * `PinReader.fold()`'s own notion of which pins exist or what their current status is.
 *
 * `core/ports/pin-store.ts`'s `PinReader.fold()` returns only `entities/pin`'s `Pin[]` —
 * no record ids — so it cannot supply this function's input. `events` is therefore an
 * explicit parameter, not fetched through a port here; wiring a real caller to supply the
 * complete raw log (widening `PinReader`, or reading it directly since the real store's
 * JSONL already has it) is a later integration step this file leaves as an obvious seam,
 * not something it papers over with a fabricated id.
 */
export class PinProjectionError extends errore.createTaggedError({
  name: "PinProjectionError",
  message: "pin projection failed for pageSlug $pageSlug: $reason",
}) {}

interface FoldEntry {
  readonly pinId: string;
  elementId: string;
  fx: number;
  fy: number;
  text: string;
  status: "open" | "resolved";
  readonly createdRecordId: string;
  latestRecordId: string;
  updatedAt: string;
  readonly order: number;
}

export function projectPinEvents(
  pageSlug: PageSlug,
  events: readonly PinEvent[],
): PinProjectionError | readonly PinDtoV1[] {
  const byId = new Map<string, FoldEntry>();
  let order = 0;

  for (const event of events) {
    if (event.kind === "pin:created") {
      if (byId.has(event.pinId)) {
        return new PinProjectionError({
          pageSlug,
          reason: `duplicate pin:created for pinId ${event.pinId}`,
        });
      }
      byId.set(event.pinId, {
        pinId: event.pinId,
        elementId: event.element,
        fx: event.fx,
        fy: event.fy,
        text: event.text,
        status: "open",
        createdRecordId: event.recordId,
        latestRecordId: event.recordId,
        updatedAt: event.ts,
        order: order++,
      });
      continue;
    }

    const existing = byId.get(event.pinId);
    if (existing === undefined) {
      return new PinProjectionError({
        pageSlug,
        reason: `pin:status before pin:created for pinId ${event.pinId}`,
      });
    }
    existing.status = event.status;
    existing.latestRecordId = event.recordId;
    existing.updatedAt = event.ts;
  }

  return [...byId.values()]
    .sort((a, b) => a.order - b.order)
    .map(
      (entry): PinDtoV1 => ({
        pinId: entry.pinId,
        pageSlug,
        elementId: entry.elementId,
        fx: entry.fx,
        fy: entry.fy,
        text: entry.text,
        status: entry.status,
        createdRecordId: entry.createdRecordId,
        latestRecordId: entry.latestRecordId,
        updatedAt: entry.updatedAt,
      }),
    );
}
