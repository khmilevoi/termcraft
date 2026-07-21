import { type Atom, action, atom, bind } from "@reatom/core";

import type { TurnBackendLeaseV1, TurnFenceProbe } from "../types";

/**
 * The Kernel mailbox's fenced ingress for backend turn signals (kernel-command-contract
 * §6, §12.2 step 3, §11.2, §13.3).
 *
 * §6 (KCC:181-182): "Service callbacks return to the same mailbox through `wrap`; they
 * never set model atoms directly." This module IS that return path for one family of
 * service callback: `AgentRunSupervisor`'s backend progress/completion signals.
 *
 * §12.2 step 3, verbatim: "Every backend progress/completion callback carries the full
 * lease `{turnId, attempt, leaseNonce}`. The mailbox compares all three fields with
 * `TurnState` before calling an action. A mismatch is dropped, counted, and optionally
 * emits a bounded diagnostic event; it cannot update chat progress, candidate state,
 * retries, usage, or final text." §11.2 names the diagnostic code this produces:
 * `STALE_BACKEND_EVENT_DROPPED` — "Diagnostic only; a turn fence did not match."
 *
 * This module owns exactly the FENCE — the three-field comparison, the drop-and-count,
 * and the bound re-entry into Reatom. It does not itself decide what
 * `STALE_BACKEND_EVENT_DROPPED`'s `diagnostics.changed` payload looks like (§9's
 * `generation`-keyed diagnostic stream is a separate, not-yet-owned piece of machinery)
 * — `onStaleDropped` is the injected seam a future diagnostics component hangs off, so
 * this module does not invent that mechanism's shape to satisfy an "optionally" the
 * spec itself does not make mandatory. It also does not decide WHICH model action a
 * matched signal calls — `onAccepted` (6C, or whatever owns `TurnState`) does that; this
 * module's only claim is that `onAccepted` never runs for a signal whose lease does not
 * match ALL THREE fields.
 *
 * `TurnFenceProbe` reads live `TurnState` the same way `revision-guard.ts`'s
 * `TurnCancelProbe` reads it for a different question (§8.4's cancel rules vs §12.2's
 * lease fence) — both injected because the turn state machine (6C) does not exist yet,
 * and neither probe should import the other's narrower slice of fact.
 */

/** One dropped signal's context, handed to the optional `onStaleDropped` seam. */
export interface StaleBackendSignal<S extends TurnBackendLeaseV1 = TurnBackendLeaseV1> {
  readonly signal: S;
  /** `TurnState`'s lease at the moment of the drop — `null` when no turn was active at all. */
  readonly activeLease: TurnBackendLeaseV1 | null;
}

export interface SignalIngressDeps<S extends TurnBackendLeaseV1> {
  readonly fenceProbe: TurnFenceProbe;
  /** Called ONLY when `signal`'s lease matches the active one on all three fields. */
  readonly onAccepted: (signal: S) => void;
  /** Optional §11.2 diagnostic seam — see this file's module comment. */
  readonly onStaleDropped?: (dropped: StaleBackendSignal<S>) => void;
}

export interface SignalIngress<S extends TurnBackendLeaseV1> {
  /**
   * The mailbox's one entry point for this signal family. Safe to call from ANYWHERE —
   * a raw process/event callback, a `setTimeout`, code with no active Reatom frame at
   * all — because it is built with `bind` (see `createSignalIngress`'s comment) against
   * the frame active when this ingress was constructed.
   */
  readonly deliver: (signal: S) => void;
  /** The number of signals dropped for a lease mismatch so far. */
  readonly droppedCount: () => number;
  /** The underlying atom, exposed so tests/diagnostics can observe it by name. */
  readonly droppedCountAtom: Atom<number>;
}

/** All three fields must agree — §12.2 step 3's "compares all three fields", not any subset. */
function leaseMatches(active: TurnBackendLeaseV1 | null, signal: TurnBackendLeaseV1): boolean {
  if (active === null) return false;
  return (
    active.turnId === signal.turnId &&
    active.attempt === signal.attempt &&
    active.leaseNonce === signal.leaseNonce
  );
}

/**
 * Creates one Kernel's turn-signal ingress. A factory, not module-level state, for the
 * same reason as `createDedupeLedger`/`createEventBus`/`createKernelCounters`: §12.2's
 * lease fencing is scoped to one Kernel process lifetime, and module-level state would
 * let two kernels in one test process — or one test after another — share a drop
 * counter and invalidate each other's assertions.
 *
 * Must be constructed inside an active Reatom `context.start(...)` frame, matching
 * every other factory in this module: `deliver` is bound here, at construction
 * time, against whatever frame is active right now — not fresh on every call — for the
 * same reason `dispatch.ts`'s own two `wrap` calls are captured once at its
 * construction: there is exactly one Kernel Reatom context for this mailbox's whole
 * process lifetime (§5), and `deliver` is explicitly the entry point external,
 * uncontrolled code (a backend process callback) calls with no reactive context of its
 * own to offer.
 */
export function createSignalIngress<S extends TurnBackendLeaseV1>(
  deps: SignalIngressDeps<S>,
): SignalIngress<S> {
  const droppedCountAtom = atom(0, "mailbox.signalIngress.droppedCount");

  const recordDrop = action(() => {
    droppedCountAtom.set(droppedCountAtom() + 1);
  }, "mailbox.signalIngress.recordDrop");

  function handle(signal: S): void {
    const active = deps.fenceProbe.currentLease();
    if (!leaseMatches(active, signal)) {
      recordDrop();
      deps.onStaleDropped?.({ signal, activeLease: active });
      return;
    }
    deps.onAccepted(signal);
  }

  // `bind`, not `wrap`. The Reatom rules split these by WHO calls the function: `wrap` is
  // for a continuation resumed inside a frame this unit is already in (after an `await`,
  // a `.then`), while `bind` is for a callback something ELSE invokes later from outside —
  // which is exactly `deliver`'s contract (see its doc comment: a raw backend callback, a
  // timer, code with no active Reatom frame at all). Both re-enter the construction-time
  // frame; using the one that names the actual situation keeps the intent readable.
  const deliver = bind(handle);
  // `droppedCountAtom` is scoped to the SAME frame `deliver` writes into (both are bound
  // at this same construction time) — a caller reading `droppedCount` from outside any
  // `context.start(...)` (a diagnostics poller, a test) needs the same re-entry `deliver`
  // gets, or it would read an entirely different frame's untouched copy of
  // `droppedCountAtom` instead of the one `recordDrop` actually incremented.
  const droppedCount = bind(() => droppedCountAtom());

  return {
    deliver,
    droppedCount,
    droppedCountAtom,
  };
}
