import type { PreviewFrameV1 } from "core/ports"

/**
 * The Kernel-side latest-wins frame slot (host-supervision-protocol §8: "Preview frame
 * broker | 1 complete frame | Atomically replace the pending frame; increment
 * framesCoalesced"). Frames do not pass through the control-event stream
 * (kernel-command-contract §7.6: "The UI consumes a bounded, latest-wins `PreviewSession`
 * frame stream ... It never starts, kills, or writes to the host subprocess directly") —
 * this broker is the Kernel-side half of that same guarantee: never more than one
 * undisplayed frame is held, and `publish` never waits on whatever later reads
 * `current()`.
 *
 * Deliberately plain closures over local variables, not Reatom atoms — matching
 * `core/turns/model/deadlines.ts`'s own reasoning for an equally simple, non-reactive,
 * on-demand-read piece of Kernel state: nothing outside this module needs to observe a
 * frame arriving reactively (the UI reads `PreviewSession.frames` directly, per the same
 * §7.6 sentence above), and KCC §5 forbids a connect hook owning any lifetime here.
 */
export interface FrameBroker {
  /** Atomically replaces the pending frame. Synchronous — never awaits, never blocks. */
  readonly publish: (frame: PreviewFrameV1) => void
  /** A non-consuming peek at the most recently published frame, or `null` before the first publish or after `clear()`. */
  readonly current: () => PreviewFrameV1 | null
  /** Frames replaced by a later `publish()` before ever being displayed (host-supervision §8's `framesCoalesced`). */
  readonly framesCoalesced: () => number
  /** Drops the pending frame with no change to the coalesce count — a session/source switch starts clean. */
  readonly clear: () => void
}

/** Builds one live session's frame broker. A factory, not module state: two sessions must never share a slot. */
export function createFrameBroker(): FrameBroker {
  let pending: PreviewFrameV1 | null = null
  let coalesced = 0

  function publish(frame: PreviewFrameV1): void {
    if (pending !== null) coalesced += 1
    pending = frame
  }

  function current(): PreviewFrameV1 | null {
    return pending
  }

  function framesCoalesced(): number {
    return coalesced
  }

  function clear(): void {
    pending = null
  }

  return { publish, current, framesCoalesced, clear }
}
