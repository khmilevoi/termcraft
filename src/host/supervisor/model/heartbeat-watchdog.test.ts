import { describe, expect, test } from "bun:test";

import { createManualClock } from "./clock";
import { SupervisorError } from "./errors";
import { createHeartbeatWatchdog } from "./heartbeat-watchdog";

function collector() {
  const errors: SupervisorError[] = [];
  return { errors, onUnhealthy: (error: SupervisorError) => errors.push(error) };
}

describe("createHeartbeatWatchdog", () => {
  test("5 s with no heartbeat after start() fires HEARTBEAT_TIMEOUT once", () => {
    const clock = createManualClock();
    const sink = collector();
    const watchdog = createHeartbeatWatchdog(clock, sink);
    watchdog.start();
    clock.advance(5_000);
    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]?.code).toBe("HEARTBEAT_TIMEOUT");
    clock.advance(10_000); // never fires again
    expect(sink.errors).toHaveLength(1);
  });

  test("feedHeartbeat re-arms the 5 s deadline", () => {
    const clock = createManualClock();
    const sink = collector();
    const watchdog = createHeartbeatWatchdog(clock, sink);
    watchdog.start();
    clock.advance(4_000);
    watchdog.feedHeartbeat();
    clock.advance(4_000); // 4 s since the feed — still healthy
    expect(sink.errors).toHaveLength(0);
    clock.advance(1_000); // now 5 s since the feed
    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]?.code).toBe("HEARTBEAT_TIMEOUT");
  });

  test("noteRequestTimeout does NOT re-arm the heartbeat deadline (frames/queries can't keep a silent host alive, §9)", () => {
    const clock = createManualClock();
    const sink = collector();
    const watchdog = createHeartbeatWatchdog(clock, sink);
    watchdog.start();
    clock.advance(4_000);
    watchdog.noteRequestTimeout(); // a query timed out; this must not extend the heartbeat deadline
    clock.advance(1_000); // 5 s since start with no heartbeat
    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]?.code).toBe("HEARTBEAT_TIMEOUT");
  });

  test("3 request timeouts within a rolling 10 s window escalate to unresponsive (§9)", () => {
    const clock = createManualClock();
    const sink = collector();
    const watchdog = createHeartbeatWatchdog(clock, sink);
    // Exercise the unresponsive counter in ISOLATION: do NOT start() — that would arm
    // the 5 s heartbeat deadline, which fires during these advances and pre-empts the
    // 3rd timeout via the shared one-shot `fired` flag. Heartbeat timing has its own
    // tests; noteRequestTimeout is independent of the heartbeat deadline.
    watchdog.noteRequestTimeout(); // t=0
    clock.advance(3_000);
    watchdog.noteRequestTimeout(); // t=3s
    clock.advance(3_000);
    watchdog.noteRequestTimeout(); // t=6s — 3 within 10 s
    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]?.code).toBe("QUERY_TIMEOUT"); // reused code; reason marks "unresponsive"
    expect(sink.errors[0]?.reason).toContain("unresponsive");
  });

  test("request timeouts spread beyond 10 s do NOT escalate (window drops the oldest)", () => {
    const clock = createManualClock();
    const sink = collector();
    const watchdog = createHeartbeatWatchdog(clock, sink);
    // Unresponsive counter in isolation — no start() (see the sibling test's note).
    watchdog.noteRequestTimeout(); // t=0
    clock.advance(6_000);
    watchdog.noteRequestTimeout(); // t=6s
    clock.advance(6_000); // t=12s — the t=0 stamp is now older than 10 s
    watchdog.noteRequestTimeout(); // only 2 within the rolling window (t=6s, t=12s)
    // No unresponsive escalation. (A heartbeat one is possible — feed to keep it clean.)
    expect(sink.errors.filter((e) => (e.reason as string).includes("unresponsive"))).toHaveLength(
      0,
    );
  });

  test("stop() cancels the heartbeat timer — no fire and no leaked timers", () => {
    const clock = createManualClock();
    const sink = collector();
    const watchdog = createHeartbeatWatchdog(clock, sink);
    watchdog.start();
    watchdog.stop();
    expect(clock.pending()).toBe(0);
    clock.advance(10_000);
    expect(sink.errors).toHaveLength(0);
  });
});
