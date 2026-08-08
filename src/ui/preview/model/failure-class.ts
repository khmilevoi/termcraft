import type { FailureDtoV1 } from "core/protocol";

/**
 * The host failure codes that mean THE DESIGN failed, as opposed to the host never getting far
 * enough to run it (spec §3.2.1; design-tree §9.4). `core/kernel`'s `hostCircuitOpenedEvents`
 * copies the failing incarnation's code into `finalFailure.details.hostFailureCode`; this is the
 * single place in `src/ui` that reads it.
 *
 * `MOUNT_TIMEOUT` joined `DESIGN_RENDER_FAILED` when an incarnation started serving a whole
 * tree revision (§9.2). The handshake has already succeeded by the time a mount is sent, so the
 * child is proven alive and responsive; a mount that then produces no `ready` — or a `ready`
 * with no frame — is the page's own module-init or render loop, which is precisely what §9.4's
 * watchdog exists for ("The watchdog exists for infinite loops and runaway allocation only").
 * Telling the user their host is unavailable would be as false as telling them their design
 * crashed when a temp directory was unwritable, which is the accusation this module's original
 * comment was written to prevent.
 */
const DESIGN_AT_FAULT_HOST_FAILURE_CODES: ReadonlySet<string> = new Set([
  "DESIGN_RENDER_FAILED",
  "MOUNT_TIMEOUT",
]);

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
 * `undefined` is NOT design-at-fault. The production Kernel path always populates the detail, so
 * its absence means another port implementation — never a known-but-unnamed code. Accusing the
 * page requires positive evidence that the page is what failed.
 */
export function isDesignRenderFailure(finalFailure: FailureDtoV1): boolean {
  const code = finalFailure.details.hostFailureCode;
  return typeof code === "string" && DESIGN_AT_FAULT_HOST_FAILURE_CODES.has(code);
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
