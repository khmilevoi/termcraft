import type { Atom } from "@termcraft/runtime"
import { action } from "@termcraft/runtime"

// Shared elapsed-time-tracking logic for the stopwatch and timer pages. Both pages hold their
// own `elapsedMs` atom and advance it only through this factory's `tick` action — a page
// renders once per commit (no tick, no animation frame, no interval, no clock), so nothing
// here ever reads a wall clock; see RUNTIME.md's "Time and the sealed render".

/**
 * Builds a `tick` action over a page's own `elapsedMs` atom: each call adds `deltaMs` to the
 * last committed value. The atom only ever changes in response to this action running — never
 * from a live wall-clock read — so a sealed export/replay render reports exactly the value it
 * was last set to, with nothing left to distinguish "static" from "live".
 */
export function makeTick(elapsedMs: Atom<number>, name: string) {
  return action((deltaMs: number) => elapsedMs.set(elapsedMs() + deltaMs), name)
}
