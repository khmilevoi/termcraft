import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { Row } from "./row";
import { Text } from "./text";

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

describe("Row layout container (design-system §3.2)", () => {
  test("lays two children out on the same row", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(
      <Row id="r">
        <Text id="a">A</Text>
        <Text id="b">B</Text>
      </Row>,
    );
    await handle.render();
    const frame = handle.capture();
    expect(lineText(frame, 0)).toContain("A");
    expect(lineText(frame, 0)).toContain("B");
    // Both children share row 0 — neither leaks onto the next row.
    expect(lineText(frame, 1)).not.toContain("A");
    expect(lineText(frame, 1)).not.toContain("B");
  });

  test("justify='between' distributes children to opposite ends", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 2 });
    open = handle;
    handle.mount(
      <Row id="r" justify="between">
        <Text id="a">A</Text>
        <Text id="b">B</Text>
      </Row>,
    );
    await handle.render();
    const text = lineText(handle.capture(), 0);
    expect(text.indexOf("A")).toBe(0);
    expect(text.indexOf("B")).toBe(9);
  });
});
