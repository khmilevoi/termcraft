import type { ControlEnvelope } from "../../protocol";
import type { CoalesceOutcome, ControlQueue, QueuedCommand } from "../types";
import { SupervisorError } from "./errors";

/** Bounded outbound control queue geometry (host-supervision §8). */
export const OUTBOUND_QUEUE_CAPACITY = 256;
export const OUTBOUND_LOW_WATER = 128;

/** Kinds whose latest value coalesces within a barrier segment (§8/§14.2). */
export const COALESCIBLE_KINDS: ReadonlySet<string> = new Set(["resize", "mousemove", "hover"]);

/** A live queue slot; `envelope` is replaced in place by a same-segment coalesce. */
type MutableEntry = { kind: string; envelope: ControlEnvelope };

function backpressuredError() {
  return new SupervisorError({
    code: "HOST_BACKPRESSURED",
    reason: "outbound control queue full (256)",
  });
}

/**
 * The bounded ordered supervisor→host control queue (§8): 256 discrete entries
 * plus one reserved shutdown slot, low-water 128. Errors are returned as values.
 */
export function createControlQueue(): ControlQueue {
  const entries: MutableEntry[] = [];
  const pending = new Map<string, MutableEntry>();
  const writableCbs: (() => void)[] = [];
  let shutdown: QueuedCommand | null = null;
  let backpressured = false;

  return {
    enqueue(command) {
      if (entries.length >= OUTBOUND_QUEUE_CAPACITY) return backpressuredError();
      entries.push({ kind: command.kind, envelope: command.envelope });
      pending.clear();
      if (entries.length === OUTBOUND_QUEUE_CAPACITY) backpressured = true;
      return "accepted";
    },

    coalesce(command): CoalesceOutcome | SupervisorError {
      const p = pending.get(command.kind);
      if (p !== undefined) {
        const superseded = p.envelope;
        p.envelope = command.envelope;
        return { status: "coalesced", superseded };
      }
      if (entries.length >= OUTBOUND_QUEUE_CAPACITY) return backpressuredError();
      const entry: MutableEntry = { kind: command.kind, envelope: command.envelope };
      entries.push(entry);
      pending.set(command.kind, entry);
      if (entries.length === OUTBOUND_QUEUE_CAPACITY) backpressured = true;
      return { status: "added", superseded: null };
    },

    enqueueShutdown(command) {
      shutdown = command;
      return "accepted";
    },

    dequeue() {
      if (shutdown !== null) {
        const s = shutdown;
        shutdown = null;
        return s;
      }
      const e = entries.shift();
      if (e === undefined) return null;
      for (const [k, v] of pending) {
        if (v === e) pending.delete(k);
      }
      if (backpressured && entries.length < OUTBOUND_LOW_WATER) {
        backpressured = false;
        for (const cb of writableCbs) cb();
      }
      return { kind: e.kind, envelope: e.envelope };
    },

    size() {
      return entries.length;
    },

    hasShutdown() {
      return shutdown !== null;
    },

    isBackpressured() {
      return backpressured;
    },

    onWritable(cb) {
      writableCbs.push(cb);
    },
  };
}
