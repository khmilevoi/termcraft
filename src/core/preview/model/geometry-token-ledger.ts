import type { FrameIdentityV1, GeometryTokenV1 } from "core/protocol"
import type { Clock } from "infrastructure/clock"
import { uuidv7 } from "infrastructure/uuid"

/**
 * `GeometryTokenLedger` (kernel-command-contract §8.1, §12.6 items 5-6, §13.3).
 *
 * §8.1, verbatim: "Only a successful `hit` or `pin-anchor` geometry result ... causes the
 * Kernel to mint a separate opaque `GeometryTokenV1`; its private ledger entry binds
 * `(FrameIdentityV1, pageSlug, elementId, fx, fy)`. The Kernel stores the canonical
 * geometry token in a bounded 4,096-entry ledger for at most 30 seconds;
 * session/source/incarnation/displayed-frame change invalidates it immediately, and
 * successful `pin.create` consumes it once."
 *
 * §11.1 fixes the two-code split this module's `consume` implements exactly:
 * `GEOMETRY_TOKEN_INVALID` — "absent, malformed, EXPIRED, or ALREADY-CONSUMED" — and
 * `GEOMETRY_TOKEN_STALE` — "session/incarnation/source/frame is not the current frame
 * acknowledged as displayed." So STALE is the identity-mismatch case ONLY; every other
 * failure (unknown token, expired token, a token already spent) is INVALID.
 *
 * Notably this means "session/source/incarnation/displayed-frame change invalidates it
 * immediately" needs no separate invalidation method here: `consume` is always given the
 * CALLER's freshest `currentIdentity` (from `FrameTokenLedger.currentIdentity()`) and
 * compares it field-by-field against the identity captured at mint time. Any of those four
 * changing is exactly a field no longer matching, which `consume` already refuses as STALE
 * — there is nothing left for a proactive invalidation pass to do that the comparison
 * itself does not already do lazily, on demand, with no timer (matching
 * `core/turns/model/deadlines.ts`'s own "no timers, checked on demand against an injected
 * clock" reasoning, and KCC §5's ban on a connect hook owning a ledger's lifetime).
 *
 * Eviction on overflow is FIFO (oldest mint first): §8.1 does not name an eviction policy,
 * and every resolving geometry query is documented to always mint successfully — inventing
 * a "ledger full" rejection code that does not exist in the 31-code registry would be
 * worse than simply bounding memory the same way an LRU-by-insertion cache would.
 */

export const GEOMETRY_TOKEN_LEDGER_CAPACITY = 4096
export const GEOMETRY_TOKEN_TTL_MS = 30_000

/** The private binding one geometry token guards — never inspectable or editable by the UI (§8.1). */
export interface GeometryAnchorV1 {
  readonly identity: FrameIdentityV1
  readonly pageSlug: string
  readonly elementId: string
  readonly fx: number
  readonly fy: number
}

export type GeometryTokenConsumption =
  | { readonly ok: true; readonly anchor: GeometryAnchorV1 }
  | { readonly ok: false; readonly code: "GEOMETRY_TOKEN_INVALID" | "GEOMETRY_TOKEN_STALE" }

export interface GeometryTokenLedgerDeps {
  readonly clock: Clock
}

export interface GeometryTokenLedger {
  /** Mints a fresh opaque token for a successful resolving `hit`/`pin-anchor` query. Always succeeds — evicts the oldest entry first if at capacity. */
  readonly mint: (anchor: GeometryAnchorV1) => GeometryTokenV1
  /** `pin.create`'s token check (§12.6 item 6): consumes the entry once on success, never on a STALE identity mismatch. */
  readonly consume: (token: GeometryTokenV1, currentIdentity: FrameIdentityV1) => GeometryTokenConsumption
  /** The live entry count — for capacity-bound tests, never a public capability signal. */
  readonly size: () => number
}

interface LedgerEntry {
  readonly anchor: GeometryAnchorV1
  readonly mintedAtMs: number
}

function identitiesMatch(a: FrameIdentityV1, b: FrameIdentityV1): boolean {
  return (
    a.previewSessionId === b.previewSessionId &&
    a.nonce === b.nonce &&
    a.sourceHash === b.sourceHash &&
    a.frameSeq === b.frameSeq
  )
}

/** Builds one Kernel's geometry-token ledger. A factory, not module state: two kernels — or two tests — must never share one. */
export function createGeometryTokenLedger(deps: GeometryTokenLedgerDeps): GeometryTokenLedger {
  // Map iteration order is insertion order in JS, which is exactly what FIFO eviction needs.
  const entries = new Map<GeometryTokenV1, LedgerEntry>()

  function mint(anchor: GeometryAnchorV1): GeometryTokenV1 {
    if (entries.size >= GEOMETRY_TOKEN_LEDGER_CAPACITY) {
      const oldestKey = entries.keys().next().value
      if (oldestKey !== undefined) entries.delete(oldestKey)
    }
    const token = uuidv7()
    entries.set(token, { anchor, mintedAtMs: deps.clock.now().getTime() })
    return token
  }

  function consume(token: GeometryTokenV1, currentIdentity: FrameIdentityV1): GeometryTokenConsumption {
    const entry = entries.get(token)
    if (entry === undefined) return { ok: false, code: "GEOMETRY_TOKEN_INVALID" }

    const ageMs = deps.clock.now().getTime() - entry.mintedAtMs
    if (ageMs >= GEOMETRY_TOKEN_TTL_MS) {
      entries.delete(token)
      return { ok: false, code: "GEOMETRY_TOKEN_INVALID" }
    }

    if (!identitiesMatch(entry.anchor.identity, currentIdentity)) {
      return { ok: false, code: "GEOMETRY_TOKEN_STALE" }
    }

    entries.delete(token) // consumed once (§8.1) — only on the success path.
    return { ok: true, anchor: entry.anchor }
  }

  function size(): number {
    return entries.size
  }

  return { mint, consume, size }
}
