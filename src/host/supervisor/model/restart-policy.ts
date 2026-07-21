import { ProtocolError } from "../../protocol";
import type { RestartAction, RestartPolicy } from "../types";
import { SupervisorError } from "./errors";

/** Rolling failure window (§10): at most 3 automatic restarts within 60s. */
export const RESTART_WINDOW_MS = 60_000;
/** At most three automatic restarts ⇒ four failed incarnations total (§10). */
export const MAX_AUTOMATIC_RESTARTS = 3;
/** Deterministic base-2 backoff (§10): 250 / 500 / 1000 ms. */
export const BACKOFF_BASE_MS = 250;

/**
 * SupervisorError codes that are deterministic/hostile rather than transient: a
 * restart cannot fix a flooding child or a consumer that cannot drain, so they
 * open the circuit immediately just like every schema/negotiation ProtocolError
 * (§10, §12). Every OTHER SupervisorError (crash, broken pipe, heartbeat/request
 * timeout, transient spawn, mount/handshake timeout, render failure) is budgeted.
 */
const DETERMINISTIC_SUPERVISOR_CODES = new Set<string>([
  "PROTOCOL_FLOOD",
  "STDERR_FLOOD",
  "CONTROL_BACKPRESSURE",
]);

/**
 * Classify an incarnation failure (§10). All 7 ProtocolViolationCode values are
 * schema/negotiation/identity/kit/source-hash failures, so every ProtocolError is
 * deterministic ⇒ open now. Flood/backpressure SupervisorErrors are deterministic
 * too; the rest are budgeted (restart within the crash-loop budget).
 */
export function classifyFailure(
  error: ProtocolError | SupervisorError,
): "budgeted" | "deterministic" {
  if (error instanceof ProtocolError) return "deterministic";
  return DETERMINISTIC_SUPERVISOR_CODES.has(String(error.code)) ? "deterministic" : "budgeted";
}

interface KeyState {
  /** Monotonic timestamps of budgeted failures still inside the rolling window. */
  readonly failures: number[];
  open: boolean;
}

/**
 * The per-`(pageSlug, sourceHash)` restart budget + base-2 backoff + circuit
 * breaker (host-supervision §10). Pure and clock-free: `now` is a parameter, so a
 * budgeted failure count is a deterministic function of the recorded timestamps.
 * "60 s continuous ready clears the history" is realized by the rolling-60 s
 * window prune in `recordFailure` — a child that stays `ready` 60 s ages every
 * prior failure out of the window, which is exactly that clear (no background
 * timer needed). The circuit latches open until a user `retry` clears the key.
 */
export function createRestartPolicy(opts?: {
  windowMs?: number;
  maxRestarts?: number;
  backoffBaseMs?: number;
}): RestartPolicy {
  const windowMs = opts?.windowMs ?? RESTART_WINDOW_MS;
  const maxRestarts = opts?.maxRestarts ?? MAX_AUTOMATIC_RESTARTS;
  const backoffBaseMs = opts?.backoffBaseMs ?? BACKOFF_BASE_MS;
  const keys = new Map<string, KeyState>();

  const stateOf = (key: string): KeyState => {
    const existing = keys.get(key);
    if (existing !== undefined) return existing;
    const created: KeyState = { failures: [], open: false };
    keys.set(key, created);
    return created;
  };

  const prune = (state: KeyState, now: number): void => {
    const cutoff = now - windowMs;
    while (state.failures.length > 0 && state.failures[0]! <= cutoff) state.failures.shift();
  };

  function recordFailure(
    key: string,
    error: ProtocolError | SupervisorError,
    now: number,
  ): RestartAction {
    const state = stateOf(key);
    if (state.open)
      return { action: "open", attempts: state.failures.length, reason: "circuit already open" };

    prune(state, now);
    state.failures.push(now);
    const attempt = state.failures.length;

    if (classifyFailure(error) === "deterministic") {
      state.open = true;
      return { action: "open", attempts: attempt, reason: `deterministic failure [${error.code}]` };
    }
    if (attempt > maxRestarts) {
      state.open = true;
      return {
        action: "open",
        attempts: attempt,
        reason: `restart budget exhausted (${maxRestarts} in ${windowMs}ms)`,
      };
    }
    return { action: "restart", delayMs: backoffBaseMs * 2 ** (attempt - 1), attempt };
  }

  return {
    recordFailure,
    isOpen: (key) => keys.get(key)?.open ?? false,
    retry(key) {
      const state = keys.get(key);
      if (state === undefined) return;
      state.failures.length = 0;
      state.open = false;
    },
    failureCount(key, now) {
      const state = keys.get(key);
      if (state === undefined) return 0;
      prune(state, now);
      return state.failures.length;
    },
  };
}
