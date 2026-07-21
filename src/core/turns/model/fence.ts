import { action, atom, type Atom } from "@reatom/core"
import * as errore from "errore"

import { isUuidv7, type UUIDv7 } from "core/protocol"
import type { TurnBackendLeaseV1, TurnFenceProbe } from "core/mailbox"

/**
 * The per-attempt lease that fences one turn's backend events
 * (kernel-command-contract §7.2, §12.2).
 *
 * The comparison itself already lives in `core/mailbox/model/signal-ingress.ts`, which
 * drops any signal not matching all three of `{turnId, attempt, leaseNonce}`. This module
 * owns the other half: MINTING the lease, and being the live source that ingress reads.
 * Two fences would be worse than none — the mailbox would compare against one while the
 * turn advanced the other.
 *
 * Why the nonce exists at all: `turnId` and `attempt` are both predictable, so a stale
 * process from attempt 2 could otherwise be mistaken for attempt 2 of a NEW turn that
 * happened to reach the same number. §12.2 item 2 therefore requires "a cryptographically
 * random 128-bit value encoded base64url" per attempt, and item 4 requires it be REPLACED
 * on every retry — "An event from any earlier attempt is stale even if it arrives before
 * cancellation cleanup."
 */

/** §7.2: "Attempts are integers 1 through 4." */
export const MAX_TURN_ATTEMPTS = 4

/** The turn is out of attempts, or its identity is malformed. */
export class TurnFenceError extends errore.createTaggedError({
  name: "TurnFenceError",
  message: "turn fence rejected the request: $reason",
}) {}

export interface TurnFence {
  /**
   * Mints the next attempt's lease: attempt 1 on the first call, then 2, 3, 4. §7.2 says
   * the first nonce "is minted only when attempt 1 starts", so no lease exists until then.
   */
  readonly beginAttempt: () => TurnFenceError | TurnBackendLeaseV1
  /** The live lease, or `null` before the first attempt and after retirement. */
  readonly currentLease: () => TurnBackendLeaseV1 | null
  /** True only for the exact live lease — all three fields must match. */
  readonly accepts: (lease: TurnBackendLeaseV1) => boolean
  /**
   * Clears the lease. §12.2 item 5 / TD §6.4 retire the fence BEFORE the candidate is
   * frozen, so an event still in flight has nothing left to match and cannot mutate a
   * turn whose result is already being captured.
   */
  readonly retire: () => void
  /** The probe `signal-ingress` reads. Safe to bind before any attempt exists. */
  readonly probe: TurnFenceProbe
  readonly leaseAtom: Atom<TurnBackendLeaseV1 | null>
}

/** A cryptographically random 128-bit value, base64url, unpadded (22 chars). */
function mintLeaseNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

/**
 * Creates one turn's fence. A factory per turn: the lease is turn-scoped state, and two
 * turns sharing one would let either accept the other's events.
 */
export function createTurnFence(turnId: string): TurnFenceError | TurnFence {
  if (!isUuidv7(turnId)) {
    return new TurnFenceError({ reason: `turnId "${turnId}" is not a canonical UUIDv7` })
  }
  const identity: UUIDv7 = turnId

  const leaseAtom = atom<TurnBackendLeaseV1 | null>(null, "kernel.turn.lease")
  const attemptAtom = atom(0, "kernel.turn.attempt")

  const beginAttempt = action((): TurnFenceError | TurnBackendLeaseV1 => {
    const next = attemptAtom() + 1
    if (next > MAX_TURN_ATTEMPTS) {
      // Refusing leaves the live lease untouched: the caller is out of retries, but the
      // attempt currently running is still the one whose events must be accepted.
      return new TurnFenceError({ reason: `attempt ${next} exceeds the ${MAX_TURN_ATTEMPTS}-attempt budget` })
    }
    const lease: TurnBackendLeaseV1 = { turnId: identity, attempt: next, leaseNonce: mintLeaseNonce() }
    attemptAtom.set(next)
    leaseAtom.set(lease)
    return lease
  }, "kernel.turn.beginAttempt")

  const retire = action(() => {
    // The attempt counter deliberately does NOT reset: retirement ends the turn's fence,
    // it does not hand back retries.
    leaseAtom.set(null)
  }, "kernel.turn.retireFence")

  function accepts(lease: TurnBackendLeaseV1): boolean {
    const live = leaseAtom()
    if (live === null) return false
    return (
      live.turnId === lease.turnId &&
      live.attempt === lease.attempt &&
      live.leaseNonce === lease.leaseNonce
    )
  }

  return {
    beginAttempt,
    currentLease: () => leaseAtom(),
    accepts,
    retire,
    // A getter, not a captured value: ingress binds this once and must still observe every
    // later mint and the retirement. Capturing `leaseAtom()` here would freeze the fence at
    // "no lease yet" forever.
    probe: { currentLease: () => leaseAtom() },
    leaseAtom,
  }
}
