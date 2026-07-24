import { afterEach, describe, expect, test } from "bun:test";

import type { PinDtoV1 } from "core/protocol";
import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { uuidv7 } from "infrastructure/uuid";
import { PreviewOverlays } from "ui/preview";
import { TEST_TS } from "ui/testing";
import { SHELL_PALETTE } from "ui/theme";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const pin = (overrides: Partial<PinDtoV1>): PinDtoV1 => ({
  pinId: uuidv7(),
  pageSlug: "main",
  elementId: "panel",
  fx: 0,
  fy: 0,
  text: "note",
  status: "open",
  createdRecordId: uuidv7(),
  latestRecordId: uuidv7(),
  updatedAt: TEST_TS,
  ...overrides,
});

const line = (rows: StyledRun[][], y: number) => (rows[y] ?? []).map((run) => run.text).join("");
const findRun = (rows: StyledRun[][], needle: string) =>
  rows.flat().find((run) => run.text.includes(needle));

describe("PreviewOverlays", () => {
  test("renders numbered open pins at their clamped frame anchors", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 5 });
    open = handle;
    handle.mount(
      <PreviewOverlays
        id="overlays"
        frameRect={{ x: 0, y: 0, width: 10, height: 5 }}
        pins={[pin({ fx: 0, fy: 0 }), pin({ fx: 1, fy: 1 }), pin({ status: "resolved" })]}
        pendingPin={null}
        selectionRect={null}
        hover={null}
      />,
    );
    await handle.render();
    const rows = handle.capture().rows;
    expect(line(rows, 0).startsWith("1")).toBe(true);
    expect(line(rows, 4).at(9)).toBe("2");
    expect(rows.flat().some((run) => run.text.includes("3"))).toBe(false);
    const badge = findRun(rows, "1");
    expect(badge && extractRgb(badge.fg)).toBe(SHELL_PALETTE.bg);
    expect(badge && extractRgb(badge.bg)).toBe(SHELL_PALETTE.amber);
  });

  test("renders the pending pin after existing open-pin numbers at the requested cell", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 5 });
    open = handle;
    handle.mount(
      <PreviewOverlays
        id="overlays"
        frameRect={{ x: 0, y: 0, width: 10, height: 5 }}
        pins={[pin({ fx: 0, fy: 0 })]}
        pendingPin={{ geometryToken: uuidv7(), point: { x: 4, y: 2 } }}
        selectionRect={null}
        hover={null}
      />,
    );
    await handle.render();
    expect(line(handle.capture().rows, 2).at(4)).toBe("2");
  });

  test("renders the exact amber selection corner glyphs", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 6 });
    open = handle;
    handle.mount(
      <PreviewOverlays
        id="overlays"
        frameRect={{ x: 0, y: 0, width: 12, height: 6 }}
        pins={[]}
        pendingPin={null}
        selectionRect={{ x: 2, y: 1, width: 3, height: 2 }}
        hover={null}
      />,
    );
    await handle.render();
    const rows = handle.capture().rows;
    for (const glyph of ["⌜", "⌝", "⌞", "⌟"]) {
      expect(rows.flat().some((run) => run.text.includes(glyph))).toBe(true);
      const run = findRun(rows, glyph);
      expect(run && extractRgb(run.fg)).toBe(SHELL_PALETTE.amber);
    }
  });

  test("renders the hover label amber-high on the design line colour", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 6 });
    open = handle;
    handle.mount(
      <PreviewOverlays
        id="overlays"
        frameRect={{ x: 0, y: 0, width: 24, height: 6 }}
        pins={[]}
        pendingPin={null}
        selectionRect={null}
        hover={{ rect: { x: 2, y: 2, width: 18, height: 2 }, label: 'panel "network"' }}
      />,
    );
    await handle.render();
    const rows = handle.capture().rows;
    const label = findRun(rows, 'panel "network"');
    expect(label && extractRgb(label.fg)).toBe(SHELL_PALETTE.amberHi);
    expect(label && extractRgb(label.bg)).toBe(SHELL_PALETTE.line);
  });
});
