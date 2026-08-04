import type { FrameEnvelope } from "../../protocol";
import type { PreviewFrame } from "../../types";
import type { FrameBroker } from "../types";

/**
 * A capacity-1 latest-wins preview frame broker (host-supervision §8, §10.1). It
 * holds at most ONE pending complete frame. `publish` is a non-awaiting atomic
 * replace: a stalled UI consumer can never block lifecycle. Each replace of a
 * still-unconsumed pending frame increments `framesCoalesced`. Every frame is
 * checked against the incarnation guard (session + nonce + source hash) and a
 * strictly-monotonic `frameSeq` before it is accepted; a stale frame is rejected
 * without touching the slot. `close()` ends the frame iterator (§10.1).
 *
 * §9.3 of the design doc claims this file is unchanged by the mount-in-ready work
 * (design-tree phase 3). It is not: `expect()` (below) lets the guard's expected
 * source hash move after an accepted mount, because one incarnation now renders
 * more than one page across its life (§9.2).
 */
export function createFrameBroker(guard: {
  sessionId: string;
  nonce: string;
  sourceHash: string;
}): FrameBroker {
  // MUTABLE, AND §9.3's "frame-broker.ts is unchanged" DOES NOT SURVIVE (design-tree phase 3).
  // The construction-time guard was right exactly while an incarnation rendered one page for
  // its whole life. §9.2 retires that: one incarnation serves one tree REVISION and mounts a
  // page at a time, so the hash the guard expects moves on every accepted mount. `lastSeq` is
  // deliberately NOT reset — the child's frame counter runs across mounts, so monotonicity is
  // still the ordering oracle and a replayed older frame is still refused.
  let expectedSourceHash = guard.sourceHash;
  let pending: PreviewFrame | null = null;
  let coalesced = 0;
  let lastSeq: bigint | null = null;
  let closed = false;
  let wake: (() => void) | null = null;

  const signal = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  function publish(frame: FrameEnvelope): "accepted" | "stale" {
    if (closed) return "stale";
    if (
      frame.sessionId !== guard.sessionId ||
      frame.nonce !== guard.nonce ||
      frame.sourceHash !== expectedSourceHash
    ) {
      return "stale";
    }
    // frameSeq is a codec-validated decimal-uint64 string, so BigInt() is safe and
    // the comparison is numeric — "10" > "9", which a lexical string compare gets wrong.
    const seq = BigInt(frame.frameSeq);
    if (lastSeq !== null && seq <= lastSeq) return "stale";
    lastSeq = seq;
    if (pending !== null) coalesced += 1;
    pending = {
      sessionId: frame.sessionId,
      sourceHash: frame.sourceHash,
      frameSeq: frame.frameSeq,
      width: frame.width,
      height: frame.height,
      rows: frame.rows,
    };
    signal();
    return "accepted";
  }

  const frames: AsyncIterable<PreviewFrame> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (closed) return;
        if (pending !== null) {
          const frame = pending;
          pending = null;
          yield frame;
          continue;
        }
        // `wake` is ONE shared slot, not per-iterator. A second concurrent consumer
        // parking here while another is already parked would silently clobber the
        // first's resolver, hanging it forever (this AsyncIterable is single-consumer
        // by contract). Fail loudly instead of corrupting the shared slot.
        if (wake !== null)
          throw new Error(
            "FrameBroker.frames is single-consumer; a second concurrent reader was detected",
          );
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };

  return {
    publish,
    /** Re-seed the incarnation guard's expected source hash after an accepted mount (§9.2). */
    expect: (sourceHash: string) => {
      expectedSourceHash = sourceHash;
    },
    frames,
    framesCoalesced: () => coalesced,
    close: () => {
      closed = true;
      signal();
    },
  };
}
