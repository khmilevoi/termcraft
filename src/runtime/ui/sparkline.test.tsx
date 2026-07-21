import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { themeTokens } from "../model/tokens";
import { Sparkline } from "./sparkline";

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

const GLYPHS = "▁▂▃▄▅▆▇█";

describe("Sparkline component (design-system §3.2)", () => {
  test("ascending values map to ascending glyphs, with max → █ and min → ▁", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 1 });
    open = handle;
    handle.mount(<Sparkline id="trend" values={[0, 1, 2, 3]} />);
    await handle.render();
    const glyphs = [...lineText(handle.capture(), 0)].filter((char) => GLYPHS.includes(char));
    expect(glyphs).toHaveLength(4);
    expect(glyphs[0]).toBe("▁");
    expect(glyphs[3]).toBe("█");
    const indices = glyphs.map((glyph) => GLYPHS.indexOf(glyph));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices[0]).toBeLessThan(indices[3] ?? -1);
  });

  test("renders the glyph string in the token color (default success)", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 1 });
    open = handle;
    handle.mount(<Sparkline id="trend" values={[0, 1, 2, 3]} />);
    await handle.render();
    const run = lineRuns(handle.capture(), 0).find((styled) =>
      [...styled.text].some((char) => GLYPHS.includes(char)),
    );
    expect(run && extractRgb(run.fg)).toBe<string>(themeTokens("dark-default").success);
  });

  test("an empty series renders empty without throwing", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 1 });
    open = handle;
    handle.mount(<Sparkline id="trend" values={[]} />);
    await handle.render();
    const glyphs = [...lineText(handle.capture(), 0)].filter((char) => GLYPHS.includes(char));
    expect(glyphs).toHaveLength(0);
  });
});
