import * as errore from "errore"
import type { HealthProbeDeps } from "../types"

/** Fired when no classifying message (nor a clean stream end) arrives within the probe deadline. */
export class ProbeDeadlineAbortError extends errore.createTaggedError({
  name: "ProbeDeadlineAbortError",
  message: "health probe exceeded $deadlineMs ms with no classifying message",
  extends: errore.AbortError,
}) {}

/** Probe read budget (master §9). No spec value is given; generous enough for
 * a cold CLI start + auth handshake, bounded so a silent CLI cannot hang
 * `healthCheck()` forever. Overridable via {@link ProbeHealthDeps.deadlineMs}. */
export const DEFAULT_PROBE_DEADLINE_MS = 20_000

/** Real default for {@link ProbeHealthDeps.wait}: `unref`'d so an abandoned
 * deadline (the read finished first) never keeps the process alive. */
export function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/** Renders a thrown/rejected value into a stable message even when it is not an `Error` instance. */
function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Bound `readUntilClassified` so a CLI that connects and then emits nothing
 * cannot hang `probeHealth` — and therefore `AgentBackend.healthCheck()` —
 * forever. Uses the injected `wait` seam (mirrors `RunDeps.wait` in
 * agent-run.ts) rather than a bare timer so the deadline is a testable
 * value, not a real clock. On a timeout, aborts the controller so the
 * still-pending read eventually stops, and attaches a log-only handler to
 * that now-abandoned promise so a late settle (success or failure) never
 * surfaces as an unhandled rejection — the timeout has already committed to
 * its own verdict by then.
 */
export async function withProbeDeadline<T>(
  pending: Promise<T>,
  deps: Pick<HealthProbeDeps, "abortController" | "wait" | "deadlineMs">,
): Promise<T | ProbeDeadlineAbortError> {
  const wait = deps.wait ?? defaultWait
  const deadlineMs = deps.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS
  const timedOut = wait(deadlineMs).then(() => new ProbeDeadlineAbortError({ deadlineMs }))

  const winner = await Promise.race([pending, timedOut])
  if (!(winner instanceof ProbeDeadlineAbortError)) return winner

  deps.abortController.abort(winner)
  pending.catch((e) => {
    // Deliberately swallowed (rule: log what you don't propagate) — the
    // deadline already produced probeHealth's verdict; a late rejection from
    // the abandoned read is expected once we abort it above, not a new failure.
    console.warn("agent/health: probe read failed after the deadline already fired:", describeThrown(e))
  })
  return winner
}
