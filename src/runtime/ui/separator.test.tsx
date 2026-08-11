import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer, renderNodeOnce } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { activeTokens } from "../model/tokens";
import { Column } from "./column";
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
    expect(band && extractRgb(band.bg)).toBe<string>(activeTokens().line);
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
    expect(band && extractRgb(band.bg)).toBe<string>(activeTokens().line);
    expect(band?.text.length).toBe(1);
  });

  test("a horizontal separator spans its container even when the parent centres its children", async () => {
    const frame = await renderNodeOnce(
      <Column id="col" align="center">
        <Separator id="rule" color={activeTokens().success} />
      </Column>,
      { w: 20, h: 3 },
    );
    const filled = frame.rows[0]?.filter((run) => run.bg !== "default") ?? [];
    const width = filled.reduce((sum, run) => sum + run.text.length, 0);
    expect(width).toBe(20);
  });
});
