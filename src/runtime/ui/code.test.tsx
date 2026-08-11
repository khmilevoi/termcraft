import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { DARK_DEFAULT, DEFAULT_THEME_ID, activeTokens, seedThemeCapability } from "../model/tokens";
import { Code } from "./code";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const allText = (frame: { rows: StyledRun[][] }) =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");
const hueOf = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame)
    .filter((run) => run.text.includes(needle))
    .map((run) => extractRgb(run.fg));

const TS_SOURCE = 'const answer = 42\n// why\nfunction go() { return "x" }\n';

/**
 * These tests call bare `.settle()` — the PRODUCTION defaults (`DEFAULT_FRAME_SETTLE`,
 * `host/render/model/settle.ts`) — deliberately. This is the first test in the repository that
 * mounts a real `Code`, and it is the proof that the defaults produce a highlighted frame against
 * a REAL tree-sitter WORKER, not just against `settleFrames`' own fake-driver unit tests.
 *
 * An earlier version of this file widened `.settle()`'s knobs (`{ budgetMs: 3000, pollMs: 100 }`)
 * to work around a real defect: `settleFrames` collected `CodeRenderable#highlightingDone`,
 * observed it still pending on every pass, and counted the quiet frames toward `settled` anyway
 * — the collected signal was gated on nothing. That let a widened poll interval mask the bug by
 * accident (a big enough window "usually" caught the highlight) rather than fixing the gate. The
 * fix (settle.ts) makes a quiet frame only count while no collected highlight promise is still in
 * flight, and raises `DEFAULT_FRAME_SETTLE.budgetMs` to 1000ms — the loop's actual ceiling once
 * gating is honoured for a cold grammar load. These tests use bare `.settle()` specifically so a
 * regression in either half of that fix shows up here again.
 */
describe("Code component (design-system §6.1)", () => {
  test("renders its content", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Code id="snippet" content={TS_SOURCE} language="typescript" />);
    await handle.settle();
    expect(allText(handle.capture())).toContain("const answer");
  });

  test("highlights TypeScript with the ACTIVE theme's hues (plan P8 D1)", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Code id="snippet" content={TS_SOURCE} language="typescript" />);
    await handle.settle();
    const frame = handle.capture();
    const t = activeTokens();
    // `const` is a keyword → the design's emphasis hue.
    expect(hueOf(frame, "const")).toContain(t.accent);
    // `42` is a literal → muted accent, never green.
    expect(hueOf(frame, "42")).toContain(t.accentDim);
    // The comment is the de-emphasis endpoint.
    expect(hueOf(frame, "why")).toContain(t.foregroundFaint);
  });

  test("A SILENTLY FAILED WORKER MUST FAIL THIS TEST, not degrade quietly", async () => {
    // The whole point of §6.3's rule: unhighlighted output is indistinguishable from correct
    // plain text unless a test asserts that a hue OTHER than the base foreground is present.
    //
    // MUST filter empty/whitespace runs before collecting hues (review finding, 2026-08-11): the
    // headless renderer's UNWRITTEN filler cells carry `fg = #ffffff`, distinct from the theme's
    // own `foreground` (#d7d0c2). With `h: 6` against a 3-line snippet, the captured frame has
    // filler rows below the content, so an unfiltered `hues.size > 1` was satisfied by
    // `{foreground, #ffffff filler}` alone — true on a COMPLETELY UNHIGHLIGHTED frame. The guard
    // must assert a hue the highlighter itself produces, not merely "more than one colour
    // anywhere in the buffer".
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Code id="snippet" content={TS_SOURCE} language="typescript" />);
    await handle.settle();
    const hues = new Set(
      allRuns(handle.capture())
        .filter((run) => run.text.trim().length > 0)
        .map((run) => extractRgb(run.fg)),
    );
    expect(hues.size).toBeGreaterThan(1);
    // The load-bearing assertion: a flat, unhighlighted frame of non-empty runs is exactly ONE
    // hue (`foreground`), so this alone fails on a silently-failed worker even if the size check
    // above were ever satisfied by accident.
    expect([...hues]).toContain(activeTokens().accent);
  });

  test("an unsupported language renders plain in the theme's foreground", async () => {
    // Only five grammars ship. Anything else resolves no parser and renders plain — no error,
    // no console output. That is a supported outcome, not a failure.
    const handle = await createHeadlessRenderer({ w: 40, h: 3 });
    open = handle;
    handle.mount(<Code id="snippet" content="fn main() {}" language="rust" />);
    await handle.settle();
    const frame = handle.capture();
    expect(allText(frame)).toContain("fn main()");
    const hues = new Set(
      allRuns(frame)
        .filter((run) => run.text.trim().length > 0)
        .map((run) => extractRgb(run.fg)),
    );
    expect([...hues]).toEqual([activeTokens().foreground]);
  });

  test("with no language it renders plain in the theme's foreground", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 3 });
    open = handle;
    handle.mount(<Code id="snippet" content="plain text" />);
    await handle.settle();
    const frame = handle.capture();
    expect(allText(frame)).toContain("plain text");
    const hues = new Set(
      allRuns(frame)
        .filter((run) => run.text.trim().length > 0)
        .map((run) => extractRgb(run.fg)),
    );
    expect([...hues]).toEqual([activeTokens().foreground]);
  });

  test("the highlight follows the ACTIVE theme, not the compiled seed", async () => {
    // #4cc9f0 is a synthetic test fixture, not a design colour.
    seedThemeCapability({ themeId: "midnight", tokens: { ...DARK_DEFAULT, accent: "#4cc9f0" } });
    const handle = await createHeadlessRenderer({ w: 40, h: 3 });
    open = handle;
    handle.mount(<Code id="snippet" content="const a = 1" language="typescript" />);
    await handle.settle();
    expect(hueOf(handle.capture(), "const")).toContain("#4cc9f0");
  });

  test("a token NAME is not a Color and the renderer internals are not props", () => {
    // @ts-expect-error — `syntaxStyle` is never exposed; termcraft builds it from the theme.
    const withStyle = <Code id="x" content="" syntaxStyle={undefined} />;
    // @ts-expect-error — `treeSitterClient` is never exposed (design spec §6, §6.1).
    const withClient = <Code id="y" content="" treeSitterClient={undefined} />;
    // @ts-expect-error — `id` is mandatory on every wrapper.
    const withoutId = <Code content="" />;
    expect([withStyle, withClient, withoutId]).toHaveLength(3);
  });
});

describe("Code export determinism (design-system §6.3)", () => {
  test("two settled renders of the same source produce byte-identical styled rows", async () => {
    const first = await createHeadlessRenderer({ w: 40, h: 6 });
    first.mount(<Code id="snippet" content={TS_SOURCE} language="typescript" />);
    await first.settle();
    const a = first.capture();
    first.destroy();

    const second = await createHeadlessRenderer({ w: 40, h: 6 });
    second.mount(<Code id="snippet" content={TS_SOURCE} language="typescript" />);
    await second.settle();
    const b = second.capture();
    second.destroy();

    expect(b).toEqual(a);
    // And BOTH must be the highlighted frame — two identical unhighlighted frames would pass
    // an equality-only assertion while being exactly the defect §6.3 names.
    expect(allRuns(a).map((run) => extractRgb(run.fg))).toContain(activeTokens().accent);
  });
});

describe("Code never reaches the network (design-system §6.1)", () => {
  test("no runtime source registers a tree-sitter parser", async () => {
    // Registering an extra grammar can fetch over HTTP — a runtime network dependency a shipped
    // binary must not take. The five bundled grammars resolve from local asset paths only. This
    // is a source-text assertion in the same style as index.test.ts's private-identity test,
    // because the fetch would happen in @opentui/core's WORKER, where a main-thread spy on
    // `fetch` proves nothing.
    //
    // TWO roots, not one (review finding, 2026-08-11): a registration call could physically sit
    // either in the wrapper layer (`src/runtime`) or in the renderer/settle plumbing that
    // actually drives `CodeRenderable` (`src/host/render`); scanning only the former would leave
    // the latter's guarantee unpinned even though it happens to hold today.
    // `import.meta.dir` + node:path, never `new URL(...).pathname` — the latter yields
    // `/C:/…` on Windows and no file opens.
    const roots = [
      path.resolve(import.meta.dir, ".."),
      path.resolve(import.meta.dir, "../../host/render"),
    ];
    const offenders: string[] = [];
    const visited: string[] = [];
    for (const root of roots) {
      for await (const relative of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
        // Skip test files: this very file's assertion literally names both banned calls in its
        // own source (the two `.includes(...)` string arguments right below, plus this comment),
        // so an unfiltered glob over `src/runtime` matches itself every run. The rule is about
        // runtime SOURCE never registering a parser, not about a check-for-the-name's-absence
        // naming the name it checks for.
        if (relative.endsWith(".test.ts") || relative.endsWith(".test.tsx")) continue;
        const absolute = path.join(root, relative);
        visited.push(absolute);
        const source = await Bun.file(absolute).text();
        if (source.includes("addFiletypeParser") || source.includes("addDefaultParsers")) {
          offenders.push(absolute);
        }
      }
    }
    expect(offenders).toEqual([]);
    // A scan that silently visits nothing (a broken `Bun.Glob`/`cwd`) would pass VACUOUSLY —
    // green while checking nothing (review finding, 2026-08-11). Pin that real files were
    // actually read: an arbitrary-but-generous floor, plus the one file this test exists to
    // guard explicitly named among what was visited.
    expect(visited.length).toBeGreaterThan(20);
    expect(visited).toContain(path.resolve(import.meta.dir, "code.tsx"));
  });
});
