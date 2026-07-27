import type { FailureDtoV1 } from "core/protocol";

/**
 * The one host failure code whose cause IS the page's own source. `core/kernel`'s
 * `hostCircuitOpenedEvents` copies the failing incarnation's code into
 * `finalFailure.details.hostFailureCode`; this is the single place in `src/ui` that reads it.
 */
const DESIGN_RENDER_FAILED = "DESIGN_RENDER_FAILED";

/**
 * Did the PAGE fail, or did the host never get as far as running it? (spec §3.2.1)
 *
 * A `circuit-open` preview looks identical from the mirror either way — same phase, same
 * latched circuit, same empty pane — but the two mean opposite things to the user. A page that
 * threw while rendering is theirs to fix, and `F6` offers to write that repair request. A spawn
 * failure, a handshake timeout, a broken pipe or a runtime-integrity mismatch is not: no edit to
 * `page.tsx` makes a temp directory writable, and telling the user their design crashed would be
 * a false accusation.
 *
 * `undefined` is NOT `DESIGN_RENDER_FAILED`. The production Kernel path always populates the
 * detail, so its absence means another port implementation — never a known-but-unnamed code.
 * Accusing the page requires positive evidence that the page is what failed.
 */
export function isDesignRenderFailure(finalFailure: FailureDtoV1): boolean {
  return finalFailure.details.hostFailureCode === DESIGN_RENDER_FAILED;
}

/**
 * The failing incarnation's own code, or `undefined` when the event carried none. The one reader
 * of `details.hostFailureCode` besides {@link isDesignRenderFailure} — `wsHostUnavailable` shows
 * it raw, because a stable identifier is the thing a user can actually quote when asking for help.
 */
export function hostFailureCodeOf(finalFailure: FailureDtoV1): string | undefined {
  const code = finalFailure.details.hostFailureCode;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}
