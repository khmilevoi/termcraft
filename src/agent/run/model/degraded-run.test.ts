import { expect, test } from "bun:test"
import type { FencedEvent } from "agent/types"
import { createDegradedRun } from "./degraded-run"

const fence = { turnId: "t", attempt: 0, leaseNonce: "n" }

test(
  "createDegradedRun reports a single error event and a matching backend-error outcome",
  async () => {
    const run = createDegradedRun(fence, "Process-tree failure: no Job Object support")
    const events: FencedEvent[] = []
    for await (const ev of run.events) events.push(ev)
    expect(events).toEqual([
      { fence, event: { kind: "error", message: "Process-tree failure: no Job Object support" } },
    ])
    expect(await run.outcome).toEqual({
      kind: "backend-error",
      message: "Process-tree failure: no Job Object support",
      sessionId: null,
    })
  },
  2000,
)

test("the degraded run's fence matches the fence it was created with", () => {
  const run = createDegradedRun(fence, "boom")
  expect(run.fence).toBe(fence)
})
