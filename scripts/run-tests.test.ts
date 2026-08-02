import { describe, expect, test } from "bun:test";

import { classifyBunTestRun } from "./run-tests";

const CLEAN = ` 4335 pass\n 0 fail\nRan 4335 tests across 312 files. [41.20s]\n`;
const FAILED = ` 4300 pass\n 35 fail\nRan 4335 tests across 312 files. [40.11s]\n`;
const PANIC =
  ` 1204 pass\n` +
  `panic(main thread): Segmentation fault at address 0x0\n` +
  `oh no: Bun has crashed. This indicates a bug in Bun, not your code.\n`;
// Captured verbatim from `FORCE_COLOR=1 bun test scripts/run-tests.test.ts` on this checkout:
// Bun wraps the summary line in ANSI escapes, so `^` no longer sits at the start of "6 pass".
const COLORED_CLEAN = `\x1b[0m\x1b[32m 6 pass\x1b[0m\n\x1b[0m\x1b[2m 0 fail\x1b[0m\n`;

describe("classifyBunTestRun", () => {
  test("a clean run with a summary and exit 0 is a pass", () => {
    expect(classifyBunTestRun({ exitCode: 0, output: CLEAN })).toBe("pass");
  });

  test("a run reporting failures is a fail", () => {
    expect(classifyBunTestRun({ exitCode: 1, output: FAILED })).toBe("fail");
  });

  test("a panic is CRASHED even though it printed no fail lines", () => {
    // The whole point: `PANIC` contains zero `(fail)` markers and a non-zero pass count, so
    // every "did anything fail?" reading of it says no.
    expect(PANIC).not.toContain("(fail)");
    expect(classifyBunTestRun({ exitCode: 3, output: PANIC })).toBe("crashed");
  });

  test("a segfault reported only by the shell exit code is CRASHED", () => {
    expect(classifyBunTestRun({ exitCode: 139, output: " 1204 pass\n" })).toBe("crashed");
  });

  test("exit 0 with no summary line at all is CRASHED, never a pass", () => {
    expect(classifyBunTestRun({ exitCode: 0, output: "" })).toBe("crashed");
  });

  test("a `0 fail` summary with a non-zero exit code is a fail, not a pass", () => {
    // Bun exits non-zero for a suite-level problem (an unhandled error between tests) that the
    // per-test counters do not show. Trusting the summary alone would launder it.
    expect(classifyBunTestRun({ exitCode: 1, output: CLEAN })).toBe("fail");
  });

  test("a colour-wrapped clean summary with exit 0 is still a pass", () => {
    // FORCE_COLOR=1 (common in shell profiles and some CI) puts an escape code where SUMMARY_LINE
    // expects the line to start, which must not read as an absent summary — i.e. a false crash.
    expect(classifyBunTestRun({ exitCode: 0, output: COLORED_CLEAN })).toBe("pass");
  });
});
