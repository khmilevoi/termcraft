import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { themeTokens } from "../model/tokens";
import { Separator } from "./separator";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const lineRuns = (frame: { rows: StyledRun[][] }, row: number): StyledRun[] =>
  frame.rows[row] ?? [];

describe("Separator rule (design-system §3.2)", () => {
  test("a horizontal rule fills a full-width themed band on one row", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 3 });
    open = handle;
    handle.mount(<Separator id="sep" />);
    await handle.render();
    const frame = handle.capture();
    const band = lineRuns(frame, 0).find((run) => run.bg !== "default");
    expect(band && extractRgb(band.bg)).toBe<string>(themeTokens("dark-default").line);
    expect(band?.text.length).toBe(10);
    // Only one row thick — the next row carries no themed band.
    expect(lineRuns(frame, 1).find((run) => run.bg !== "default")).toBeUndefined();
  });

  test("a vertical rule fills a one-column themed band", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 3 });
    open = handle;
    handle.mount(<Separator id="sep" direction="vertical" />);
    await handle.render();
    const band = lineRuns(handle.capture(), 0).find((run) => run.bg !== "default");
    expect(band && extractRgb(band.bg)).toBe<string>(themeTokens("dark-default").line);
    expect(band?.text.length).toBe(1);
  });
});
