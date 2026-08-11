import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { themeTokens } from "../model/tokens";
import { Diff } from "./diff";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame).find((run) => run.text.includes(needle));
const lines = (frame: { rows: StyledRun[][] }): string[] =>
  frame.rows.map((row) => row.map((run) => run.text).join(""));

// See plan D3. `@opentui/core@0.4.5` paints these when the matching colour prop is unset; none
// belongs to this project's palette, so one appearing in a frame means the wrapper stopped
// resolving that colour from the theme.
const VENDOR_HUES = ["#888888", "#ef4444", "#22c55e", "#4d1a1a", "#1a4d1a"];

const PATCH = `--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 const a = 1
-const b = 2
+const b = 3
 const c = 4
`;

// A ONE-LINE hunk: header counts must agree with the body (jsdiff's `parsePatch` refuses a
// mismatch and the wrapper degrades to the renderer's own parse-error frame — see diff.tsx's
// doc comment). No context line either side, so `@@ -1,1 +1,1 @@`, not `-1,2 +1,2` (which looked
// right by eye but disagreed with the two body lines and silently produced a parse-error frame
// instead of a diff).
const TS_PATCH = `--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-const answer = 41
+const answer = 42
`;

// Shared by every frame-identity comparison below, in this file's own `describe` block and the
// export-determinism block: create a headless renderer, mount, render, snapshot the frame as a
// string, and tear the renderer down again.
const captureOf = async (element: unknown): Promise<string> => {
  const handle = await createHeadlessRenderer({ w: 40, h: 6 });
  handle.mount(element);
  await handle.render();
  const captured = JSON.stringify(handle.capture());
  handle.destroy();
  return captured;
};

// A diff settles TWO highlight passes (left/right or unified single side plus the gutter's own
// line-info pass), not one — `Code`'s own default budget (1000ms, `DEFAULT_FRAME_SETTLE.budgetMs`)
// held in local runs, so it is reused here rather than widened speculatively; raise it at this
// call site alone (never in `settle.ts`) if it ever proves too tight for CI.
const DIFF_SETTLE_BUDGET_MS = 1000;

describe("Diff component (design-system §6.1)", () => {
  test("renders the unified view with signs and line numbers", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Diff id="patch" patch={PATCH} showLineNumbers />);
    await handle.render();
    const painted = lines(handle.capture());
    expect(painted[0]).toContain("const a = 1");
    expect(painted[1]).toContain("-");
    expect(painted[1]).toContain("const b = 2");
    expect(painted[2]).toContain("+");
    expect(painted[2]).toContain("const b = 3");
    expect(painted[3]).toContain("const c = 4");
  });

  test("the added sign is the success token and the removed sign is danger", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Diff id="patch" patch={PATCH} showLineNumbers />);
    await handle.render();
    const frame = handle.capture();
    const added = findRun(frame, "+");
    const removed = findRun(frame, "-");
    expect(added && extractRgb(added.fg)).toBe<string>(themeTokens("dark-default").success);
    expect(removed && extractRgb(removed.fg)).toBe<string>(themeTokens("dark-default").danger);
  });

  // The regression this whole fix wave exists for: with NO props beyond the mandatory `id` and
  // `patch` — the call an author is most likely to write — the frame must still distinguish the
  // added row from the removed one. Every OTHER sign assertion in this file passes
  // `showLineNumbers` explicitly, which is exactly why the earlier default-off regression went
  // uncaught.
  test("with no props beyond id and patch, the default render still distinguishes added from removed", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Diff id="patch" patch={PATCH} />);
    await handle.render();
    const frame = handle.capture();
    const added = findRun(frame, "+");
    const removed = findRun(frame, "-");
    expect(added && extractRgb(added.fg)).toBe<string>(themeTokens("dark-default").success);
    expect(removed && extractRgb(removed.fg)).toBe<string>(themeTokens("dark-default").danger);
  });

  // Plan D4: the design paints no diff band, so neither does the wrapper — and passing the
  // theme background explicitly is exactly what keeps the vendor's green/red bands out.
  test("added and removed rows sit on the theme background, with no vendor band", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Diff id="patch" patch={PATCH} showLineNumbers />);
    await handle.render();
    const frame = handle.capture();
    const addedContent = findRun(frame, "const b = 3");
    expect(addedContent && extractRgb(addedContent.bg)).toBe<string>(
      themeTokens("dark-default").background,
    );
    for (const run of allRuns(frame)) {
      expect(VENDOR_HUES).not.toContain(extractRgb(run.fg) ?? "");
      expect(VENDOR_HUES).not.toContain(extractRgb(run.bg) ?? "");
    }
  });

  test("a project may supply its own added/removed backgrounds", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(
      <Diff
        id="patch"
        patch={PATCH}
        showLineNumbers
        addedBackground="#0d2818"
        removedBackground="#4d2a20"
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const added = findRun(frame, "const b = 3");
    const removed = findRun(frame, "const b = 2");
    expect(added && extractRgb(added.bg)).toBe<string>("#0d2818");
    expect(removed && extractRgb(removed.bg)).toBe<string>("#4d2a20");
  });

  test("the split view lays the two sides out side by side", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 8 });
    open = handle;
    handle.mount(<Diff id="patch" patch={PATCH} view="split" showLineNumbers />);
    await handle.render();
    const painted = lines(handle.capture());
    // Both sides of a context line appear on one row in split view.
    expect(painted[0]?.match(/const a = 1/g)?.length).toBe(2);
  });

  test("the mandatory id reaches the element for host geometry", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Diff id="patch" patch={PATCH} />);
    await handle.render();
    expect(handle.rectOf("patch")).not.toBeNull();
  });

  test("an empty patch renders an empty frame instead of throwing", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 3 });
    open = handle;
    handle.mount(<Diff id="patch" patch="" />);
    await handle.render();
    expect(handle.renderError()).toBeNull();
    expect(lines(handle.capture()).join("").trim()).toBe("");
  });

  test("a non-patch string renders an empty frame instead of throwing", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 3 });
    open = handle;
    handle.mount(<Diff id="patch" patch="not a patch at all" />);
    await handle.render();
    expect(handle.renderError()).toBeNull();
    expect(lines(handle.capture()).join("").trim()).toBe("");
  });

  // The JSDoc on `showLineNumbers` promises "Defaults to `true`". Do not assert on digits/glyphs
  // directly — the fixture's own content contains "1"/"2"/"3"/"4", so a naive "line numbers in
  // the frame" check would be fragile or vacuous. Compare whole frames instead: omitting the prop
  // must render byte-identically to explicitly passing `true`.
  test("omitting showLineNumbers renders identically to passing it true — the documented default", async () => {
    const omitted = await captureOf(<Diff id="patch" patch={PATCH} />);
    const explicitTrue = await captureOf(<Diff id="patch" patch={PATCH} showLineNumbers />);
    expect(omitted).toBe(explicitTrue);
  });

  test("explicitly disabling showLineNumbers renders a different frame than the default", async () => {
    const omitted = await captureOf(<Diff id="patch" patch={PATCH} />);
    const noGutters = await captureOf(<Diff id="patch" patch={PATCH} showLineNumbers={false} />);
    expect(noGutters).not.toBe(omitted);
  });
});

// §6.1: highlighting is OPTIONAL and ASYNCHRONOUS. `DiffRenderable` exposes no public
// completion signal (unlike `CodeRenderable.highlightingDone`), so these settle the frame with
// `RenderHandle.settle()` rather than a single `render()` pass — see `code.test.tsx`'s own note
// on why a silently failed worker must fail the test, not degrade quietly.
describe("Diff syntax highlighting (§6.1)", () => {
  test("a typescript patch paints a keyword in a hue other than the content foreground", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 5 });
    open = handle;
    handle.mount(<Diff id="patch" patch={TS_PATCH} language="typescript" />);
    await handle.settle({ budgetMs: DIFF_SETTLE_BUDGET_MS });
    const keyword = findRun(handle.capture(), "const");
    expect(keyword).toBeDefined();
    expect(keyword && extractRgb(keyword.fg)).toBe<string>(themeTokens("dark-default").accent);
  });

  test("an unhighlighted patch keeps the content foreground", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 5 });
    open = handle;
    handle.mount(<Diff id="patch" patch={TS_PATCH} />);
    await handle.settle({ budgetMs: DIFF_SETTLE_BUDGET_MS });
    const content = findRun(handle.capture(), "answer");
    expect(content && extractRgb(content.fg)).toBe<string>(themeTokens("dark-default").foreground);
  });
});

// §6.3. `Diff` exposes no scroll and no focus, and layer 1 runs no async highlight pass, so the
// property is that the frame depends on nothing but its props. Task 4 REPLACES the first test
// here with a highlighted-frame assertion once P8's settle helper exists.
describe("Diff export determinism (§6.3)", () => {
  const renderOnce = () =>
    captureOf(<Diff id="patch" patch={PATCH} view="unified" showLineNumbers />);

  // Task 4: with `language` set, the frame the export path must snapshot is the SETTLED,
  // highlighted one. Equality alone is not enough — two identical UNHIGHLIGHTED frames would
  // satisfy `toBe` while missing exactly the defect §6.3 exists to catch (`code.test.tsx`'s own
  // note), so the highlighted frame is asserted before comparing.
  test("two independent renders in export mode produce identical HIGHLIGHTED frames", async () => {
    hostModeAtom.set("export");
    const mount = () => (
      <Diff id="patch" patch={TS_PATCH} view="unified" showLineNumbers language="typescript" />
    );

    const firstHandle = await createHeadlessRenderer({ w: 40, h: 6 });
    firstHandle.mount(mount());
    await firstHandle.settle({ budgetMs: DIFF_SETTLE_BUDGET_MS });
    const firstFrame = firstHandle.capture();
    const first = JSON.stringify(firstFrame);
    firstHandle.destroy();

    const secondHandle = await createHeadlessRenderer({ w: 40, h: 6 });
    secondHandle.mount(mount());
    await secondHandle.settle({ budgetMs: DIFF_SETTLE_BUDGET_MS });
    const second = JSON.stringify(secondHandle.capture());
    secondHandle.destroy();

    expect(first).toBe(second);

    // MUST filter empty/whitespace runs first (code.test.tsx's own guard): the headless
    // renderer's unwritten filler cells carry `fg = #ffffff`, distinct from the theme's own
    // `foreground`, so an unfiltered hue count would read "highlighted" on a plain frame too.
    const hues = new Set(
      allRuns(firstFrame)
        .filter((run) => run.text.trim().length > 0)
        .map((run) => extractRgb(run.fg)),
    );
    expect(hues.size).toBeGreaterThan(1);
    expect([...hues]).toContain(themeTokens("dark-default").accent);
  });

  test("the export frame equals the preview frame — no host-mode-dependent state", async () => {
    hostModeAtom.set("preview");
    const preview = await renderOnce();
    hostModeAtom.set("export");
    const exported = await renderOnce();
    expect(exported).toBe(preview);
  });
});
