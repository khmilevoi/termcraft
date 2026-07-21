import type { PinMutations } from "core/ports";
import type { FrameTokenLedger, GeometryTokenLedger } from "core/preview";
import type { EventPayloadByKindV1, FailureDtoV1, GeometryTokenV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { PinCreatedEvent } from "entities/pin";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

type PinsChangedPayloadV1 = EventPayloadByKindV1["pins.changed"];

/**
 * `pin.create` (kernel-command-contract §8.2, §12.6 item 6): "Resolve, verify, and consume
 * the Kernel-issued opaque token against the current displayed frame, then append a
 * pin-created event through the Kernel transaction service." This is the mutation
 * `core/pins/types.ts`'s own note calls out as this file's job — "only its own capability
 * guard (frame/geometry token verification) and mutation function are missing" — plugging
 * into the SAME `PinMutations.appendStandaloneEvent` port `set-status.ts` already uses,
 * with a `pin:created` event instead of `pin:status`.
 *
 * Unlike `setPinStatus`, this function needs no fold over `priorEvents`: a freshly created
 * pin's complete `PinDtoV1` is fully known from the ONE event being appended right now
 * (`pinId`, `elementId`/`fx`/`fy` from the consumed anchor, `text` from the input,
 * `status: "open"`, and `createdRecordId === latestRecordId === recordId`) — there is no
 * prior state to fold against.
 *
 * Token verification order matches §12.6 items 5-6 exactly: `GeometryTokenLedger.consume`
 * is checked BEFORE anything is appended, and it is checked against
 * `FrameTokenLedger.currentIdentity()` — "the frame currently acknowledged as displayed" —
 * never against the identity captured at geometry-mint time alone. `GEOMETRY_TOKEN_STALE`
 * covers both "the token's bound identity no longer matches" AND "nothing is currently
 * displayed at all" (`currentIdentity() === null`): either way, nothing can currently match.
 *
 * §8.1's own negative is asserted by this file's own test, not by construction here: "A
 * frame token is never minted by geometry ... and CANNOT authorize `pin.create`." Feeding a
 * live, acknowledged `FrameTokenV1` in as if it were a `GeometryTokenV1` fails structurally
 * — `GeometryTokenLedger` is a SEPARATE ledger keyed by its own minted ids, so a frame
 * token's id is simply unknown to it (`GEOMETRY_TOKEN_INVALID`), by construction rather than
 * by an explicit type-tag check this function would otherwise have to remember to run.
 */

export interface CreatePinInputV1 {
  readonly geometryToken: GeometryTokenV1;
  readonly text: string;
}

export type CreatePinResultV1 =
  | { readonly kind: "rejected"; readonly code: "GEOMETRY_TOKEN_INVALID" | "GEOMETRY_TOKEN_STALE" }
  | { readonly kind: "created"; readonly payload: PinsChangedPayloadV1 };

export interface CreatePinDeps {
  readonly pinMutations: PinMutations;
  readonly clock: Clock;
  readonly frameTokenLedger: FrameTokenLedger;
  readonly geometryTokenLedger: GeometryTokenLedger;
}

export async function createPin(
  deps: CreatePinDeps,
  input: CreatePinInputV1,
): Promise<FailureDtoV1 | CreatePinResultV1> {
  const currentIdentity = deps.frameTokenLedger.currentIdentity();
  if (currentIdentity === null) return { kind: "rejected", code: "GEOMETRY_TOKEN_STALE" };

  const consumed = deps.geometryTokenLedger.consume(input.geometryToken, currentIdentity);
  if (!consumed.ok) return { kind: "rejected", code: consumed.code };

  const pageSlug = parsePageSlug(consumed.anchor.pageSlug);
  if (pageSlug instanceof Error) {
    // The anchor's pageSlug came from a previously resolved geometry query (never
    // caller-supplied here) — this is a contract violation in whatever minted the anchor,
    // not a reachable user-input problem. Per the errore rule against silently swallowing
    // errors, it is logged before being reported as a bounded failure.
    console.error(
      `pin.create: geometry anchor pageSlug "${consumed.anchor.pageSlug}" failed to parse: ${pageSlug.message}`,
    );
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: "geometry anchor named an invalid page",
      details: {},
    };
  }

  const pinId = uuidv7();
  const recordId = uuidv7();
  const ts = deps.clock.now().toISOString();
  const event: PinCreatedEvent = {
    kind: "pin:created",
    recordId,
    pinId,
    element: consumed.anchor.elementId,
    fx: consumed.anchor.fx,
    fy: consumed.anchor.fy,
    text: input.text,
    ts,
  };

  const appended = await deps.pinMutations.appendStandaloneEvent(pageSlug, event);
  if (appended !== undefined) return appended;

  return {
    kind: "created",
    payload: {
      pageSlug,
      affectedPins: [
        {
          pinId,
          pageSlug,
          elementId: consumed.anchor.elementId,
          fx: consumed.anchor.fx,
          fy: consumed.anchor.fy,
          text: input.text,
          status: "open",
          createdRecordId: recordId,
          latestRecordId: recordId,
          updatedAt: ts,
        },
      ],
      affectedRecordIds: [recordId],
      // §8.3: "the operation identity is the domain identity when one already exists ...
      // pinId for pin.create" — the newly minted pin's own id is what caused this change.
      causeId: pinId,
    },
  };
}
