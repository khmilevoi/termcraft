/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test";
import type { RenderHandle } from "host/render/types";
import type { StyledRun } from "host/protocol";
import { createHeadlessRenderer } from "host/render/model/renderer";
import { themeTokens } from "../model/tokens";
import { Gauge } from "./gauge";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const lineRuns = (frame: { rows: StyledRun[][] }, row: number): StyledRun[] =>
  frame.rows[row] ?? [];
const lineText = (frame: { rows: StyledRun[][] }, row: number) =>
  lineRuns(frame, row)
    .map((run) => run.text)
    .join("");
const count = (text: string, glyph: string) => [...text].filter((char) => char === glyph).length;

describe("Gauge component (design-system §3.2)", () => {
  test("value 0.5 over width 10 fills five cells and leaves five empty", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 1 });
    open = handle;
    handle.mount(<Gauge id="bar" value={0.5} width={10} />);
    await handle.render();
    const text = lineText(handle.capture(), 0);
    expect(count(text, "█")).toBe(5);
    expect(count(text, "╌")).toBe(5);
  });

  test("the filled span is accent and the empty span is the border track", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 1 });
    open = handle;
    handle.mount(<Gauge id="bar" value={0.5} width={10} />);
    await handle.render();
    const runs = lineRuns(handle.capture(), 0);
    const filled = runs.find((run) => run.text.includes("█"));
    const empty = runs.find((run) => run.text.includes("╌"));
    expect((filled?.fg as { rgb: string }).rgb).toBe(themeTokens("dark-default").accent);
    expect((empty?.fg as { rgb: string }).rgb).toBe(themeTokens("dark-default").border);
  });

  test("an out-of-range value clamps: >1 fills fully, <0 fills nothing", async () => {
    const over = await createHeadlessRenderer({ w: 6, h: 1 });
    open = over;
    over.mount(<Gauge id="hi" value={1.5} width={4} />);
    await over.render();
    const overText = lineText(over.capture(), 0);
    expect(count(overText, "█")).toBe(4);
    expect(count(overText, "╌")).toBe(0);
    over.destroy();
    open = null;

    const under = await createHeadlessRenderer({ w: 6, h: 1 });
    open = under;
    under.mount(<Gauge id="lo" value={-1} width={4} />);
    await under.render();
    const underText = lineText(under.capture(), 0);
    expect(count(underText, "█")).toBe(0);
    expect(count(underText, "╌")).toBe(4);
  });

  test("the label renders after the bar", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 1 });
    open = handle;
    handle.mount(<Gauge id="bar" value={0.5} width={10} label="50%" />);
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("50%");
  });
});
