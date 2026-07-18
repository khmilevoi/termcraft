import type { HeartbeatWatchdog } from "../types"
import type { Clock, TimerHandle } from "./clock"
import { SupervisorError } from "./errors"

const HEARTBEAT_TIMEOUT_MS = 5_000
const UNRESPONSIVE_WINDOW_MS = 10_000
const UNRESPONSIVE_THRESHOLD = 3

/**
 * The §9 liveness watchdog. It owns the 5 s "time since last valid heartbeat"
 * bound on its own `Clock` timer, so silence trips it even while stale frame bytes
 * keep arriving — frames never substitute for heartbeats. It also counts request
 * timeouts: three within a rolling 10 s window mark the incarnation unresponsive.
 * It fires the injected `onUnhealthy(SupervisorError)` AT MOST ONCE; the supervisor
 * then runs the same fatal teardown path as any other fatal outcome.
 */
export function createHeartbeatWatchdog(
  clock: Clock,
  opts: { onUnhealthy: (error: SupervisorError) => void },
): HeartbeatWatchdog {
  let heartbeatTimer: TimerHandle | null = null
  let stopped = false
  let fired = false
  const timeoutStamps: number[] = []

  const fire = (error: SupervisorError) => {
    if (fired || stopped) return
    fired = true
    heartbeatTimer?.cancel()
    heartbeatTimer = null
    opts.onUnhealthy(error)
  }

  const armHeartbeat = () => {
    if (stopped || fired) return
    heartbeatTimer?.cancel()
    heartbeatTimer = clock.setTimer(HEARTBEAT_TIMEOUT_MS, () =>
      fire(new SupervisorError({ code: "HEARTBEAT_TIMEOUT", reason: "no valid heartbeat within 5s" })),
    )
  }

  return {
    start: armHeartbeat,
    feedHeartbeat: armHeartbeat,
    noteRequestTimeout() {
      if (stopped || fired) return
      const now = clock.now()
      timeoutStamps.push(now)
      while (timeoutStamps.length > 0 && now - timeoutStamps[0]! > UNRESPONSIVE_WINDOW_MS) {
        timeoutStamps.shift()
      }
      if (timeoutStamps.length >= UNRESPONSIVE_THRESHOLD) {
        fire(
          new SupervisorError({
            code: "QUERY_TIMEOUT",
            reason: `unresponsive: ${UNRESPONSIVE_THRESHOLD} request timeouts within ${UNRESPONSIVE_WINDOW_MS}ms`,
          }),
        )
      }
    },
    stop() {
      stopped = true
      heartbeatTimer?.cancel()
      heartbeatTimer = null
    },
  }
}
