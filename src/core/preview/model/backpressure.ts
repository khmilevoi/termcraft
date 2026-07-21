/**
 * `PreviewBackpressure` (host-supervision-protocol §8, kernel-command-contract §11.1):
 * "Supervisor->host ordered control queue | 256 envelopes plus one reserved shutdown slot
 * | Reject the new non-coalescible Kernel command with `HOST_BACKPRESSURED`" and "When the
 * ordered outbound queue reaches 256, the Kernel emits a typed `preview.backpressured`
 * event and the UI pauses forwarding discrete interactive input. Once the queue drains
 * below the low-water mark of 128, the Kernel emits `preview.writable`."
 *
 * Two DELIBERATELY DECOUPLED concerns live here:
 *
 * - `reserve()`'s accept/refuse decision is a hard, momentary capacity check against
 *   {@link HOST_CONTROL_QUEUE_CAPACITY} — `HOST_BACKPRESSURED`'s own §11.1 meaning is "the
 *   matching preview's ordered host queue cannot accept another non-coalescible command",
 *   nothing about hysteresis.
 * - `backpressured`/`writable` are a hysteresis PAIR (raise at 256, clear only once fully
 *   below 128) whose only job is to stop the UI's pause/resume hint from flickering as the
 *   queue oscillates near the boundary. A reservation succeeding while still above 128 (but
 *   under 256) must NOT be refused just because the ledger has not yet emitted `writable`.
 *
 * Only the coalescible-vs-non-coalescible distinction (host-supervision §8: "coalescible
 * resize, mousemove, and hover state may continue to replace an already pending value")
 * decides whether a caller reserves a slot at all — that decision belongs to
 * `session-commands.ts`, which only calls `reserve()`/`release()` around the non-coalescible
 * commands it dispatches.
 *
 * Plain closures, not Reatom atoms — matching every other ledger in this module (see
 * `frame-broker.ts`'s header): nothing here needs reactive observation, and KCC §5 forbids
 * a connect hook owning this state's lifetime.
 */

export const HOST_CONTROL_QUEUE_CAPACITY = 256;
export const HOST_CONTROL_QUEUE_LOW_WATER_MARK = 128;

export type PreviewBackpressureTransitionV1 =
  | { readonly kind: "backpressured"; readonly queueSize: number }
  | { readonly kind: "writable"; readonly queueSize: number };

export interface PreviewBackpressure {
  readonly queueSize: () => number;
  /** Reserves one non-coalescible queue slot. Refuses with `HOST_BACKPRESSURED` only at the literal 256 cap. */
  readonly reserve: () => "HOST_BACKPRESSURED" | undefined;
  /** Releases one previously reserved slot (the command drained/completed). A safe no-op on an empty queue. */
  readonly release: () => void;
  /** Fires exactly on the 256-crossing and the sub-128-crossing. Returns the unsubscribe function. */
  readonly onTransition: (listener: (event: PreviewBackpressureTransitionV1) => void) => () => void;
}

/** Builds one live preview session's backpressure tracker. A factory: two sessions must never share a counter. */
export function createPreviewBackpressure(): PreviewBackpressure {
  let size = 0;
  // The hysteresis flag: true from the 256-crossing until the sub-128-crossing.
  let backpressured = false;
  const listeners = new Set<(event: PreviewBackpressureTransitionV1) => void>();

  function emit(event: PreviewBackpressureTransitionV1): void {
    for (const listener of listeners) listener(event);
  }

  function queueSize(): number {
    return size;
  }

  function reserve(): "HOST_BACKPRESSURED" | undefined {
    if (size >= HOST_CONTROL_QUEUE_CAPACITY) return "HOST_BACKPRESSURED";
    size += 1;
    if (!backpressured && size >= HOST_CONTROL_QUEUE_CAPACITY) {
      backpressured = true;
      emit({ kind: "backpressured", queueSize: size });
    }
    return undefined;
  }

  function release(): void {
    if (size === 0) {
      console.warn("preview backpressure: release() called on an empty queue, ignored");
      return;
    }
    size -= 1;
    if (backpressured && size < HOST_CONTROL_QUEUE_LOW_WATER_MARK) {
      backpressured = false;
      emit({ kind: "writable", queueSize: size });
    }
  }

  function onTransition(listener: (event: PreviewBackpressureTransitionV1) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { queueSize, reserve, release, onTransition };
}
