import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import type { EditorBridge } from "ui/text-input";
import { SHELL_PALETTE } from "ui/theme";

import { Composer } from "./Composer";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame).find((run) => run.text.includes(needle));

/** A bridge shaped like the real one: seeds from a caller-owned string, records projections. */
const bridgeWith = (seed: string, sink?: (text: string) => void): EditorBridge => ({
  attach: (handle) => {
    if (handle !== null) handle.setText(seed);
  },
  mirror: (text) => sink?.(text),
});

const composerProps = {
  id: "composer",
  modelChip: "claude · sonnet-4.5",
  ctx: null,
  placeholder: "Ask for changes…",
  focused: true,
  rows: 1,
  width: 40,
} as const;

describe("Composer component (design chatSeq composer block)", () => {
  test("the model chip renders amberHi bold", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(<Composer {...composerProps} bridge={bridgeWith("")} />);
    await handle.render();
    const chip = findRun(handle.capture(), "claude · sonnet-4.5");
    expect(chip).toBeDefined();
    expect(chip && extractRgb(chip.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect((chip?.attrs ?? 0) & 1).toBe(1);
  });

  test("ctx is hidden when null", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(<Composer {...composerProps} bridge={bridgeWith("")} />);
    await handle.render();
    expect(findRun(handle.capture(), "ctx")).toBeUndefined();
  });

  test("ctx renders as 'ctx NN%' when set", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(<Composer {...composerProps} ctx={42} bridge={bridgeWith("")} />);
    await handle.render();
    const frame = handle.capture();
    const rowText = frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");
    expect(rowText).toContain("ctx");
    expect(rowText).toContain("42%");
  });

  test("ctxCaution flips the ctx value to amberHi bold", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(<Composer {...composerProps} ctx={87} ctxCaution bridge={bridgeWith("")} />);
    await handle.render();
    const value = findRun(handle.capture(), "87%");
    expect(value).toBeDefined();
    expect(value && extractRgb(value.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect((value?.attrs ?? 0) & 1).toBe(1);
  });

  test("ctx without caution renders the plain fg hue, not bold", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(<Composer {...composerProps} ctx={42} bridge={bridgeWith("")} />);
    await handle.render();
    const value = findRun(handle.capture(), "42%");
    expect(value && extractRgb(value.fg)).toBe<string>(SHELL_PALETTE.fg);
  });

  test("disabled hides the cursor and dims the caret to faint", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        {...composerProps}
        disabled
        placeholder="generating… esc to cancel"
        bridge={bridgeWith("")}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "█")).toBeUndefined();
    const caret = findRun(frame, "❯");
    expect(caret).toBeDefined();
    expect(caret && extractRgb(caret.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("an enabled composer shows the amber caret", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(<Composer {...composerProps} bridge={bridgeWith("")} />);
    await handle.render();
    const frame = handle.capture();
    const caret = findRun(frame, "❯");
    expect(caret).toBeDefined();
    expect(caret && extractRgb(caret.fg)).toBe<string>(SHELL_PALETTE.amber);
    // WAS also an assertion for a painted "█" cursor run (pre-`TextEditor` `Composer`). The
    // cursor is now `TextEditor`'s native terminal cursor — never a painted glyph
    // (`ui/text-input`'s own `TextEditor.test.tsx`, "paints the cursor while focused and
    // showCursor is true": "the cursor is the TERMINAL's own hardware cursor... it cannot be
    // read out of `captureCharFrame()`" — the same is true of this file's `handle.capture()`).
    // Its visibility is `TextEditor`'s own test's job, not this one's.
  });

  test("a non-empty value shows the value, not the placeholder", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(<Composer {...composerProps} bridge={bridgeWith("add a gauge")} />);
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "add a gauge")).toBeDefined();
    expect(findRun(frame, "Ask for changes…")).toBeUndefined();
    const value = findRun(frame, "add a gauge");
    expect(value && extractRgb(value.fg)).toBe<string>(SHELL_PALETTE.fg);
  });

  // WAS "...cursor overlapping its first cell" (finding §2.6, phase-8 Task 18), pinning the
  // prior single-line editor's manual `text`-then-`put`-at-the-same-column overlap: the
  // placeholder's first character rendered as a SEPARATE cursor run, the rest as a second run.
  // `TextEditor`, its 2026-08-03 replacement, draws the placeholder as ONE uninterrupted run and
  // overlays the terminal's own native cursor on top of it (`ui/text-input`'s own
  // `TextEditor.test.tsx`, "draws the caret run and the placeholder
  // while empty" — the captured text is the whole, un-split placeholder) — nothing here to split,
  // and the cursor itself is unassertable through `handle.capture()` for the reason the previous
  // test's comment gives.
  test("an empty value shows the placeholder in faint", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(<Composer {...composerProps} bridge={bridgeWith("")} />);
    await handle.render();
    const frame = handle.capture();
    const placeholder = findRun(frame, "Ask for changes…");
    expect(placeholder).toBeDefined();
    expect(placeholder && extractRgb(placeholder.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("an attach line renders above the input in its given token color", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        {...composerProps}
        bridge={bridgeWith("")}
        attach={{ text: "2 open pins attached · sent next", fg: "amberHi" }}
      />,
    );
    await handle.render();
    const attach = findRun(handle.capture(), "2 open pins attached");
    expect(attach).toBeDefined();
    expect(attach && extractRgb(attach.fg)).toBe<string>(SHELL_PALETTE.amberHi);
  });

  test("renders the seeded draft in the foreground hue", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 4 });
    open = handle;
    handle.mount(<Composer {...composerProps} bridge={bridgeWith("fix the gauge")} />);
    await handle.render();
    const run = findRun(handle.capture(), "fix the gauge");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.fg);
  });

  test("renders a multi-row draft across the rows it was given", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 6 });
    open = handle;
    handle.mount(
      <Composer {...composerProps} rows={3} bridge={bridgeWith("first line\nsecond line")} />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "first line")).toBeDefined();
    expect(findRun(frame, "second line")).toBeDefined();
  });
});
