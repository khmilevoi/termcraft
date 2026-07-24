import { afterEach, describe, expect, test } from "bun:test";

import type { PreviewFrameV1, StyledRunV1 } from "core/ports";
import type { StyledRun } from "host/protocol";
import { extractIndexed, extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { TEST_SHA } from "ui/testing";

import { FrameView, deferFrameRendered } from "./FrameView";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const run = (text: string, fg: StyledRunV1["fg"], attrs = 0): StyledRunV1 => ({
  text,
  fg,
  bg: "default",
  attrs,
});

const frame = (rows: readonly (readonly StyledRunV1[])[]): PreviewFrameV1 => ({
  sessionId: "s",
  sourceHash: TEST_SHA,
  frameSeq: "1",
  width: 10,
  height: rows.length,
  rows,
});

const lineText = (rows: StyledRun[][], row: number) =>
  (rows[row] ?? []).map((r) => r.text).join("");
const findRun = (rows: StyledRun[][], needle: string) =>
  rows.flat().find((r) => r.text.includes(needle));

describe("FrameView (preview frame compositing)", () => {
  test("defers the rendered callback out of traversal and schedules it once", async () => {
    const trace: string[] = [];

    deferFrameRendered(() => trace.push("callback"));
    trace.push("traversal-complete");

    expect(trace).toEqual(["traversal-complete"]);
    await Promise.resolve();
    expect(trace).toEqual(["traversal-complete", "callback"]);
    await Promise.resolve();
    expect(trace).toEqual(["traversal-complete", "callback"]);
  });

  test("reports completion through renderAfter", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 1 });
    open = handle;
    let renderCount = 0;
    handle.mount(
      <FrameView
        id="fv"
        frame={frame([[run("ready", "default")]])}
        onRendered={() => {
          renderCount += 1;
        }}
      />,
    );
    await handle.render();
    expect(renderCount).toBeGreaterThan(0);
  });

  test("renders the frame rows as text in order", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 2 });
    open = handle;
    handle.mount(
      <FrameView id="fv" frame={frame([[run("hello", "default")], [run("world", "default")]])} />,
    );
    await handle.render();
    const captured = handle.capture();
    expect(lineText(captured.rows, 0)).toContain("hello");
    expect(lineText(captured.rows, 1)).toContain("world");
  });

  test("a true-colour run keeps its rgb on the styled run", async () => {
    const handle = await createHeadlessRenderer({ w: 6, h: 1 });
    open = handle;
    handle.mount(<FrameView id="fv" frame={frame([[run("x", { rgb: "#ff8800" })]])} />);
    await handle.render();
    const styled = findRun(handle.capture().rows, "x");
    expect(styled && extractRgb(styled.fg)).toBe("#ff8800");
  });

  test("an indexed run keeps its palette slot", async () => {
    const handle = await createHeadlessRenderer({ w: 6, h: 1 });
    open = handle;
    handle.mount(<FrameView id="fv" frame={frame([[run("y", { indexed: 4 })]])} />);
    await handle.render();
    const styled = findRun(handle.capture().rows, "y");
    expect(styled && extractIndexed(styled.fg)).toBe(4);
  });

  test("the attribute bitmask reaches the styled run (bold=1)", async () => {
    const handle = await createHeadlessRenderer({ w: 6, h: 1 });
    open = handle;
    handle.mount(<FrameView id="fv" frame={frame([[run("z", "default", 1)]])} />);
    await handle.render();
    const styled = findRun(handle.capture().rows, "z");
    expect((styled?.attrs ?? 0) & 1).toBe(1);
  });
});
