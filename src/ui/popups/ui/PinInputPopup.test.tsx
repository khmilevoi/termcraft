import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import type { EditorBridge } from "ui/text-input";
import { SHELL_PALETTE } from "ui/theme";

import { PinInputPopup } from "./PinInputPopup";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

/** A stub bridge that seeds the editor with `seed` at mount and ignores mirror writes. */
const bridgeWith = (seed: string): EditorBridge => ({
  attach: (handle) => {
    if (handle !== null) handle.setText(seed);
  },
  mirror: () => undefined,
});

describe("PinInputPopup component (design wsPinInput)", () => {
  test("renders the 'new pin' title in the amberHi hue", async () => {
    const handle = await createHeadlessRenderer({ w: 48, h: 6 });
    open = handle;
    handle.mount(<PinInputPopup id="pin-input" focused bridge={bridgeWith("")} />);
    await handle.render();
    const run = findRun(handle.capture(), "new pin");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amberHi);
  });

  test("renders a seeded comment in the foreground hue", async () => {
    const handle = await createHeadlessRenderer({ w: 48, h: 6 });
    open = handle;
    handle.mount(
      <PinInputPopup id="pin-input" focused bridge={bridgeWith("why is this always on top?")} />,
    );
    await handle.render();
    const run = findRun(handle.capture(), "why is this always on top?");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.fg);
  });

  test("renders the footer hint in the faint hue", async () => {
    const handle = await createHeadlessRenderer({ w: 48, h: 6 });
    open = handle;
    handle.mount(<PinInputPopup id="pin-input" focused bridge={bridgeWith("")} />);
    await handle.render();
    const run = findRun(handle.capture(), "⏎ save · esc cancel");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("replaces the hint with the failed save's message, in the red hue", async () => {
    const handle = await createHeadlessRenderer({ w: 48, h: 6 });
    open = handle;
    handle.mount(
      <PinInputPopup
        id="pin-input"
        focused
        bridge={bridgeWith("why is this red?")}
        error="✗ anchor lost — click the spot again"
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const run = findRun(frame, "✗ anchor lost");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.red);
    expect(findRun(frame, "⏎ save · esc cancel")).toBeUndefined();
    // The comment survives the failure — it is what the retry will save.
    expect(findRun(frame, "why is this red?")).toBeDefined();
  });

  test("stays one row tall — a pin comment is single-line by design", async () => {
    const handle = await createHeadlessRenderer({ w: 48, h: 6 });
    open = handle;
    handle.mount(<PinInputPopup id="pin-input" focused bridge={bridgeWith("first\nsecond")} />);
    await handle.render();
    const frame = handle.capture();
    // `TextEditorHandle.setText` writes straight into the edit buffer via
    // `EditBufferRenderable.setText`, bypassing the newline-stripping `InputRenderable.insertText`/
    // `handlePaste`/the `value` setter apply to typed or pasted input — so the embedded `\n`
    // survives in the buffer. What proves single-line-ness here instead is the render: the
    // component pins the editor row's height to 1 whenever `multiline={false}` (see
    // `TextEditor`'s `height={props.multiline ? props.rows : 1}`), so only ONE of the two logical
    // lines is ever visible — never both joined onto one row.
    //
    // MEASURED (Task 11's `setText`-moves-cursor-to-the-end fix, `TextEditor.tsx`'s
    // `createHandle`): `setText` now also sets `cursorOffset` to the seed's own length, landing the
    // cursor on "second" — and the single visible row follows the cursor the same way any text
    // input's viewport does, so "second" is what actually renders and "first" is what's clipped.
    // This scenario (an embedded newline in an externally-seeded value) has no production path —
    // `setPinInput`'s only two call sites both pass `""` — so which line wins is not a behaviour
    // this popup's real users can ever observe either way; what this test still pins is that
    // exactly one line renders, never both.
    expect(findRun(frame, "second")).toBeDefined();
    expect(findRun(frame, "first")).toBeUndefined();
  });
});
