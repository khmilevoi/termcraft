import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { PinInputPopup } from "./PinInputPopup";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

describe("PinInputPopup component (design wsPinInput)", () => {
  test("renders the 'new pin' title in the amberHi hue", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 5 });
    open = handle;
    handle.mount(<PinInputPopup id="pin-input" value="" />);
    await handle.render();
    const run = findRun(handle.capture(), "new pin");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amberHi);
  });

  test("renders a non-empty value in the foreground hue", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 5 });
    open = handle;
    handle.mount(<PinInputPopup id="pin-input" value="why is this always on top?" />);
    await handle.render();
    const run = findRun(handle.capture(), "why is this always on top?");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.fg);
  });

  test("renders the footer hint in the faint hue", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 5 });
    open = handle;
    handle.mount(<PinInputPopup id="pin-input" value="" />);
    await handle.render();
    const run = findRun(handle.capture(), "⏎ save · esc cancel");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("renders a blinking cursor glyph", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 5 });
    open = handle;
    handle.mount(<PinInputPopup id="pin-input" value="hi" />);
    await handle.render();
    // Note: BLINK has no protocol mask bit (host/render/model/attributes.ts's
    // `attributesToMask` comment), so the cursor's blink attribute cannot be
    // asserted through `run.attrs` here — only its presence and color.
    const run = findRun(handle.capture(), "█");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amber);
  });
});
