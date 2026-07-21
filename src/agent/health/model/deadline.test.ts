import { expect, test } from "bun:test"
import { ProbeDeadlineAbortError, withProbeDeadline } from "./deadline"

// --- redistributed from claude/model/health.test.ts (pre-split): the deadline
// mechanism itself (the abort fired when the deadline wins the race) is
// generic to any backend, so it is unit-tested here directly against
// `withProbeDeadline`, with no Claude-shaped fake involved. ---

test("returns the pending value when it settles before the deadline", async () => {
  const winner = await withProbeDeadline(Promise.resolve("verdict"), {
    abortController: new AbortController(),
    wait: async () => {},
    deadlineMs: 10,
  })
  expect(winner).toBe("verdict")
})

test("aborts the controller and resolves to a ProbeDeadlineAbortError when the deadline elapses first", async () => {
  const controller = new AbortController()
  const winner = await withProbeDeadline(
    new Promise(() => {}), // never settles — the deadline must win the race
    { abortController: controller, wait: async () => {}, deadlineMs: 5 },
  )
  expect(winner).toBeInstanceOf(ProbeDeadlineAbortError)
  expect(controller.signal.aborted).toBe(true)
})
