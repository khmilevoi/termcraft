import type { FrameIdentityV1, GeometryTokenV1 } from "core/protocol";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

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
 * §8.1's own 2026-08-11 amendment narrows the identity half of that split and moves the
 * verdict earlier — see {@link identitiesMatch} and {@link GeometryTokenLedger.inspect}.
 *
 * Notably this means "session/source/incarnation/displayed-frame change invalidates it
 * immediately" needs no separate invalidation method here: `consume` is always given the
 * CALLER's freshest `currentIdentity` (from `FrameTokenLedger.currentIdentity()`) and
 * compares it field-by-field against the identity captured at mint time. Any of those
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

export const GEOMETRY_TOKEN_LEDGER_CAPACITY = 4096;
export const GEOMETRY_TOKEN_TTL_MS = 30_000;

/** The private binding one geometry token guards — never inspectable or editable by the UI (§8.1). */
export interface GeometryAnchorV1 {
  readonly identity: FrameIdentityV1;
  readonly pageSlug: string;
  readonly elementId: string;
  readonly fx: number;
  readonly fy: number;
}

export type GeometryTokenRefusal = {
  readonly ok: false;
  readonly code: "GEOMETRY_TOKEN_INVALID" | "GEOMETRY_TOKEN_STALE";
};

export type GeometryTokenConsumption =
  | { readonly ok: true; readonly anchor: GeometryAnchorV1 }
  | GeometryTokenRefusal;

/** {@link GeometryTokenLedger.inspect}'s verdict — the same two refusal codes, and no anchor on the success arm: a caller that has not consumed the token has no business reading its private binding. */
export type GeometryTokenVerdict = { readonly ok: true } | GeometryTokenRefusal;

export interface GeometryTokenLedgerDeps {
  readonly clock: Clock;
}

export interface GeometryTokenLedger {
  /** Mints a fresh opaque token for a successful resolving `hit`/`pin-anchor` query. Always succeeds — evicts the oldest entry first if at capacity. */
  readonly mint: (anchor: GeometryAnchorV1) => GeometryTokenV1;
  /** `pin.create`'s token check (§12.6 item 6): consumes the entry once on success, never on a STALE identity mismatch. */
  readonly consume: (
    token: GeometryTokenV1,
    currentIdentity: FrameIdentityV1,
  ) => GeometryTokenConsumption;
  /**
   * The SAME verdict {@link consume} would reach, with no side effect of any kind: nothing is
   * consumed, and an expired entry is not evicted either.
   *
   * Exists so `pin.create`'s handler can decide SYNCHRONOUSLY, at admission, whether the token
   * it was handed can still create a pin — and answer the UI with an idempotent-refusal `no-op`
   * disposition instead of admitting a command that will quietly reject inside its own async
   * operation, where the protocol has no channel to report it (`core/kernel/model/handlers/
   * page-pin.ts`'s `handlePinCreate`). `consume` cannot serve that purpose: spending the token
   * for the decision would leave the real `createPin` call nothing left to consume.
   */
  readonly inspect: (
    token: GeometryTokenV1,
    currentIdentity: FrameIdentityV1,
  ) => GeometryTokenVerdict;
  /**
   * Reinstates a just-consumed token under its ORIGINAL id, for a caller whose downstream
   * write failed after `consume` already spent it (`core/pins/model/create.ts`'s
   * `createPin`): "successful `pin.create` consumes it once" (this file's own header) means
   * consumption is tied to the WHOLE command succeeding, not merely to `consume` matching
   * the identity. Without this, a persistence failure after a successful `consume` strands
   * the user — the anchor is still legitimately displayed, but the token that named it is
   * already gone and a fresh geometry query is the only way back in. Grants a fresh 30s TTL
   * from the restore, same as a new `mint`; evicts the oldest entry first if at capacity,
   * exactly like `mint`.
   */
  readonly restore: (token: GeometryTokenV1, anchor: GeometryAnchorV1) => void;
  /** The live entry count — for capacity-bound tests, never a public capability signal. */
  readonly size: () => number;
}

interface LedgerEntry {
  readonly anchor: GeometryAnchorV1;
  readonly mintedAtMs: number;
}

/**
 * §8.1's 2026-08-11 amendment: `previewSessionId`, `nonce` and `sourceHash` — deliberately
 * NOT `frameSeq`.
 *
 * What this comparison protects is that the anchor's `(elementId, fx, fy)` still names what
 * the user pointed at. A different session or incarnation may reuse element ids for an
 * entirely different tree, and a different `sourceHash` IS a different tree — so all three
 * must match exactly. A later frame of the SAME source is the same element tree with
 * different dynamic content: the id still names the same element, and the fractions are
 * still fractions of that element's own rectangle. Requiring `frameSeq` equality therefore
 * refused nothing unsafe, while making pin creation impossible by construction in an
 * animated or interactive preview — up to 240 frames per second (host-supervision §8) means
 * no token can survive to the next frame. The temporal guard is the 30-second TTL, plus the
 * separate `FRAME_TOKEN_STALE` check on the query that minted this token in the first place.
 */
function identitiesMatch(a: FrameIdentityV1, b: FrameIdentityV1): boolean {
  return (
    a.previewSessionId === b.previewSessionId &&
    a.nonce === b.nonce &&
    a.sourceHash === b.sourceHash
  );
}

/** Builds one Kernel's geometry-token ledger. A factory, not module state: two kernels — or two tests — must never share one. */
export function createGeometryTokenLedger(deps: GeometryTokenLedgerDeps): GeometryTokenLedger {
  // Map iteration order is insertion order in JS, which is exactly what FIFO eviction needs.
  const entries = new Map<GeometryTokenV1, LedgerEntry>();

  function mint(anchor: GeometryAnchorV1): GeometryTokenV1 {
    if (entries.size >= GEOMETRY_TOKEN_LEDGER_CAPACITY) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) entries.delete(oldestKey);
    }
    const token = uuidv7();
    entries.set(token, { anchor, mintedAtMs: deps.clock.now().getTime() });
    return token;
  }

  /** The one place the two public codes are decided — `consume` and `inspect` never judge a token differently. */
  function verdictFor(
    entry: LedgerEntry | undefined,
    currentIdentity: FrameIdentityV1,
  ): GeometryTokenVerdict {
    if (entry === undefined) return { ok: false, code: "GEOMETRY_TOKEN_INVALID" };
    const ageMs = deps.clock.now().getTime() - entry.mintedAtMs;
    if (ageMs >= GEOMETRY_TOKEN_TTL_MS) return { ok: false, code: "GEOMETRY_TOKEN_INVALID" };
    if (!identitiesMatch(entry.anchor.identity, currentIdentity)) {
      return { ok: false, code: "GEOMETRY_TOKEN_STALE" };
    }
    return { ok: true };
  }

  function consume(
    token: GeometryTokenV1,
    currentIdentity: FrameIdentityV1,
  ): GeometryTokenConsumption {
    const entry = entries.get(token);
    const verdict = verdictFor(entry, currentIdentity);
    if (!verdict.ok) {
      // An expired entry is dropped here rather than left to age out with the ledger's FIFO
      // eviction — the same removal this branch has always done. `inspect` deliberately does
      // NOT: a read-only check must not change what a later `consume` finds.
      if (verdict.code === "GEOMETRY_TOKEN_INVALID") entries.delete(token);
      return verdict;
    }
    if (entry === undefined) return { ok: false, code: "GEOMETRY_TOKEN_INVALID" };

    entries.delete(token); // consumed once (§8.1) — only on the success path.
    return { ok: true, anchor: entry.anchor };
  }

  function inspect(token: GeometryTokenV1, currentIdentity: FrameIdentityV1): GeometryTokenVerdict {
    return verdictFor(entries.get(token), currentIdentity);
  }

  function restore(token: GeometryTokenV1, anchor: GeometryAnchorV1): void {
    if (entries.size >= GEOMETRY_TOKEN_LEDGER_CAPACITY) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) entries.delete(oldestKey);
    }
    entries.set(token, { anchor, mintedAtMs: deps.clock.now().getTime() });
  }

  function size(): number {
    return entries.size;
  }

  return { mint, consume, inspect, restore, size };
}
