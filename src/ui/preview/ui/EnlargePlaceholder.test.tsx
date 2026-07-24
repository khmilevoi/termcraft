import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { EnlargePlaceholder } from "./EnlargePlaceholder";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

interface Frame {
  readonly rows: StyledRun[][];
}

const findRun = (frame: Frame, needle: string): StyledRun | undefined =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const BOLD = 0b1;

describe("EnlargePlaceholder (design termSmall(), design/12-errors-edge-states.dc.html)", () => {
  test("renders the four literal lines", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 16 });
    open = handle;
    handle.mount(
      <EnlargePlaceholder
        id="enlarge"
        width={40}
        height={16}
        now={{ w: 58, h: 16 }}
        need={{ w: 80, h: 24 }}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "⚠ terminal too small")).toBeDefined();
    expect(findRun(frame, "enlarge the window to keep designing")).toBeDefined();
    expect(findRun(frame, "now  58×16")).toBeDefined();
    expect(findRun(frame, "need 80×24")).toBeDefined();
  });

  test("the title line is bold amber", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 16 });
    open = handle;
    handle.mount(
      <EnlargePlaceholder
        id="enlarge"
        width={40}
        height={16}
        now={{ w: 58, h: 16 }}
        need={{ w: 80, h: 24 }}
      />,
    );
    await handle.render();
    const run = findRun(handle.capture(), "⚠ terminal too small");
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amber);
    expect((run?.attrs ?? 0) & BOLD).toBe(BOLD);
  });

  test("the now line is red", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 16 });
    open = handle;
    handle.mount(
      <EnlargePlaceholder
        id="enlarge"
        width={40}
        height={16}
        now={{ w: 58, h: 16 }}
        need={{ w: 80, h: 24 }}
      />,
    );
    await handle.render();
    const run = findRun(handle.capture(), "now  58×16");
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.red);
    expect((run?.attrs ?? 0) & BOLD).toBe(BOLD);
  });

  test("the need line is faint", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 16 });
    open = handle;
    handle.mount(
      <EnlargePlaceholder
        id="enlarge"
        width={40}
        height={16}
        now={{ w: 58, h: 16 }}
        need={{ w: 80, h: 24 }}
      />,
    );
    await handle.render();
    const run = findRun(handle.capture(), "need 80×24");
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.faint);
  });
});
