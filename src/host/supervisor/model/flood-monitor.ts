import type { FloodMonitor } from "../types"
import type { Clock } from "./clock"
import { SupervisorError } from "./errors"

export const FLOOD_WINDOW_MS = 1000
export const PROTOCOL_FLOOD_MAX_FRAMES = 1000
export const PROTOCOL_FLOOD_MAX_BYTES = 128 * 1024 * 1024
export const STDERR_FLOOD_MAX_BYTES = 1024 * 1024

interface WindowSample {
  readonly count: number
  readonly bytes: number
}

/**
 * A rolling-second log of `{ t, bytes }` on the injected clock. Each `note`
 * records the sample, prunes entries at or before `now - FLOOD_WINDOW_MS`
 * (strictly keeping `t > now - windowMs`), and returns the live count + summed
 * bytes still inside the window. The clock is monotonic, so entries are pushed
 * in nondecreasing `t` order and the oldest sit at the front.
 */
function createRollingWindow(clock: Clock) {
  const log: { t: number; bytes: number }[] = []
  return (byteLength: number): WindowSample => {
    const now = clock.now()
    log.push({ t: now, bytes: byteLength })
    const cutoff = now - FLOOD_WINDOW_MS
    while (log.length > 0 && log[0]!.t <= cutoff) log.shift()
    let bytes = 0
    for (const entry of log) bytes += entry.bytes
    return { count: log.length, bytes }
  }
}

/**
 * §8 rolling-second output flood detection. A separate window per stream: frames
 * trip on either >1000 envelopes or >128 MiB payload per second; stderr trips on
 * >1 MiB per second. All bounds are strictly-greater-than — the boundary value is
 * OK, the next byte/frame over it is fatal. Returns the fatal `SupervisorError`
 * so the supervisor can kill + open the circuit; never throws.
 */
export function createFloodMonitor(clock: Clock): FloodMonitor {
  const noteFrameSample = createRollingWindow(clock)
  const noteStderrSample = createRollingWindow(clock)

  return {
    noteFrame(byteLength) {
      const { count, bytes } = noteFrameSample(byteLength)
      if (count > PROTOCOL_FLOOD_MAX_FRAMES) {
        return new SupervisorError({
          code: "PROTOCOL_FLOOD",
          reason: `frames-per-second exceeded (${count} > ${PROTOCOL_FLOOD_MAX_FRAMES})`,
        })
      }
      if (bytes > PROTOCOL_FLOOD_MAX_BYTES) {
        return new SupervisorError({
          code: "PROTOCOL_FLOOD",
          reason: `frame bytes-per-second exceeded (${bytes} > ${PROTOCOL_FLOOD_MAX_BYTES})`,
        })
      }
      return null
    },
    noteStderr(byteLength) {
      const { bytes } = noteStderrSample(byteLength)
      if (bytes > STDERR_FLOOD_MAX_BYTES) {
        return new SupervisorError({
          code: "STDERR_FLOOD",
          reason: `stderr bytes-per-second exceeded (${bytes} > ${STDERR_FLOOD_MAX_BYTES})`,
        })
      }
      return null
    },
  }
}
