import type { ControlEvent, ControlMailbox } from "../types"
import { SupervisorError } from "./errors"

/** Bounded inbound control mailbox capacity (host-supervision §8). */
export const CONTROL_MAILBOX_CAPACITY = 256

function backpressureError() {
  return new SupervisorError({ code: "CONTROL_BACKPRESSURE", reason: "inbound control mailbox full (256)" })
}

/**
 * The bounded host→supervisor inbound control mailbox (§8): 256 ordinary FIFO
 * entries plus one reserved terminal slot. `offer` past capacity returns
 * `CONTROL_BACKPRESSURE` without enqueuing; `offerTerminal` always lands in the
 * reserved slot (excluded from capacity). `drain` empties ordinary entries
 * before the terminal event, matching "use the reserved terminal slot for the
 * failure event". Errors are returned as values, never thrown.
 */
export function createControlMailbox(): ControlMailbox {
  const entries: ControlEvent[] = []
  let terminal: ControlEvent | null = null

  return {
    offer(event) {
      if (entries.length >= CONTROL_MAILBOX_CAPACITY) return backpressureError()
      entries.push(event)
      return "accepted"
    },

    offerTerminal(event) {
      terminal = event
    },

    drain() {
      const ordinary = entries.shift()
      if (ordinary !== undefined) return ordinary
      if (terminal !== null) {
        const t = terminal
        terminal = null
        return t
      }
      return null
    },

    size() {
      return entries.length
    },
  }
}
