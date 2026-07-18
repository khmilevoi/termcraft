import { describe, expect, test } from "bun:test"
import type { ControlEnvelope } from "../../protocol"
import { createManualClock } from "./clock"
import { SupervisorError } from "./errors"
import { REQUEST_TABLE_CAPACITY, createRequestTable } from "./request-table"

function reply(responseTo: string, kind = "pong"): ControlEnvelope {
  return {
    protocolVersion: 1,
    kind,
    sessionId: "s-1",
    nonce: "a".repeat(32),
    messageId: "9",
    responseTo,
    body: { ok: true },
  }
}

describe("createRequestTable", () => {
  test("register → resolve round-trips the envelope and empties the slot", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    const pending = table.register("1", "ping")
    expect(table.size()).toBe(1)
    table.resolve("1", reply("1"))
    const result = await pending
    expect(result).not.toBeInstanceOf(SupervisorError)
    if (result instanceof Error) throw result
    expect(result.responseTo).toBe("1")
    expect(table.size()).toBe(0)
  })

  test("2 s with no response completes the request once with QUERY_TIMEOUT and fires onTimeout", async () => {
    const clock = createManualClock()
    let timeouts = 0
    const table = createRequestTable(clock, { onTimeout: () => (timeouts += 1) })
    const pending = table.register("1", "query-hit")
    clock.advance(2_000)
    const result = await pending
    expect(result).toBeInstanceOf(SupervisorError)
    if (result instanceof SupervisorError) expect(result.code).toBe("QUERY_TIMEOUT")
    expect(table.size()).toBe(0)
    expect(timeouts).toBe(1)
  })

  test("supersede completes the request with SUPERSEDED (§7 replaced hover query)", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    const pending = table.register("1", "query-hit")
    table.supersede("1", "replaced by a newer hover")
    const result = await pending
    expect(result).toBeInstanceOf(SupervisorError)
    if (result instanceof SupervisorError) {
      expect(result.code).toBe("SUPERSEDED")
      expect(result.reason).toContain("replaced")
    }
  })

  test("the 65th outstanding register is rejected with TOO_MANY_REQUESTS without reserving a slot (§8)", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    for (let i = 1; i <= REQUEST_TABLE_CAPACITY; i += 1) table.register(String(i), "ping")
    expect(table.size()).toBe(REQUEST_TABLE_CAPACITY)
    const overflow = await table.register("65", "ping")
    expect(overflow).toBeInstanceOf(SupervisorError)
    if (overflow instanceof SupervisorError) expect(overflow.code).toBe("TOO_MANY_REQUESTS")
    expect(table.size()).toBe(REQUEST_TABLE_CAPACITY) // unchanged
  })

  test("a late resolve after the timeout is discarded, not a second resolution (§9)", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    const pending = table.register("1", "query-hit")
    clock.advance(2_000)
    const timedOut = await pending
    expect(timedOut).toBeInstanceOf(SupervisorError)
    // A response that arrives after the timeout must be a no-op — no throw, no second settle.
    expect(() => table.resolve("1", reply("1"))).not.toThrow()
    expect(table.size()).toBe(0)
  })

  test("resolve for an unknown responseTo is a no-op", () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    expect(() => table.resolve("does-not-exist", reply("does-not-exist"))).not.toThrow()
  })

  test("clear(error) resolves every outstanding request with the given error and cancels their timers", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    const a = table.register("1", "resize")
    const b = table.register("2", "shutdown")
    table.clear(new SupervisorError({ code: "MOUNT_TIMEOUT", reason: "unused-code-placeholder" }))
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toBeInstanceOf(SupervisorError)
    expect(rb).toBeInstanceOf(SupervisorError)
    expect(table.size()).toBe(0)
    expect(clock.pending()).toBe(0) // no leaked query timers
  })
})
