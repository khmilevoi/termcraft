import { expect, test } from "bun:test"
import { createUnconfirmedExitLatch } from "./unconfirmed-exit-latch"

test("the latch stays unset for every non-unconfirmed outcome", () => {
  const latch = createUnconfirmedExitLatch("claude")
  latch.noteOutcome({ kind: "completed", finalText: "x", usage: null, sessionId: "s" })
  latch.noteOutcome({ kind: "cancelled", exitConfirmed: true })
  latch.noteOutcome({ kind: "backend-error", message: "m", sessionId: null })
  expect(latch.isLatched()).toBe(false)
})

test("the latch is sticky once an unconfirmed exit is noted", () => {
  const latch = createUnconfirmedExitLatch("claude")
  latch.noteOutcome({ kind: "unconfirmed-exit" })
  latch.noteOutcome({ kind: "completed", finalText: "x", usage: null, sessionId: "s" })
  expect(latch.isLatched()).toBe(true)
})
