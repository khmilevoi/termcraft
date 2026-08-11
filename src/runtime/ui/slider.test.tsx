import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { Slider } from "./slider";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const THUMB = /[█▌▐]/;
const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const rowText = (frame: { rows: StyledRun[][] }, row: number): string =>
  (frame.rows[row] ?? []).map((run) => run.text).join("");

/** Mount one Slider into a fresh renderer, paint, and return the single captured row. */
async function renderSliderRow(value: number): Promise<{ text: string; runs: StyledRun[] }> {
  const handle = await createHeadlessRenderer({ w: 20, h: 1 });
  open = handle;
  handle.mount(
    <Slider
      id="s"
      orientation="horizontal"
      value={value}
      min={0}
      max={100}
      width={20}
      height={1}
    />,
  );
  await handle.render();
  expect(handle.renderError()).toBeNull();
  const frame = handle.capture();
  const captured = { text: rowText(frame, 0), runs: allRuns(frame) };
  handle.destroy();
  open = null;
  return captured;
}

describe("Slider (spec §6.1)", () => {
  test("paints a thumb in the fill hue over a track in the track hue", async () => {
    const { text, runs } = await renderSliderRow(50);
    expect(THUMB.test(text)).toBe(true);
    const thumb = runs.find((run) => THUMB.test(run.text));
    expect(thumb && extractRgb(thumb.fg)).toBe<string>(activeTokens().accent);
    expect(thumb && extractRgb(thumb.bg)).toBe<string>(activeTokens().border);
  });

  test("explicit colours override the theme defaults", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 1 });
    open = handle;
    handle.mount(
      <Slider
        id="s"
        orientation="horizontal"
        value={50}
        width={20}
        height={1}
        fillColor={activeTokens().success}
        trackColor={activeTokens().line}
      />,
    );
    await handle.render();
    const thumb = allRuns(handle.capture()).find((run) => THUMB.test(run.text));
    expect(thumb && extractRgb(thumb.fg)).toBe<string>(activeTokens().success);
  });

  test("a token NAME is not a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().accent`.
    const rejected = <Slider id="x" orientation="horizontal" value={1} fillColor="accent" />;
    expect(rejected).toBeDefined();
  });
});

describe("Slider export determinism (spec §6.3)", () => {
  test("the thumb position is a function of the prop value alone", async () => {
    const low = await renderSliderRow(0);
    const high = await renderSliderRow(100);
    expect(low.text.search(THUMB)).toBe(0);
    expect(high.text.search(THUMB)).toBeGreaterThan(low.text.search(THUMB));
    expect([...high.text].findLastIndex((char) => THUMB.test(char))).toBe(19);
  });

  test("the export frame is identical to the preview frame for the same props", async () => {
    hostModeAtom.set("preview");
    const preview = await renderSliderRow(37);
    hostModeAtom.set("export");
    const exported = await renderSliderRow(37);
    expect(exported.text).toBe(preview.text);
  });

  test("two independent export mounts of the same props render the same row", async () => {
    hostModeAtom.set("export");
    const first = await renderSliderRow(37);
    const second = await renderSliderRow(37);
    expect(second.text).toBe(first.text);
  });
});
