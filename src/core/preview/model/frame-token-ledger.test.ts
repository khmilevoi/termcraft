import { describe, expect, test } from "bun:test";

import { type FrameIdentityV1, isUuidv7 } from "core/protocol";

import { FrameAckError, createFrameTokenLedger } from "./frame-token-ledger";

/**
 * `FrameTokenLedger` (kernel-command-contract §8.1, §12.6 item 4, §13.3): "A frame token
 * is unusable before display acknowledgement and stale after the next acknowledgement."
 * `acknowledge` is the UI's typed display acknowledgement — §8.1 says it "is a
 * `PreviewSession` broker message, not a Kernel command", so its own failure is a local
 * tagged error, never one of the 31 `UnavailableReason` codes. `verifyCurrent` is what
 * `preview.queryGeometry` calls, and DOES return the `FRAME_TOKEN_INVALID`/`FRAME_TOKEN_STALE`
 * reason codes §11.1 fixes.
 */

function identity(overrides: Partial<FrameIdentityV1> = {}): FrameIdentityV1 {
  return {
    previewSessionId: "0192f6f0-0000-7000-8000-0000000000a1",
    nonce: "a".repeat(32),
    sourceHash: "b".repeat(64),
    frameSeq: "1",
    ...overrides,
  };
}

describe("createFrameTokenLedger", () => {
  test("mint returns a fresh canonical UUIDv7 token per call", () => {
    const ledger = createFrameTokenLedger();
    const t1 = ledger.mint(identity({ frameSeq: "1" }));
    const t2 = ledger.mint(identity({ frameSeq: "2" }));
    expect(isUuidv7(t1)).toBe(true);
    expect(isUuidv7(t2)).toBe(true);
    expect(t1).not.toBe(t2);
  });

  test("a minted, never-acknowledged token is refused by verifyCurrent as FRAME_TOKEN_INVALID", () => {
    const ledger = createFrameTokenLedger();
    const token = ledger.mint(identity());
    expect(ledger.verifyCurrent(token)).toEqual({ ok: false, code: "FRAME_TOKEN_INVALID" });
    expect(ledger.currentIdentity()).toBeNull();
  });

  test("acknowledging the pending minted token succeeds and makes it the current, verifiable token", () => {
    const ledger = createFrameTokenLedger();
    const id = identity();
    const token = ledger.mint(id);

    const acked = ledger.acknowledge(token);
    if (acked instanceof Error) throw acked;
    expect(acked).toEqual(id);

    expect(ledger.currentIdentity()).toEqual(id);
    expect(ledger.verifyCurrent(token)).toEqual({ ok: true, identity: id });
  });

  test("acknowledging an unknown/unrelated token fails with FrameAckError and does not change current", () => {
    const ledger = createFrameTokenLedger();
    const id = identity();
    const token = ledger.mint(id);
    ledger.acknowledge(token);

    const result = ledger.acknowledge("0192f6f0-0000-7000-8000-0000000000ff");
    expect(result).toBeInstanceOf(FrameAckError);
    // current is untouched by the failed ack attempt.
    expect(ledger.currentIdentity()).toEqual(id);
  });

  test("a later acknowledgement invalidates the prior acknowledged token: it becomes FRAME_TOKEN_STALE", () => {
    const ledger = createFrameTokenLedger();
    const idA = identity({ frameSeq: "1" });
    const idB = identity({ frameSeq: "2" });
    const tokenA = ledger.mint(idA);
    ledger.acknowledge(tokenA);

    const tokenB = ledger.mint(idB);
    ledger.acknowledge(tokenB);

    expect(ledger.verifyCurrent(tokenA)).toEqual({ ok: false, code: "FRAME_TOKEN_STALE" });
    expect(ledger.verifyCurrent(tokenB)).toEqual({ ok: true, identity: idB });
  });

  test("minting again before the first pending is acknowledged makes the first pending permanently un-ackable", () => {
    const ledger = createFrameTokenLedger();
    const tokenA = ledger.mint(identity({ frameSeq: "1" }));
    ledger.mint(identity({ frameSeq: "2" })); // supersedes tokenA's pending slot

    const result = ledger.acknowledge(tokenA);
    expect(result).toBeInstanceOf(FrameAckError);
    expect(ledger.currentIdentity()).toBeNull();
  });

  test("invalidateCurrent() demotes the current acknowledged token to FRAME_TOKEN_STALE and clears currentIdentity", () => {
    const ledger = createFrameTokenLedger();
    const id = identity();
    const token = ledger.mint(id);
    ledger.acknowledge(token);

    ledger.invalidateCurrent();

    expect(ledger.currentIdentity()).toBeNull();
    expect(ledger.verifyCurrent(token)).toEqual({ ok: false, code: "FRAME_TOKEN_STALE" });
  });

  test("invalidateCurrent() also discards any not-yet-acknowledged pending mint", () => {
    const ledger = createFrameTokenLedger();
    const pendingToken = ledger.mint(identity());

    ledger.invalidateCurrent();

    const result = ledger.acknowledge(pendingToken);
    expect(result).toBeInstanceOf(FrameAckError);
  });
});
