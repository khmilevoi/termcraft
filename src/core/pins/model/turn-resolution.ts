import type { ResolvedPinAppendV1 } from "core/ports";
import type { PageSlug } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";

/**
 * Sent-pin turn resolution (kernel-command-contract §12.2 item 8; turn-durability §7.4
 * item 5): "Sent pins are resolved only by this Kernel transaction after successful apply
 * when their page is in non-empty `changedPages`; an empty design diff resolves none."
 *
 * `sentPins` is the CLOSED list captured at turn admission (§7.2: "captures... only
 * currently open, resolvable pins" — kernel-command-contract §12.2 item 1). This function
 * has no other pin source and never re-scans a page's live pin log, which is exactly what
 * makes "pins created after turn capture are not part of that turn and remain open" hold:
 * a pin created after admission was never added to `sentPins`, so it structurally cannot
 * appear in this function's output.
 *
 * The finalize-time filter — resolve a sent pin ONLY when its page is in the non-empty
 * `changedPages` set — is this module's own authoritative decision, matching the same rule
 * `core/ports/fakes/turn-transactions.ts`'s fake redundantly re-applies as a defense-in-depth
 * check on `TurnFinalizeInputV1.resolvedPins` (see that fake's own header).
 */

export interface SentPinV1 {
  readonly pinId: string;
  readonly pageSlug: PageSlug;
}

export interface ResolveSentPinAppendsInputV1 {
  readonly turnId: string;
  readonly sentPins: readonly SentPinV1[];
  readonly changedPages: readonly PageSlug[];
  readonly createdAt: string;
}

/** Builds the turn's automatic `pin:status resolved` appends — never a user-action `actionId`. */
export function resolveSentPinAppends(
  input: ResolveSentPinAppendsInputV1,
): readonly ResolvedPinAppendV1[] {
  // §7.4 item 5, verbatim: "An empty design diff resolves no pin."
  if (input.changedPages.length === 0) return [];

  const changed = new Set(input.changedPages);
  return input.sentPins
    .filter((pin) => changed.has(pin.pageSlug))
    .map(
      (pin): ResolvedPinAppendV1 => ({
        pageSlug: pin.pageSlug,
        event: {
          kind: "pin:status",
          recordId: uuidv7(),
          pinId: pin.pinId,
          status: "resolved",
          turnId: input.turnId,
          ts: input.createdAt,
        },
      }),
    );
}
