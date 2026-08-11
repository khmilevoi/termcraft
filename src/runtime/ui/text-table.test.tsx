import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { atom, reatomComponent } from "../model/reatom";
import { activeTokens } from "../model/tokens";
import { TextTable } from "./text-table";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const frameText = (frame: { rows: StyledRun[][] }): string =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");

const ROWS = [
  ["name", "cpu"],
  ["bun", "12%"],
] as const;

/** Mount one TextTable into a fresh renderer, paint, and return the whole frame's text. */
async function renderTableText(): Promise<string> {
  const handle = await createHeadlessRenderer({ w: 24, h: 4 });
  open = handle;
  handle.mount(<TextTable id="t" rows={ROWS} width={24} height={4} />);
  await handle.render();
  expect(handle.renderError()).toBeNull();
  const text = frameText(handle.capture());
  handle.destroy();
  open = null;
  return text;
}

describe("TextTable (spec §6.1)", () => {
  test("renders plain string cells in the foreground hue", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 4 });
    open = handle;
    handle.mount(<TextTable id="t" rows={ROWS} width={24} height={4} />);
    await handle.render();
    const frame = handle.capture();
    expect(frameText(frame)).toContain("name");
    expect(frameText(frame)).toContain("12%");
    const cell = allRuns(frame).find((run) => run.text.includes("name"));
    expect(cell && extractRgb(cell.fg)).toBe<string>(activeTokens().foreground);
  });

  test("a styled span carries its own Color", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 2 });
    open = handle;
    handle.mount(
      <TextTable
        id="t"
        rows={[[[{ text: "hot", color: activeTokens().danger }]]]}
        width={24}
        height={2}
      />,
    );
    await handle.render();
    const cell = allRuns(handle.capture()).find((run) => run.text.includes("hot"));
    expect(cell && extractRgb(cell.fg)).toBe<string>(activeTokens().danger);
  });

  test("borders are off by default and draw ROUNDED corners in the border token when enabled", async () => {
    expect(await renderTableText()).not.toMatch(/[╭╮╰╯│]/);

    const handle = await createHeadlessRenderer({ w: 24, h: 6 });
    open = handle;
    handle.mount(<TextTable id="t" rows={ROWS} borders width={24} height={6} />);
    await handle.render();
    // `─` is shared by both `rounded` and `single`, so it cannot tell them apart; the rounded
    // CORNER glyphs (`╭╮╰╯`) are what proves the design's rounded frame (I2) rather than a
    // square one — `┌┐└┘` would never match here.
    const border = allRuns(handle.capture()).find((run) => /[╭╮╰╯]/.test(run.text));
    expect(border && extractRgb(border.fg)).toBe<string>(activeTokens().border);
  });

  test("a token NAME is not a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().border`.
    const rejected = <TextTable id="x" rows={ROWS} borderColor="border" />;
    expect(rejected).toBeDefined();
  });

  test("a background change follows through a theme switch (I3: the missing vendor setter)", async () => {
    // `TextTableRenderable` has no `backgroundColor` setter, so this can only be observed
    // through a genuine in-place re-render — a `reatomComponent` reacting to an atom write, the
    // same mechanism `../model/tokens.reactivity.test.tsx` uses — not by calling `handle.mount()`
    // a second time, which (`host/render/model/renderer.ts` → `@opentui/react`'s `createRoot`)
    // rebuilds the whole reconciler container on every call and would always remount fresh.
    const bg = atom(activeTokens().surface, "test.textTable.background");
    const Probe = reatomComponent(
      () => <TextTable id="t" rows={ROWS} background={bg()} width={24} height={4} />,
      "test.textTable.Probe",
    );

    const handle = await createHeadlessRenderer({ w: 24, h: 4 });
    open = handle;
    handle.mount(<Probe />);
    await handle.render();
    const before = allRuns(handle.capture()).find((run) => run.text.includes("name"));
    expect(before && extractRgb(before.bg)).toBe<string>(activeTokens().surface);

    bg.set(activeTokens().background);
    await tick();
    await handle.render();
    const after = allRuns(handle.capture()).find((run) => run.text.includes("name"));
    expect(after && extractRgb(after.bg)).toBe<string>(activeTokens().background);
  });
});

describe("TextTable export determinism (spec §6.3)", () => {
  test("the export frame is identical to the preview frame for the same rows", async () => {
    hostModeAtom.set("preview");
    const preview = await renderTableText();
    hostModeAtom.set("export");
    const exported = await renderTableText();
    expect(exported).toBe(preview);
  });

  test("no selection back-fill can appear — selection is disabled", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 24, h: 4 });
    open = handle;
    handle.mount(<TextTable id="t" rows={ROWS} width={24} height={4} />);
    await handle.render();
    const filled = allRuns(handle.capture()).filter((run) => run.bg !== "default");
    expect(filled).toEqual([]);
  });
});
