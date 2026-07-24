import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
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

describe("Composer component (design chatSeq composer block)", () => {
  test("the model chip renders amberHi bold", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        id="composer"
        modelChip="claude · sonnet-4.5"
        ctx={null}
        placeholder="Ask for changes…"
        value=""
      />,
    );
    await handle.render();
    const chip = findRun(handle.capture(), "claude · sonnet-4.5");
    expect(chip).toBeDefined();
    expect(chip && extractRgb(chip.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect((chip?.attrs ?? 0) & 1).toBe(1);
  });

  test("ctx is hidden when null", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        id="composer"
        modelChip="claude · sonnet-4.5"
        ctx={null}
        placeholder="Ask for changes…"
        value=""
      />,
    );
    await handle.render();
    expect(findRun(handle.capture(), "ctx")).toBeUndefined();
  });

  test("ctx renders as 'ctx NN%' when set", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        id="composer"
        modelChip="claude · sonnet-4.5"
        ctx={42}
        placeholder="Ask for changes…"
        value=""
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const rowText = frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");
    expect(rowText).toContain("ctx");
    expect(rowText).toContain("42%");
  });

  test("ctxCaution flips the ctx value to amberHi bold", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        id="composer"
        modelChip="claude · sonnet-4.5"
        ctx={87}
        ctxCaution
        placeholder="Ask for changes…"
        value=""
      />,
    );
    await handle.render();
    const value = findRun(handle.capture(), "87%");
    expect(value).toBeDefined();
    expect(value && extractRgb(value.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect((value?.attrs ?? 0) & 1).toBe(1);
  });

  test("ctx without caution renders the plain fg hue, not bold", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        id="composer"
        modelChip="claude · sonnet-4.5"
        ctx={42}
        placeholder="Ask for changes…"
        value=""
      />,
    );
    await handle.render();
    const value = findRun(handle.capture(), "42%");
    expect(value && extractRgb(value.fg)).toBe<string>(SHELL_PALETTE.fg);
  });

  test("disabled hides the cursor and dims the caret to faint", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        id="composer"
        modelChip="claude · sonnet-4.5"
        ctx={null}
        disabled
        placeholder="generating… esc to cancel"
        value=""
      />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "█")).toBeUndefined();
    const caret = findRun(frame, "❯");
    expect(caret).toBeDefined();
    expect(caret && extractRgb(caret.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("an enabled composer shows the amber caret and a blinking cursor", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        id="composer"
        modelChip="claude · sonnet-4.5"
        ctx={null}
        placeholder="Ask for changes…"
        value=""
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const caret = findRun(frame, "❯");
    expect(caret).toBeDefined();
    expect(caret && extractRgb(caret.fg)).toBe<string>(SHELL_PALETTE.amber);
    // Note: BLINK has no protocol mask bit (host/render/model/attributes.ts's
    // `attributesToMask` comment), so the cursor's blink attribute cannot be
    // asserted through `run.attrs` here — only its presence and color.
    const cursor = findRun(frame, "█");
    expect(cursor).toBeDefined();
    expect(cursor && extractRgb(cursor.fg)).toBe<string>(SHELL_PALETTE.amber);
  });

  test("a non-empty value shows the value, not the placeholder", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        id="composer"
        modelChip="claude · sonnet-4.5"
        ctx={null}
        placeholder="Ask for changes…"
        value="add a gauge"
      />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "add a gauge")).toBeDefined();
    expect(findRun(frame, "Ask for changes…")).toBeUndefined();
    const value = findRun(frame, "add a gauge");
    expect(value && extractRgb(value.fg)).toBe<string>(SHELL_PALETTE.fg);
  });

  test("an empty value shows the placeholder in faint", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        id="composer"
        modelChip="claude · sonnet-4.5"
        ctx={null}
        placeholder="Ask for changes…"
        value=""
      />,
    );
    await handle.render();
    const placeholder = findRun(handle.capture(), "Ask for changes…");
    expect(placeholder).toBeDefined();
    expect(placeholder && extractRgb(placeholder.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("an attach line renders above the input in its given token color", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 3 });
    open = handle;
    handle.mount(
      <Composer
        id="composer"
        modelChip="claude · sonnet-4.5"
        ctx={null}
        placeholder="Ask for changes…"
        value=""
        attach={{ text: "2 open pins attached · sent next", fg: "amberHi" }}
      />,
    );
    await handle.render();
    const attach = findRun(handle.capture(), "2 open pins attached");
    expect(attach).toBeDefined();
    expect(attach && extractRgb(attach.fg)).toBe<string>(SHELL_PALETTE.amberHi);
  });
});
