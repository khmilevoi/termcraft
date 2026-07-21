import type { PinMutations } from "core/ports";
import type { EventPayloadByKindV1, FailureDtoV1 } from "core/protocol";
import type { PageSlug } from "entities/page";
import type { PinEvent, PinStatusEvent } from "entities/pin";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import { projectPinEvents } from "./pin-projection";

type PinsChangedPayloadV1 = EventPayloadByKindV1["pins.changed"];

/**
 * `pin.setStatus` (kernel-command-contract §8.2): "Append a user-action pin-status event
 * if Current design and lifecycle state permit it." This function is the append + payload
 * assembly; the "Current design and lifecycle state" precondition is a guard-layer concern
 * (`core/capabilities/model/guards.ts`'s `HISTORICAL_PREVIEW_READ_ONLY` check already
 * covers `pin.setStatus` — see that file's own list) evaluated BEFORE this ever runs, not
 * re-checked here.
 *
 * `priorEvents` is the page's complete prior pin-event log — see `pin-projection.ts`'s own
 * header for why this is a plain parameter rather than a `PinReader.fold()` call: `fold()`
 * returns only `entities/pin`'s `Pin[]`, which cannot supply the `createdRecordId` this
 * function's resulting DTO needs.
 *
 * The appended event carries a fresh `actionId` (§8.1's "user-action" pin-status kind, per
 * `core/ports/pin-store.ts`'s own doc: "a user open/reopen/create action outside a turn") —
 * never a `turnId`, which is reserved for a turn's own automatic resolution
 * (`TurnFinalizeInputV1.resolvedPins`, a different code path this function does not touch).
 * That same `actionId` becomes `pins.changed`'s `causeId` — "the transaction/action
 * identity that caused" this change (§9).
 */

export interface SetPinStatusInputV1 {
  readonly pageSlug: PageSlug;
  readonly pinId: string;
  readonly status: "open" | "resolved";
  readonly priorEvents: readonly PinEvent[];
}

export type SetPinStatusResultV1 =
  | { readonly kind: "not-found" }
  | { readonly kind: "updated"; readonly payload: PinsChangedPayloadV1 };

export interface SetPinStatusDeps {
  readonly pinMutations: PinMutations;
  readonly clock: Clock;
}

export async function setPinStatus(
  deps: SetPinStatusDeps,
  input: SetPinStatusInputV1,
): Promise<FailureDtoV1 | SetPinStatusResultV1> {
  const before = projectPinEvents(input.pageSlug, input.priorEvents);
  if (before instanceof Error) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: before.message,
      details: {},
    };
  }
  const existing = before.find((pin) => pin.pinId === input.pinId);
  if (existing === undefined) return { kind: "not-found" };

  const actionId = uuidv7();
  const event: PinStatusEvent = {
    kind: "pin:status",
    recordId: uuidv7(),
    pinId: input.pinId,
    status: input.status,
    actionId,
    ts: deps.clock.now().toISOString(),
  };

  const appended = await deps.pinMutations.appendStandaloneEvent(input.pageSlug, event);
  if (appended !== undefined) return appended;

  const after = projectPinEvents(input.pageSlug, [...input.priorEvents, event]);
  if (after instanceof Error) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: after.message,
      details: {},
    };
  }
  const updated = after.find((pin) => pin.pinId === input.pinId);
  if (updated === undefined) {
    // The append succeeded and `before` found this exact pinId — `after` failing to find it
    // now would mean the fold disagrees with itself between two adjacent calls, which is a
    // contract violation in this module's own fold, not a reachable input-data problem.
    console.error(
      `core/pins: pinId ${input.pinId} vanished from the fold immediately after its own status append`,
    );
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: "pin projection lost its own pin",
      details: {},
    };
  }

  return {
    kind: "updated",
    payload: {
      pageSlug: input.pageSlug,
      affectedPins: [updated],
      affectedRecordIds: [event.recordId],
      causeId: actionId,
    },
  };
}
