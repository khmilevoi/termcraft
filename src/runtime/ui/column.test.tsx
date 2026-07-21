/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test";
import type { RenderHandle } from "host/render/types";
import type { StyledRun } from "host/protocol";
import { createHeadlessRenderer } from "host/render/model/renderer";
import { Text } from "./text";
import { Column } from "./column";

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

describe("Column layout container (design-system §3.2)", () => {
  test("stacks children on consecutive rows", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 });
    open = handle;
    handle.mount(
      <Column id="c">
        <Text id="a">A</Text>
        <Text id="b">B</Text>
      </Column>,
    );
    await handle.render();
    const frame = handle.capture();
    expect(lineText(frame, 0)).toContain("A");
    expect(lineText(frame, 1)).toContain("B");
    // Stacked, not overlaid — the first child does not appear on the second row.
    expect(lineText(frame, 0)).not.toContain("B");
  });

  test("gap inserts a blank row between children", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 4 });
    open = handle;
    handle.mount(
      <Column id="c" gap={1}>
        <Text id="a">A</Text>
        <Text id="b">B</Text>
      </Column>,
    );
    await handle.render();
    const frame = handle.capture();
    expect(lineText(frame, 0)).toContain("A");
    expect(lineText(frame, 1)).not.toContain("A");
    expect(lineText(frame, 1)).not.toContain("B");
    expect(lineText(frame, 2)).toContain("B");
  });
});
