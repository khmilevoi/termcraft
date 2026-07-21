/**
 * `core/pins`'s shared vocabulary (CLAUDE.md "Code style": `types.ts` holds a module's
 * shared types). Nothing here yet — `pin-projection.ts`'s `PinProjectionError` and
 * `set-status.ts`'s `SetPinStatusInputV1`/`SetPinStatusResultV1`/`SetPinStatusDeps` are
 * each reached for by only one file, so they stay local to it (matching `core/mailbox`'s
 * precedent: a request/dependency shape lives with its one caller, not here, until a
 * second file needs the same shape).
 *
 * `pin.create` (kernel-command-contract §8.2, §12.6) belongs to a later slice (6G) — it
 * needs a `GeometryTokenV1` this module does not mint. Its eventual seam is
 * `PinMutations.appendStandaloneEvent` with a `pin:created` event, the SAME port
 * `set-status.ts` already uses for `pin:status` — no new port shape is needed here for
 * 6G to plug into; only its own capability guard (frame/geometry token verification) and
 * mutation function are missing.
 */
export {};
