import type { PreviewFrameV1, PreviewSession } from "core/ports";
import type { CommandResultV1, FrameIdentityV1, FrameTokenV1, UUIDv7 } from "core/protocol";

import type { EventEnvelopeV1 } from "./model/events";

/** One frame exactly as the UI may display it, including its acknowledgement authority. */
export interface UiPreviewFrame {
  readonly frame: PreviewFrameV1;
  readonly frameToken: FrameTokenV1;
  readonly handle: PreviewSessionHandle;
}

/**
 * The narrow Kernel boundary `ui` depends on (phase-7 plan D1). Declared by `ui`, faked in
 * tests (`ui/testing`), and satisfied by the phase-8 composition root — which adapts
 * `core/mailbox`'s `Dispatch`/`EventBus` and `core/ports`' `PreviewSession` to it. `ui`
 * never imports a composed Kernel object (none exists) nor `core/mailbox`/`core/capabilities`
 * internals: only the DTOs crossing this boundary.
 *
 * Return types are widened to `Error` (from the real `CommandDecodeError | CanonicalHashError`
 * / `EventBusPayloadError`) so the port stays decoupled from those error classes while the
 * real implementations remain directly assignable — every one of them extends `Error`.
 */
export interface KernelPort {
  /**
   * Submits a raw command envelope. The Kernel decodes/validates it, so `ui` only
   * constructs `{ protocolVersion, commandId, expectedRevision, kind, payload }` (via the
   * dispatcher) — it never pre-validates. Resolves to the accepted/rejected result, or an
   * `Error` for a protocol/decode/hash failure a well-formed UI envelope should never hit.
   */
  dispatch(raw: unknown): Promise<Error | CommandResultV1>;
  /**
   * Registers an event handler. The bus delivers one `kernel.snapshot` synchronously before
   * returning (the mirror's bootstrap read). Returns an unsubscribe function, or an `Error`
   * if that bootstrap snapshot fails its own schema. There is no replay buffer (§9): a late
   * subscriber only sees state from its own snapshot forward.
   */
  subscribe(handler: (envelope: EventEnvelopeV1) => void): Error | (() => void);
  /** The current live preview session, or `null` when no preview is established. */
  preview(): PreviewSessionHandle | null;
}

/**
 * A live preview session as the UI holds it: the Kernel-narrowed `PreviewSession` plus the
 * typed display acknowledgement the UI sends after painting a frame (kernel-command-contract
 * §8.1). `acknowledgeDisplay` is a broker-adjacent message, NOT a `dispatch()` command — it
 * does not change `stateRevision` — so it lives on the handle, not behind `KernelPort.dispatch`.
 * A token becomes query-authorising only after this ack; `preview.queryGeometry` then travels
 * as a real command.
 */
export interface PreviewSessionHandle {
  readonly previewSessionId: UUIDv7;
  readonly session: PreviewSession;
  /**
   * Display-ready frames. The phase-8 adapter pairs every Kernel-minted token with the exact
   * frame and handle that produced it; the UI must not reconstruct that authority itself.
   */
  readonly frames: AsyncIterable<UiPreviewFrame>;
  acknowledgeDisplay(frameToken: FrameTokenV1): Error | FrameIdentityV1;
}
