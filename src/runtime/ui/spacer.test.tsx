/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test";
import type { RenderHandle } from "host/render/types";
import type { StyledRun } from "host/protocol";
import { createHeadlessRenderer } from "host/render/model/renderer";
import { Text } from "./text";
import { Row } from "./row";
import { Spacer } from "./spacer";

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

describe("Spacer (design-system §3.2)", () => {
  test("a fixed spacer inserts exactly `size` cells between siblings", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 });
    open = handle;
    handle.mount(
      <Row id="r">
        <Text id="a">A</Text>
        <Spacer id="s" size={3} />
        <Text id="b">B</Text>
      </Row>,
    );
    await handle.render();
    const text = lineText(handle.capture(), 0);
    expect(text.indexOf("A")).toBe(0);
    // A at 0, three spacer cells, then B → B lands at column 1 + size.
    expect(text.indexOf("B")).toBe(4);
  });

  test("a flexible spacer pushes siblings to opposite ends", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 });
    open = handle;
    handle.mount(
      <Row id="r">
        <Text id="a">A</Text>
        <Spacer id="s" />
        <Text id="b">B</Text>
      </Row>,
    );
    await handle.render();
    const text = lineText(handle.capture(), 0);
    expect(text.indexOf("A")).toBe(0);
    expect(text.indexOf("B")).toBe(11);
  });
});
