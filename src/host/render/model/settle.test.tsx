import { afterEach, describe, expect, test } from "bun:test";

// Cross-module test-only edge (precedent: `src/gate/model/type-check.test.ts` imports
// `runtime/generated/runtime-dts`; `docs/architecture/code-structure.md` records that nothing
// restricts who may import `runtime`, only `runtime`'s own outgoing imports). This module's
// `collectHighlightingPromises` correctness rests on `instanceof CodeRenderable` genuinely
// matching a REAL `@opentui/core` mount — the fake `SettleDriver` used everywhere else in this
// file cannot prove that, only a real `Code`/`Markdown` component mounted on the real headless
// renderer can.
import { DARK_DEFAULT, DEFAULT_THEME_ID, seedThemeCapability } from "runtime/model/tokens";
import { Code } from "runtime/ui/code";
import { Markdown } from "runtime/ui/markdown";

import type { StyledRun } from "../../protocol";
import type { RenderHandle } from "../types";
import { createHeadlessRenderer } from "./renderer";
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
  let pendingCalls = 0;
  const passes: number[] = [];
  return {
    passes,
    // Exposed so a test can pin "the loop actually consulted `pending()`" instead of inferring
    // it indirectly from a promise that would resolve on its own regardless of whether anything
    // ever awaited it (see the "awaited before the first comparison" test below).
    pendingCalls: () => pendingCalls,
    driver: {
      render: async () => {
        passes.push(index);
      },
      snapshot: () => snapshots[Math.min(index++, snapshots.length - 1)] ?? "",
      pending: () => {
        pendingCalls += 1;
        return pending;
      },
      now: () => clock,
      // The simulated wall clock advances SYNCHRONOUSLY the moment `sleep` is called — this is
      // what makes the budget/quiet-frame math deterministic and instant to run, independent of
      // real timer resolution. The RETURNED PROMISE, though, resolves on the next macrotask
      // (`setImmediate`), not the current microtask queue. That distinction is load-bearing for
      // `settleFrames`' `Promise.race([Promise.all(pending()), sleep(pollMs)])`: production races
      // a microtask-resolving highlight promise against a genuinely-slow, macrotask-based
      // `Bun.sleep`, so any pending promise that is already settled (or settles via a handful of
      // microtask hops, as `Promise.all` does even on an already-rejected input) reliably beats
      // it — while a promise that never settles at all just as reliably does not. A synchronously
      // "resolved" fake `sleep` would let raw microtask-scheduling order (an implementation
      // detail of `Promise.all`'s internals, not a wall-clock fact) decide the race instead.
      sleep: (ms: number): Promise<void> => {
        clock += ms;
        return new Promise((resolve) => setImmediate(resolve));
      },
    },
  };
}

describe("frameFingerprint", () => {
  test("a colour-only change moves the fingerprint", () => {
    // THE ASSERTION THIS WHOLE MECHANISM RESTS ON. Highlighting changes ONLY colour. A
    // text-only fingerprint would call the plain-text frame 'quiet' on its first comparison
    // and return before a single hue arrived — the export hazard wearing a green test.
    // `#010101`/`#020202` are synthetic fixture values, not design colours (review finding,
    // 2026-08-11): this test is about fingerprint SENSITIVITY — that two distinct colours
    // produce two distinct fingerprints — not about which hues the design system uses, so any
    // two distinct, obviously-fake values do the job without a design hex literal.
    const plain = frameFingerprint(frame([run("const", "#010101")]));
    const highlighted = frameFingerprint(frame([run("const", "#020202")]));
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
    const { driver, pendingCalls } = createDriver(["A", "A", "A"], [pending]);
    await settleFrames(driver);
    expect(resolved).toBe(true);
    // `resolved` alone would pass even if `pending()` were never called — the promise resolves
    // via `queueMicrotask` on its own, on ANY await inside `settleFrames`. Pin that the loop
    // actually consulted the pending promises at least once, which is the behavior this test is
    // named for.
    expect(pendingCalls()).toBeGreaterThan(0);
  });

  test("a pending promise that never resolves cannot outlast the budget", async () => {
    // A promise that never resolves can never make a pass eligible for "quiet" (that's the
    // whole point of gating on `highlightsDone`), so this must NOT settle true — settling true
    // here would be exactly the original defect: declaring a frame done while the loop itself
    // observed the highlight signal still pending. The property this test actually pins is
    // "cannot hang forever" — the `while (now - started < budgetMs)` ceiling is what ends it,
    // honestly reporting `settled: false` because it could not confirm the highlight landed.
    const never = new Promise<void>(() => {});
    const { driver } = createDriver(["A", "A", "A"], [never]);
    const result = await settleFrames(driver);
    expect(result.settled).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(DEFAULT_FRAME_SETTLE.budgetMs);
  });

  test("a rejecting pending promise cannot make the loop throw", async () => {
    const broken = Promise.reject(new Error("highlight worker crashed"));
    // Attach a handler outside the race too, so this promise is never "unhandled" independent
    // of settleFrames's own internal `.catch`.
    broken.catch(() => {});
    const { driver } = createDriver(["A", "A", "A"], [broken]);
    // The assertion is that this resolves at all — a rejected `highlightingDone` must not
    // propagate out of `settleFrames` (its doc comment promises it "never throws"). A failed
    // highlight is exactly the case the quiet-frames backstop exists to fall through to.
    const result = await settleFrames(driver);
    expect(result.settled).toBe(true);
  });
});

describe("collectHighlightingPromises against a REAL @opentui/core renderable tree (IMPORTANT-2, final review)", () => {
  // Every test above proves `settleFrames`'s GATING logic against a hand-rolled `SettleDriver`
  // whose `pending()` is whatever the test hands it — none of them ever run `collectHighlighting
  // Promises` itself. That function's whole job rests on `node instanceof CodeRenderable`
  // (`./settle.ts`), which silently depends on THIS file and the renderer resolving the SAME
  // `@opentui/core` module instance — the package ships two builds (`chunk-bun-*`,
  // `chunk-node-*`). If that ever desynced, the walk would return `[]` for every mount, the
  // "precise signal" half of the settle fix would silently degrade to "quiet frames only", and
  // every test in this file would stay green regardless — exactly the regression `settle.ts`'s
  // header comment warns about. These two tests mount a REAL `Code` and a REAL `Markdown`
  // (`runtime/ui`) on the real headless renderer and assert the walk actually finds a promise for
  // each, which only happens if the `instanceof` check genuinely matches at runtime.
  let open: RenderHandle | null = null;
  afterEach(() => {
    open?.destroy();
    open = null;
    seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
  });

  test("finds at least one highlight promise for a real <Code> mount", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Code id="snippet" content="const a = 1" language="typescript" />);
    await handle.render();
    expect(handle.pendingHighlights().length).toBeGreaterThan(0);
  });

  test("finds at least one highlight promise for a real <Markdown> fenced block", async () => {
    const document = ["# Heading", "", "```ts", "const a = 1", "```", ""].join("\n");
    const handle = await createHeadlessRenderer({ w: 40, h: 12 });
    open = handle;
    handle.mount(<Markdown id="doc" content={document} />);
    await handle.render();
    // Every block — fenced code AND prose — is itself a `CodeRenderable` (`./settle.ts`'s doc
    // comment), so a document with a heading, prose and one fenced block yields more than one.
    expect(handle.pendingHighlights().length).toBeGreaterThan(0);
  });
});
