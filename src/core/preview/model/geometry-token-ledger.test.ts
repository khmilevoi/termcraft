import { describe, expect, test } from "bun:test"

import type { FrameIdentityV1 } from "core/protocol"
import type { Clock } from "infrastructure/clock"

import {
  createGeometryTokenLedger,
  GEOMETRY_TOKEN_LEDGER_CAPACITY,
  GEOMETRY_TOKEN_TTL_MS,
  type GeometryAnchorV1,
} from "./geometry-token-ledger"

/**
 * `GeometryTokenLedger` (kernel-command-contract §8.1, §12.6 item 5-6, §13.3): binds
 * `(FrameIdentityV1, pageSlug, elementId, fx, fy)`, bounded 4,096 entries, lives at most 30
 * seconds, consumed ONCE by `pin.create`. §11.1 splits its two failure codes precisely:
 * `GEOMETRY_TOKEN_INVALID` for "absent, malformed, EXPIRED, or ALREADY-CONSUMED",
 * `GEOMETRY_TOKEN_STALE` for "session/incarnation/source/frame is not the current frame
 * acknowledged as displayed" — i.e. STALE is exclusively the identity-mismatch case; every
 * other failure mode is INVALID.
 *
 * A frozen clock would make every expiry assertion here a tautology (the task brief's own
 * warning, matching the defect found in slice 6E) — `manualClock` below is advanced by
 * hand, never `Date.now()`.
 */

function manualClock(startMs: number): Clock & { advance: (ms: number) => void } {
  let now = startMs
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms
    },
  }
}

const T0 = 1_700_000_000_000

function identity(overrides: Partial<FrameIdentityV1> = {}): FrameIdentityV1 {
  return {
    previewSessionId: "0192f6f0-0000-7000-8000-0000000000a1",
    nonce: "a".repeat(32),
    sourceHash: "b".repeat(64),
    frameSeq: "1",
    ...overrides,
  }
}

function anchor(overrides: Partial<GeometryAnchorV1> = {}): GeometryAnchorV1 {
  return {
    identity: identity(),
    pageSlug: "home",
    elementId: "btn-submit",
    fx: 0.5,
    fy: 0.5,
    ...overrides,
  }
}

describe("createGeometryTokenLedger", () => {
  test("consume rejects an unknown token as GEOMETRY_TOKEN_INVALID", () => {
    const ledger = createGeometryTokenLedger({ clock: manualClock(T0) })
    expect(ledger.consume("0192f6f0-0000-7000-8000-0000000000ff", identity())).toEqual({
      ok: false,
      code: "GEOMETRY_TOKEN_INVALID",
    })
  })

  test("consume succeeds when the current identity exactly matches the minted anchor's identity", () => {
    const clock = manualClock(T0)
    const ledger = createGeometryTokenLedger({ clock })
    const a = anchor()
    const token = ledger.mint(a)

    expect(ledger.consume(token, identity())).toEqual({ ok: true, anchor: a })
  })

  test("a successful consume removes the entry: reusing the same token again is GEOMETRY_TOKEN_INVALID (already-consumed)", () => {
    const clock = manualClock(T0)
    const ledger = createGeometryTokenLedger({ clock })
    const token = ledger.mint(anchor())

    ledger.consume(token, identity())
    expect(ledger.consume(token, identity())).toEqual({ ok: false, code: "GEOMETRY_TOKEN_INVALID" })
  })

  describe("identity matrix (§13.3): previewSessionId, nonce, sourceHash, frameSeq vary independently", () => {
    const mintedIdentity = identity()

    test("previewSessionId mismatch alone refuses as STALE", () => {
      const ledger = createGeometryTokenLedger({ clock: manualClock(T0) })
      const token = ledger.mint(anchor({ identity: mintedIdentity }))
      const current = { ...mintedIdentity, previewSessionId: "0192f6f0-0000-7000-8000-0000000000b2" }
      expect(ledger.consume(token, current)).toEqual({ ok: false, code: "GEOMETRY_TOKEN_STALE" })
    })

    test("nonce mismatch alone refuses as STALE", () => {
      const ledger = createGeometryTokenLedger({ clock: manualClock(T0) })
      const token = ledger.mint(anchor({ identity: mintedIdentity }))
      const current = { ...mintedIdentity, nonce: "c".repeat(32) }
      expect(ledger.consume(token, current)).toEqual({ ok: false, code: "GEOMETRY_TOKEN_STALE" })
    })

    test("sourceHash mismatch alone refuses as STALE", () => {
      const ledger = createGeometryTokenLedger({ clock: manualClock(T0) })
      const token = ledger.mint(anchor({ identity: mintedIdentity }))
      const current = { ...mintedIdentity, sourceHash: "d".repeat(64) }
      expect(ledger.consume(token, current)).toEqual({ ok: false, code: "GEOMETRY_TOKEN_STALE" })
    })

    test("frameSeq mismatch alone refuses as STALE", () => {
      const ledger = createGeometryTokenLedger({ clock: manualClock(T0) })
      const token = ledger.mint(anchor({ identity: mintedIdentity }))
      const current = { ...mintedIdentity, frameSeq: "2" }
      expect(ledger.consume(token, current)).toEqual({ ok: false, code: "GEOMETRY_TOKEN_STALE" })
    })

    test("a nonce change permits frameSeq to restart at the same numeral without colliding with the prior incarnation's token", () => {
      const ledger = createGeometryTokenLedger({ clock: manualClock(T0) })
      const idBeforeRestart = identity({ nonce: "a".repeat(32), frameSeq: "1" })
      const idAfterRestart = identity({ nonce: "c".repeat(32), frameSeq: "1" }) // same frameSeq, new nonce

      const staleToken = ledger.mint(anchor({ identity: idBeforeRestart }))
      const freshToken = ledger.mint(anchor({ identity: idAfterRestart, elementId: "btn-fresh" }))

      // The stale incarnation's token must not be usable once the nonce has moved on...
      expect(ledger.consume(staleToken, idAfterRestart)).toEqual({ ok: false, code: "GEOMETRY_TOKEN_STALE" })
      // ...while the fresh incarnation's own token, minted under the identical frameSeq
      // numeral, is unaffected by that collision and still consumes cleanly.
      expect(ledger.consume(freshToken, idAfterRestart)).toEqual({
        ok: true,
        anchor: anchor({ identity: idAfterRestart, elementId: "btn-fresh" }),
      })
    })

    test("all four fields matching exactly is required for a STALE-free consume (sanity: every field differing at once is still just STALE, not some other code)", () => {
      const ledger = createGeometryTokenLedger({ clock: manualClock(T0) })
      const token = ledger.mint(anchor({ identity: mintedIdentity }))
      const current: FrameIdentityV1 = {
        previewSessionId: "0192f6f0-0000-7000-8000-0000000000c3",
        nonce: "e".repeat(32),
        sourceHash: "f".repeat(64),
        frameSeq: "99",
      }
      expect(ledger.consume(token, current)).toEqual({ ok: false, code: "GEOMETRY_TOKEN_STALE" })
    })

    test("a stale (identity-mismatched) consume does NOT consume the entry — a later matching consume still succeeds", () => {
      const ledger = createGeometryTokenLedger({ clock: manualClock(T0) })
      const a = anchor({ identity: mintedIdentity })
      const token = ledger.mint(a)

      const mismatched = { ...mintedIdentity, frameSeq: "2" }
      expect(ledger.consume(token, mismatched)).toEqual({ ok: false, code: "GEOMETRY_TOKEN_STALE" })

      expect(ledger.consume(token, mintedIdentity)).toEqual({ ok: true, anchor: a })
    })
  })

  describe("30-second TTL, driven by a manual clock", () => {
    test("still consumable one millisecond before the 30s boundary", () => {
      const clock = manualClock(T0)
      const ledger = createGeometryTokenLedger({ clock })
      const a = anchor()
      const token = ledger.mint(a)

      clock.advance(GEOMETRY_TOKEN_TTL_MS - 1)

      expect(ledger.consume(token, identity())).toEqual({ ok: true, anchor: a })
    })

    test("expired exactly at the 30s boundary: GEOMETRY_TOKEN_INVALID, not STALE", () => {
      const clock = manualClock(T0)
      const ledger = createGeometryTokenLedger({ clock })
      const token = ledger.mint(anchor())

      clock.advance(GEOMETRY_TOKEN_TTL_MS)

      expect(ledger.consume(token, identity())).toEqual({ ok: false, code: "GEOMETRY_TOKEN_INVALID" })
    })

    test("well past expiry remains GEOMETRY_TOKEN_INVALID", () => {
      const clock = manualClock(T0)
      const ledger = createGeometryTokenLedger({ clock })
      const token = ledger.mint(anchor())

      clock.advance(GEOMETRY_TOKEN_TTL_MS * 10)

      expect(ledger.consume(token, identity())).toEqual({ ok: false, code: "GEOMETRY_TOKEN_INVALID" })
    })
  })

  describe("bounded 4,096-entry capacity", () => {
    test("minting past capacity evicts the oldest entry (FIFO), keeping size at the cap", () => {
      const ledger = createGeometryTokenLedger({ clock: manualClock(T0) })
      const tokens: string[] = []
      for (let i = 0; i < GEOMETRY_TOKEN_LEDGER_CAPACITY; i += 1) {
        tokens.push(ledger.mint(anchor({ elementId: `el-${i}` })))
      }
      expect(ledger.size()).toBe(GEOMETRY_TOKEN_LEDGER_CAPACITY)

      const oldest = tokens[0]
      if (oldest === undefined) throw new Error("expected a first token")
      const overflowToken = ledger.mint(anchor({ elementId: "el-overflow" }))

      expect(ledger.size()).toBe(GEOMETRY_TOKEN_LEDGER_CAPACITY)
      expect(ledger.consume(oldest, identity())).toEqual({ ok: false, code: "GEOMETRY_TOKEN_INVALID" })
      expect(ledger.consume(overflowToken, identity())).toEqual({
        ok: true,
        anchor: anchor({ elementId: "el-overflow" }),
      })
    })
  })
})
