import * as errore from "errore";

import type { FrameIdentityV1, FrameTokenV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";

/**
 * `FrameTokenLedger` (kernel-command-contract §8.1, §12.6 item 4, §13.3).
 *
 * §8.1, verbatim: "For each frame-stream item, the Kernel mints a `FrameTokenV1` ... The
 * UI's typed display acknowledgement names `frameTokenId`; it is a `PreviewSession` broker
 * message, not a Kernel command and does not change `stateRevision`. The broker keeps
 * exactly one current displayed frame token per live session. A later display
 * acknowledgement, session/source switch, host nonce change, or close invalidates the
 * prior token." §13.3 adds the exact temporal rule this ledger implements: "A frame token
 * is unusable before display acknowledgement and stale after the next acknowledgement."
 *
 * Because acknowledgement is explicitly "not a Kernel command", its own failure has no
 * `UnavailableReason` code to report — {@link FrameAckError} is a local tagged error, never
 * one of the 31 codes. `verifyCurrent` is the function `preview.queryGeometry` calls
 * (§12.6 item 5: "verifies that frame token before any host request"), and IS where the
 * two public codes belong: `FRAME_TOKEN_INVALID` for a token that never became the
 * acknowledged frame (unusable, per §13.3 — this also covers a token this ledger never
 * minted at all), `FRAME_TOKEN_STALE` for one that was acknowledged but has since been
 * superseded by a later acknowledgement or an explicit {@link invalidateCurrent} call.
 *
 * Only three slots are kept — the latest unacknowledged mint (`pending`), the current
 * acknowledged token (`current`), and the one it superseded (`previous`, kept only so a
 * check immediately after the next acknowledgement can still say STALE rather than
 * INVALID, matching §13.3's own "stale after the next acknowledgement" wording literally).
 * Anything older simply becomes unrecognized (`FRAME_TOKEN_INVALID`) — the spec bounds
 * `GeometryTokenV1`'s ledger explicitly (4,096 entries, 30 seconds) but never asks a frame
 * token to be reconstructable arbitrarily far into the past, and at up to 240 frames per
 * second (host-supervision §8) an unbounded map here would never stop growing.
 *
 * Deliberately plain closures, not Reatom atoms — see `frame-broker.ts`'s header for the
 * same reasoning (`core/turns/model/deadlines.ts` precedent; nothing needs this reactively,
 * and KCC §5 forbids a connect hook owning it).
 */
export class FrameAckError extends errore.createTaggedError({
  name: "FrameAckError",
  message: "frame token acknowledgement rejected: $reason",
}) {}

export type FrameTokenVerification =
  | { readonly ok: true; readonly identity: FrameIdentityV1 }
  | { readonly ok: false; readonly code: "FRAME_TOKEN_INVALID" | "FRAME_TOKEN_STALE" };

export interface FrameTokenLedger {
  /** Mints a fresh opaque token for one frame-stream item, replacing any prior un-acknowledged pending mint. */
  readonly mint: (identity: FrameIdentityV1) => FrameTokenV1;
  /** The UI's typed display acknowledgement. Succeeds only for the exact live pending mint. */
  readonly acknowledge: (frameToken: FrameTokenV1) => FrameAckError | FrameIdentityV1;
  /** What `preview.queryGeometry` calls before any host request (§12.6 item 5). */
  readonly verifyCurrent: (frameToken: FrameTokenV1) => FrameTokenVerification;
  /** Session/source switch, host nonce change, or close (§8.1) — demotes the current token to stale. */
  readonly invalidateCurrent: () => void;
  /** The currently acknowledged frame identity, or `null` before any acknowledgement / after invalidation. */
  readonly currentIdentity: () => FrameIdentityV1 | null;
}

interface TokenEntry {
  readonly token: FrameTokenV1;
  readonly identity: FrameIdentityV1;
}

/** Builds one live session's frame-token ledger. A factory, not module state: two sessions must never share one. */
export function createFrameTokenLedger(): FrameTokenLedger {
  let pending: TokenEntry | null = null;
  let current: TokenEntry | null = null;
  let previous: TokenEntry | null = null;

  function mint(identity: FrameIdentityV1): FrameTokenV1 {
    const token = uuidv7();
    pending = { token, identity };
    return token;
  }

  function acknowledge(frameToken: FrameTokenV1): FrameAckError | FrameIdentityV1 {
    if (pending === null || pending.token !== frameToken) {
      return new FrameAckError({
        reason: `frame token "${frameToken}" is not the live pending minted frame`,
      });
    }
    if (current !== null) previous = current;
    current = pending;
    pending = null;
    return current.identity;
  }

  function verifyCurrent(frameToken: FrameTokenV1): FrameTokenVerification {
    if (current !== null && current.token === frameToken) {
      return { ok: true, identity: current.identity };
    }
    if (previous !== null && previous.token === frameToken) {
      return { ok: false, code: "FRAME_TOKEN_STALE" };
    }
    return { ok: false, code: "FRAME_TOKEN_INVALID" };
  }

  function invalidateCurrent(): void {
    if (current !== null) previous = current;
    current = null;
    pending = null;
  }

  function currentIdentity(): FrameIdentityV1 | null {
    return current === null ? null : current.identity;
  }

  return { mint, acknowledge, verifyCurrent, invalidateCurrent, currentIdentity };
}
