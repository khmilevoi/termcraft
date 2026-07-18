import type { FrameEnvelope } from "../../protocol"
import type { PreviewFrame } from "../../types"
import type { FrameBroker } from "../types"

/**
 * A capacity-1 latest-wins preview frame broker (host-supervision §8, §10.1). It
 * holds at most ONE pending complete frame. `publish` is a non-awaiting atomic
 * replace: a stalled UI consumer can never block lifecycle. Each replace of a
 * still-unconsumed pending frame increments `framesCoalesced`. Every frame is
 * checked against the incarnation guard (session + nonce + source hash) and a
 * strictly-monotonic `frameSeq` before it is accepted; a stale frame is rejected
 * without touching the slot. `close()` ends the frame iterator (§10.1).
 */
export function createFrameBroker(guard: {
  sessionId: string
  nonce: string
  sourceHash: string
}): FrameBroker {
  let pending: PreviewFrame | null = null
  let coalesced = 0
  let lastSeq: bigint | null = null
  let closed = false
  let wake: (() => void) | null = null

  const signal = () => {
    const resume = wake
    wake = null
    resume?.()
  }

  function publish(frame: FrameEnvelope): "accepted" | "stale" {
    if (closed) return "stale"
    if (
      frame.sessionId !== guard.sessionId ||
      frame.nonce !== guard.nonce ||
      frame.sourceHash !== guard.sourceHash
    ) {
      return "stale"
    }
    // frameSeq is a codec-validated decimal-uint64 string, so BigInt() is safe and
    // the comparison is numeric — "10" > "9", which a lexical string compare gets wrong.
    const seq = BigInt(frame.frameSeq)
    if (lastSeq !== null && seq <= lastSeq) return "stale"
    lastSeq = seq
    if (pending !== null) coalesced += 1
    pending = {
      sessionId: frame.sessionId,
      sourceHash: frame.sourceHash,
      frameSeq: frame.frameSeq,
      width: frame.width,
      height: frame.height,
      rows: frame.rows,
    }
    signal()
    return "accepted"
  }

  const frames: AsyncIterable<PreviewFrame> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (closed) return
        if (pending !== null) {
          const frame = pending
          pending = null
          yield frame
          continue
        }
        await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  }

  return {
    publish,
    frames,
    framesCoalesced: () => coalesced,
    close: () => {
      closed = true
      signal()
    },
  }
}
