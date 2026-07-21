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

  // --- adversarial review of slice 6D, item 2: correlation under GENUINE concurrency.
  // Every test above holds at most ONE outstanding request, so correlation-by-id is
  // observationally identical to "settle whichever entry is first in the map". The
  // host-supervision spec's replaced-hover-query scenario is genuinely concurrent —
  // these three tests hold TWO outstanding requests at once and settle them in an
  // order/manner that would desync a "settle the first entry" implementation.

  test("two concurrent requests of different kinds each resolve to their OWN reply, even when replies arrive out of order", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    const hit = table.register("1", "query-hit") // registered FIRST
    const resize = table.register("2", "resize") // registered SECOND
    expect(table.size()).toBe(2)

    // Answer them in the OPPOSITE order to registration: "2" first, then "1". A
    // resolve() that ignores `responseTo` and settles "whichever is first in the
    // map" would hand entry "1" the reply meant for "2" (and vice versa).
    table.resolve("2", reply("2", "resize-ack"))
    table.resolve("1", reply("1", "query-hit-reply"))

    const [hitResult, resizeResult] = await Promise.all([hit, resize])
    if (hitResult instanceof Error) throw hitResult
    if (resizeResult instanceof Error) throw resizeResult
    expect(hitResult.responseTo).toBe("1")
    expect(hitResult.kind).toBe("query-hit-reply")
    expect(resizeResult.responseTo).toBe("2")
    expect(resizeResult.kind).toBe("resize-ack")
    expect(table.size()).toBe(0)
  })

  test("a QUERY_TIMEOUT on one concurrent request does not disturb another concurrent request's own resolution", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    const hit = table.register("1", "query-hit") // left outstanding — will time out
    const ping = table.register("2", "ping") // answered right away

    table.resolve("2", reply("2", "pong"))
    clock.advance(2_000) // only "1" is still outstanding at the 2s deadline

    const [hitResult, pingResult] = await Promise.all([hit, ping])
    expect(hitResult).toBeInstanceOf(SupervisorError)
    if (hitResult instanceof SupervisorError) expect(hitResult.code).toBe("QUERY_TIMEOUT")
    if (pingResult instanceof Error) throw pingResult
    expect(pingResult.responseTo).toBe("2")
    expect(pingResult.kind).toBe("pong")
    expect(table.size()).toBe(0)
  })

  test("a SUPERSEDED on one concurrent request does not disturb another concurrent request's own resolution (§7 replaced hover query)", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    const staleHover = table.register("1", "query-hit") // the replaced hover
    const freshHover = table.register("2", "query-hit") // the replacement

    table.supersede("1", "replaced by a newer hover")
    table.resolve("2", reply("2", "query-hit"))

    const [staleResult, freshResult] = await Promise.all([staleHover, freshHover])
    expect(staleResult).toBeInstanceOf(SupervisorError)
    if (staleResult instanceof SupervisorError) {
      expect(staleResult.code).toBe("SUPERSEDED")
      expect(staleResult.reason).toContain("replaced")
    }
    if (freshResult instanceof Error) throw freshResult
    expect(freshResult.responseTo).toBe("2")
    expect(table.size()).toBe(0)
  })
})
