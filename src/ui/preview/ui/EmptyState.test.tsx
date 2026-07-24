import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { EmptyState } from "./EmptyState";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

describe("EmptyState component (design 20-empty-state.dc.html, wsEmpty)", () => {
  test("renders the exact literal message", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(<EmptyState id="empty" width={40} height={8} />);
    await handle.render();
    const frame = handle.capture();
    const run = frame.rows
      .flat()
      .find((cell: StyledRun) => cell.text.includes("No pages yet — describe what to build"));
    expect(run).toBeDefined();
  });

  test("the message run's foreground is the faint hex", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(<EmptyState id="empty" width={40} height={8} />);
    await handle.render();
    const frame = handle.capture();
    const run = frame.rows.flat().find((cell: StyledRun) => cell.text.includes("No pages yet"));
    expect(run && extractRgb(run.fg)).toBe(SHELL_PALETTE.faint);
  });
});
