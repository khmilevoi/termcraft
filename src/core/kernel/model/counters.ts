import { type Atom, action, atom } from "@reatom/core";

import { type UInt64String, type UUIDv7, encodeUint64String } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";

/**
 * The Kernel's two independent counters (kernel-command-contract §4).
 *
 * They are deliberately NOT one counter with two readers. §4 gives them different
 * meanings: `stateRevision` is "incremented once for each atomic authoritative Kernel
 * state transition" and explicitly NOT for "Rejections, duplicate replays, backend
 * progress text, and host frames", while `eventSeq` is "incremented for every emitted
 * control event, including progress and diagnostics that do not change state". So
 * several events legitimately carry the same `stateRevision`, and a rejected command
 * advances neither. Collapsing them would make a progress event look like a state
 * change to every mirror downstream.
 *
 * Both are `bigint` inside the atom and canonical decimal strings on the way out: §4
 * fixes the DTO encoding as "canonical decimal strings. Internally they may be
 * `bigint`; `bigint` never crosses a DTO boundary." Keeping the conversion at the
 * accessor means no caller can leak a `bigint` into an envelope by accident.
 */
export interface KernelCounters {
  /** UUIDv7 identifying this Kernel process lifetime (§4). Carries no reconnect semantics. */
  readonly kernelInstanceId: UUIDv7;
  /** The current authoritative state revision, DTO-encoded. */
  readonly stateRevision: () => UInt64String;
  /** The last assigned event sequence, DTO-encoded. */
  readonly eventSeq: () => UInt64String;
  /** Advances the revision by exactly one and returns the new value. */
  readonly advanceRevision: () => UInt64String;
  /** Assigns the next event sequence and returns it. */
  readonly nextEventSeq: () => UInt64String;
  /** The underlying atoms, exposed so the projector and tests can observe them by name. */
  readonly stateRevisionAtom: Atom<bigint>;
  readonly eventSeqAtom: Atom<bigint>;
}

/**
 * Creates one Kernel's counters. A factory rather than module-level atoms because §4
 * scopes both counters to a single Kernel process lifetime alongside `kernelInstanceId`,
 * and because module-level state would make two kernels in one test process — or one
 * test after another — share a revision and silently invalidate each other's assertions.
 *
 * The mutations are named actions rather than bare `.set(...)` calls at the call site:
 * per the Reatom rules a transition that callers depend on is a named unit, and the
 * trace name is what makes a revision bump attributable when a mirror desyncs. They are
 * not identity setters — each derives its next value from the current one and returns
 * the result, which is the value the caller must stamp onto the envelope it is building.
 */
export function createKernelCounters(): KernelCounters {
  const stateRevisionAtom = atom(0n, "kernel.stateRevision");
  const eventSeqAtom = atom(0n, "kernel.eventSeq");

  const advanceRevision = action(() => {
    const next = stateRevisionAtom() + 1n;
    stateRevisionAtom.set(next);
    return encodeUint64String(next);
  }, "kernel.advanceRevision");

  const nextEventSeq = action(() => {
    const next = eventSeqAtom() + 1n;
    eventSeqAtom.set(next);
    return encodeUint64String(next);
  }, "kernel.nextEventSeq");

  return {
    kernelInstanceId: uuidv7(),
    stateRevision: () => encodeUint64String(stateRevisionAtom()),
    eventSeq: () => encodeUint64String(eventSeqAtom()),
    advanceRevision,
    nextEventSeq,
    stateRevisionAtom,
    eventSeqAtom,
  };
}
