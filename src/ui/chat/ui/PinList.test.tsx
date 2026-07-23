import { afterEach, describe, expect, test } from "bun:test";

import type { PinDtoV1 } from "core/protocol";
import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { uuidv7 } from "infrastructure/uuid";
import { SHELL_PALETTE } from "ui/theme";

import type { PinListRow } from "./PinList";
import { PinList } from "./PinList";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const pin = (overrides: Partial<PinDtoV1>): PinDtoV1 => ({
  pinId: uuidv7(),
  pageSlug: "main",
  elementId: "gauge-cpu",
  fx: 0.5,
  fy: 0.5,
  text: "make this gauge red",
  status: "open",
  createdRecordId: uuidv7(),
  latestRecordId: uuidv7(),
  updatedAt: "2026-07-22T00:00:00.000Z",
  ...overrides,
});

describe("PinList component (design 08-pin-comments.dc.html, wsPins / chatSeq pins)", () => {
  test("renders the 'PINS · <pageSlug>' header in faint bold", async () => {
    const rows: readonly PinListRow[] = [
      { pin: pin({ text: "table · why always top?" }), index: 0, visible: true },
    ];
    const handle = await createHeadlessRenderer({ w: 60, h: 6 });
    open = handle;
    handle.mount(<PinList id="pins" pageSlug="main" pins={rows} />);
    await handle.render();
    const frame = handle.capture();
    const header = findRun(frame, "PINS · main");
    expect(header).toBeDefined();
    expect(header && extractRgb(header.fg)).toBe(SHELL_PALETTE.faint);
    expect((header?.attrs ?? 0) & 1).toBe(1);
  });

  test("an open pin shows the numbered inverse-amber badge (index+1) and dim text", async () => {
    const rows: readonly PinListRow[] = [
      { pin: pin({ text: "table · why always top?" }), index: 1, visible: true },
    ];
    const handle = await createHeadlessRenderer({ w: 60, h: 6 });
    open = handle;
    handle.mount(<PinList id="pins" pageSlug="main" pins={rows} />);
    await handle.render();
    const frame = handle.capture();
    const badge = findRun(frame, "2");
    expect(badge).toBeDefined();
    expect(badge && extractRgb(badge.fg)).toBe(SHELL_PALETTE.bg);
    expect(badge && extractRgb(badge.bg)).toBe(SHELL_PALETTE.amber);
    expect((badge?.attrs ?? 0) & 1).toBe(1);
    const text = findRun(frame, "table · why always top?");
    expect(text && extractRgb(text.fg)).toBe(SHELL_PALETTE.dim);
  });

  test("a resolved pin shows the green ✓ (not bold) and faint text", async () => {
    const rows: readonly PinListRow[] = [
      {
        pin: pin({ status: "resolved", text: "network · add labels · reopen" }),
        index: 0,
        visible: true,
      },
    ];
    const handle = await createHeadlessRenderer({ w: 60, h: 6 });
    open = handle;
    handle.mount(<PinList id="pins" pageSlug="main" pins={rows} />);
    await handle.render();
    const frame = handle.capture();
    const mark = findRun(frame, "✓");
    expect(mark).toBeDefined();
    expect(mark && extractRgb(mark.fg)).toBe(SHELL_PALETTE.green);
    expect((mark?.attrs ?? 0) & 1).toBe(0);
    const text = findRun(frame, "network · add labels · reopen");
    expect(text && extractRgb(text.fg)).toBe(SHELL_PALETTE.faint);
  });

  test("an orphan (open, not visible) pin shows the amberDim ⚠ (not bold) and the §3.2 marker copy", async () => {
    const rows: readonly PinListRow[] = [
      {
        pin: pin({ text: "header · missing from current render" }),
        index: 0,
        visible: false,
      },
    ];
    const handle = await createHeadlessRenderer({ w: 140, h: 6 });
    open = handle;
    handle.mount(<PinList id="pins" pageSlug="main" pins={rows} />);
    await handle.render();
    const frame = handle.capture();
    const mark = findRun(frame, "⚠");
    expect(mark).toBeDefined();
    expect(mark && extractRgb(mark.fg)).toBe(SHELL_PALETTE.amberDim);
    expect((mark?.attrs ?? 0) & 1).toBe(0);
    const text = findRun(frame, "not visible in the current render (hidden or removed)");
    expect(text).toBeDefined();
    expect(text && extractRgb(text.fg)).toBe(SHELL_PALETTE.faint);
  });

  test("renders nothing when there are no pins", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 6 });
    open = handle;
    handle.mount(<PinList id="pins" pageSlug="main" pins={[]} />);
    await handle.render();
    const frame = handle.capture();
    const text = frame.rows
      .flat()
      .map((run) => run.text)
      .join("");
    expect(text.trim()).toBe("");
  });
});
