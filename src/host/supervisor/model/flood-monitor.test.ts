import { describe, expect, test } from "bun:test";

import { createManualClock } from "./clock";
import { SupervisorError } from "./errors";
import {
  FLOOD_WINDOW_MS,
  PROTOCOL_FLOOD_MAX_BYTES,
  PROTOCOL_FLOOD_MAX_FRAMES,
  STDERR_FLOOD_MAX_BYTES,
  createFloodMonitor,
} from "./flood-monitor";

describe("createFloodMonitor — constants (§8)", () => {
  test("exposes the §8 rolling-second bounds", () => {
    expect(FLOOD_WINDOW_MS).toBe(1000);
    expect(PROTOCOL_FLOOD_MAX_FRAMES).toBe(1000);
    expect(PROTOCOL_FLOOD_MAX_BYTES).toBe(128 * 1024 * 1024);
    expect(STDERR_FLOOD_MAX_BYTES).toBe(1024 * 1024);
  });
});

describe("createFloodMonitor — frame flood (§8)", () => {
  test("1000 frames in one window are fine; the 1001st trips PROTOCOL_FLOOD (frames-per-second)", () => {
    const clock = createManualClock();
    const monitor = createFloodMonitor(clock);
    for (let i = 0; i < PROTOCOL_FLOOD_MAX_FRAMES; i += 1) {
      expect(monitor.noteFrame(1)).toBeNull();
    }
    const over = monitor.noteFrame(1); // the 1001st
    expect(over).toBeInstanceOf(SupervisorError);
    if (over instanceof SupervisorError) {
      expect(over.code).toBe("PROTOCOL_FLOOD");
      expect(over.reason).toContain("frames");
    }
  });

  test("summed payload strictly over 128 MiB trips PROTOCOL_FLOOD (bytes-per-second), isolated from the frame count", () => {
    const clock = createManualClock();
    const monitor = createFloodMonitor(clock);
    // exactly 128 MiB in one frame is OK (not strictly over)
    expect(monitor.noteFrame(PROTOCOL_FLOOD_MAX_BYTES)).toBeNull();
    // advance a little so the count stays ≤1000 (2 entries) — only the byte sum can trip
    clock.advance(1);
    const over = monitor.noteFrame(1); // sum = 128 MiB + 1
    expect(over).toBeInstanceOf(SupervisorError);
    if (over instanceof SupervisorError) {
      expect(over.code).toBe("PROTOCOL_FLOOD");
      expect(over.reason).toContain("bytes");
    }
  });

  test("frames that age out of the rolling second do not accumulate", () => {
    const clock = createManualClock();
    const monitor = createFloodMonitor(clock);
    for (let i = 0; i < PROTOCOL_FLOOD_MAX_FRAMES; i += 1) {
      expect(monitor.noteFrame(1)).toBeNull();
    }
    clock.advance(FLOOD_WINDOW_MS + 1); // the t=0 batch ages out
    expect(monitor.noteFrame(1)).toBeNull(); // window now holds a single frame
  });
});

describe("createFloodMonitor — stderr flood (§8)", () => {
  test("stderr summed bytes at exactly 1 MiB are OK; strictly over trips STDERR_FLOOD", () => {
    const clock = createManualClock();
    const monitor = createFloodMonitor(clock);
    expect(monitor.noteStderr(STDERR_FLOOD_MAX_BYTES)).toBeNull();
    const over = monitor.noteStderr(1); // sum = 1 MiB + 1
    expect(over).toBeInstanceOf(SupervisorError);
    if (over instanceof SupervisorError) {
      expect(over.code).toBe("STDERR_FLOOD");
      expect(over.reason).toContain("stderr");
    }
  });

  test("a stderr burst that ages out of the rolling second resets", () => {
    const clock = createManualClock();
    const monitor = createFloodMonitor(clock);
    expect(monitor.noteStderr(STDERR_FLOOD_MAX_BYTES)).toBeNull();
    clock.advance(FLOOD_WINDOW_MS + 1); // the burst ages out
    expect(monitor.noteStderr(1)).toBeNull(); // window is empty again
  });
});

describe("createFloodMonitor — window independence (§8)", () => {
  test("a stderr flood does not affect frame counting", () => {
    const clock = createManualClock();
    const monitor = createFloodMonitor(clock);
    expect(monitor.noteStderr(STDERR_FLOOD_MAX_BYTES)).toBeNull();
    const stderrFlood = monitor.noteStderr(1);
    expect(stderrFlood).toBeInstanceOf(SupervisorError);
    // the frame window is untouched — a lone frame is fine
    expect(monitor.noteFrame(1)).toBeNull();
  });

  test("a frame flood does not affect stderr counting", () => {
    const clock = createManualClock();
    const monitor = createFloodMonitor(clock);
    for (let i = 0; i < PROTOCOL_FLOOD_MAX_FRAMES; i += 1) monitor.noteFrame(1);
    const frameFlood = monitor.noteFrame(1);
    expect(frameFlood).toBeInstanceOf(SupervisorError);
    // the stderr window is untouched — a small note is fine
    expect(monitor.noteStderr(1)).toBeNull();
  });
});
