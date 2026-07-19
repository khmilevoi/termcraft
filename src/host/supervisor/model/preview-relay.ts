import type { PreviewFrame } from "../../types"
import type { PreviewRelay } from "../types"

/**
 * A capacity-1 latest-wins relay of already-built `PreviewFrame` values that
 * outlives individual incarnations (host-supervision §10.1). It holds at most ONE
 * pending frame: `publish` is a non-awaiting atomic replace, so a stalled UI
 * consumer can never block the supervisor re-pointing the relay at a new
 * incarnation across an automatic restart. Unlike the per-incarnation broker there
 * is NO identity or `frameSeq` guard — every value handed here was already validated
 * by the broker of the incarnation that produced it, so a fresh incarnation whose
 * `frameSeq` restarts from a lower value is still accepted. A publish after
 * `close()` is a no-op; `close()` ends the frame iterator (a parked consumer's
 * `next()` resolves `{ done: true }`) and is idempotent.
 */
export function createPreviewRelay(): PreviewRelay {
  let pending: PreviewFrame | null = null
  let closed = false
  let wake: (() => void) | null = null

  const signal = () => {
    const resume = wake
    wake = null
    resume?.()
  }

  function publish(frame: PreviewFrame): void {
    if (closed) return
    pending = frame
    signal()
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
        // `wake` is ONE shared slot, not per-iterator. A second concurrent consumer
        // parking here while another is already parked would silently clobber the
        // first's resolver, hanging it forever (this AsyncIterable is single-consumer
        // by contract). Fail loudly instead of corrupting the shared slot.
        if (wake !== null) throw new Error("PreviewRelay.frames is single-consumer; a second concurrent reader was detected")
        await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  }

  return {
    frames,
    publish,
    close: () => {
      closed = true
      signal()
    },
  }
}
