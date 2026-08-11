import { describe, expect, test } from "bun:test";

import type { StyledRun } from "../../protocol";
import { DEFAULT_FRAME_SETTLE, frameFingerprint, settleFrames } from "./settle";

// Deviation from the brief's literal snippet: `StyledRun.fg`/`bg` are `Color`
// (`"default" | { indexed } | { rgb }`), not a bare string, so the hex value is wrapped as
// `{ rgb }` to satisfy the real type. See `frameFingerprint`'s doc comment in `./settle.ts`.
const run = (text: string, fg: `#${string}`): StyledRun => ({
  text,
  fg: { rgb: fg },
  bg: { rgb: "#000000" },
  attrs: 0,
});
const frame = (runs: StyledRun[]) => ({ width: runs.length, height: 1, rows: [runs] });

/** A driver whose snapshots are handed to it, so the loop's logic is testable with no renderer. */
function createDriver(snapshots: readonly string[], pending: readonly Promise<void>[] = []) {
  let index = 0;
  let clock = 0;
  const passes: number[] = [];
  return {
    passes,
    driver: {
      render: async () => {
        passes.push(index);
      },
      snapshot: () => snapshots[Math.min(index++, snapshots.length - 1)] ?? "",
      pending: () => pending,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
  };
}

describe("frameFingerprint", () => {
  test("a colour-only change moves the fingerprint", () => {
    // THE ASSERTION THIS WHOLE MECHANISM RESTS ON. Highlighting changes ONLY colour. A
    // text-only fingerprint would call the plain-text frame 'quiet' on its first comparison
    // and return before a single hue arrived — the export hazard wearing a green test.
    const plain = frameFingerprint(frame([run("const", "#d7d0c2")]));
    const highlighted = frameFingerprint(frame([run("const", "#e6a23c")]));
    expect(plain).not.toBe(highlighted);
  });

  test("identical rows fingerprint identically", () => {
    expect(frameFingerprint(frame([run("a", "#111111")]))).toBe(
      frameFingerprint(frame([run("a", "#111111")])),
    );
  });
});

describe("settleFrames", () => {
  test("a frame that never changes settles after quietFrames comparisons", async () => {
    const { driver } = createDriver(["A", "A", "A", "A", "A"]);
    const result = await settleFrames(driver);
    expect(result.settled).toBe(true);
    expect(result.passes).toBe(DEFAULT_FRAME_SETTLE.quietFrames);
  });

  test("a frame that changes late still settles on the SETTLED content", async () => {
    // plain, plain, HIGHLIGHTED, highlighted, highlighted…
    const { driver } = createDriver(["A", "A", "B", "B", "B", "B"]);
    const result = await settleFrames(driver);
    expect(result.settled).toBe(true);
    // It must not have stopped at the first quiet pair — that pair was the PLAIN frame.
    expect(result.passes).toBeGreaterThan(DEFAULT_FRAME_SETTLE.quietFrames);
  });

  test("a frame that never stops changing gives up at the budget and says so", async () => {
    const forever = Array.from({ length: 500 }, (_value, index) => String(index));
    const { driver } = createDriver(forever);
    const result = await settleFrames(driver);
    expect(result.settled).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(DEFAULT_FRAME_SETTLE.budgetMs);
  });

  test("a pending highlight promise is awaited before the first comparison", async () => {
    let resolved = false;
    const pending = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        resolved = true;
        resolve();
      });
    });
    const { driver } = createDriver(["A", "A", "A"], [pending]);
    await settleFrames(driver);
    expect(resolved).toBe(true);
  });

  test("a pending promise that never resolves cannot outlast the budget", async () => {
    const never = new Promise<void>(() => {});
    const { driver } = createDriver(["A", "A", "A"], [never]);
    const result = await settleFrames(driver);
    // It settles on content even though the promise is still open — the promise is an
    // accelerator, never a gate.
    expect(result.settled).toBe(true);
  });
});
