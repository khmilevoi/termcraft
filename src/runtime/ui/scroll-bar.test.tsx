import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { ScrollBar } from "./scroll-bar";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const THUMB = /[█▀▄]/;
const rowsText = (frame: { rows: StyledRun[][] }): string[] =>
  frame.rows.map((row) => row.map((run) => run.text).join(""));
const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();

/** Mount one vertical ScrollBar into a fresh 1x10 renderer and return its ten rows. */
async function renderScrollBarRows(position: number): Promise<string[]> {
  const handle = await createHeadlessRenderer({ w: 1, h: 10 });
  open = handle;
  handle.mount(
    <ScrollBar
      id="sb"
      orientation="vertical"
      contentSize={100}
      viewportSize={10}
      position={position}
      width={1}
      height={10}
    />,
  );
  await handle.render();
  expect(handle.renderError()).toBeNull();
  const rows = rowsText(handle.capture());
  handle.destroy();
  open = null;
  return rows;
}

describe("ScrollBar (spec §6.1)", () => {
  test("paints a thumb in accentDim over a track in line", async () => {
    const handle = await createHeadlessRenderer({ w: 1, h: 10 });
    open = handle;
    handle.mount(
      <ScrollBar
        id="sb"
        orientation="vertical"
        contentSize={100}
        viewportSize={10}
        position={0}
        width={1}
        height={10}
      />,
    );
    await handle.render();
    const thumb = allRuns(handle.capture()).find((run) => THUMB.test(run.text));
    expect(thumb && extractRgb(thumb.fg)).toBe<string>(activeTokens().accentDim);
    expect(thumb && extractRgb(thumb.bg)).toBe<string>(activeTokens().line);
  });

  test("takes no children (spec §6.1 spike)", () => {
    const rejected = (
      // @ts-expect-error — ScrollBarRenderable is a leaf; the wrapper declares no `children`.
      <ScrollBar id="x" orientation="vertical" contentSize={10} viewportSize={5} position={0}>
        {"nope"}
      </ScrollBar>
    );
    expect(rejected).toBeDefined();
  });
});

describe("ScrollBar export determinism (spec §6.3)", () => {
  test("the thumb sits at the top for position 0 and lower for a larger position", async () => {
    const top = await renderScrollBarRows(0);
    const bottom = await renderScrollBarRows(90);
    const firstThumbRow = (rows: string[]): number => rows.findIndex((row) => THUMB.test(row));
    expect(firstThumbRow(top)).toBe(0);
    expect(firstThumbRow(bottom)).toBeGreaterThan(firstThumbRow(top));
  });

  test("the export frame is identical to the preview frame for the same props", async () => {
    hostModeAtom.set("preview");
    const preview = await renderScrollBarRows(40);
    hostModeAtom.set("export");
    const exported = await renderScrollBarRows(40);
    expect(exported).toEqual(preview);
  });

  test("arrows are off by default, matching the design's scrollbar", async () => {
    const rows = await renderScrollBarRows(40);
    expect(rows.join("")).not.toMatch(/[▲▼↑↓]/);
  });
});
