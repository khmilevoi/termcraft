import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import type { TextInputProps } from "../types";
import { TextInput } from "./TextInput";

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

const frameContains = (frame: Frame, needle: string): boolean =>
  findRun(frame, needle) !== undefined;

const STYLE = {
  caret: "❯ ",
  caretFg: SHELL_PALETTE.amber,
  valueFg: SHELL_PALETTE.fg,
  placeholderFg: SHELL_PALETTE.faint,
} as const;

const baseProps: TextInputProps = {
  id: "t",
  value: "",
  placeholder: "…",
  showCursor: true,
  ...STYLE,
};

/** Renders `TextInput` with `baseProps` plus overrides and returns the captured frame. */
async function renderInput(overrides: Partial<TextInputProps> = {}): Promise<Frame> {
  const props: TextInputProps = { ...baseProps, ...overrides };
  const handle = await createHeadlessRenderer({ w: 60, h: 3 });
  open = handle;
  handle.mount(<TextInput {...props} />);
  await handle.render();
  return handle.capture();
}

/**
 * `RenderHandle`'s id-addressable geometry API (`rectOf`/`describe`/`layoutTree`) deliberately
 * carries no text — `host/render/types.ts`'s own doc comments mark that a documented gap, not an
 * oversight (the protocol boundary between "styled rows" and "id geometry" never mixes the two;
 * `layoutTree`'s nodes omit `text` for the identical reason `describe`'s `label` is unpopulated).
 * So these tests read runs the same way every other `ui` component test in this repo does —
 * `findRun`/row order over the captured frame (`Home.test.tsx`, `Composer.test.tsx`,
 * `ChatListPopup.test.tsx`) — rather than the brief's illustrative `textOf(frame, id)` /
 * `orderedIds(frame)`, which nothing in this codebase implements, and which would require
 * reaching past that documented boundary to build. The assertions below cover the identical
 * behaviour the brief's pseudocode named: the empty-and-focused overlap, the after-value cursor
 * position, and the no-cursor disabled state.
 */
describe("TextInput — the shared insertion-point primitive (finding §2.6)", () => {
  test("puts the cursor OVER the placeholder's first cell while empty (design home() :145-146)", async () => {
    const frame = await renderInput({
      value: "",
      placeholder: "Describe the TUI…",
      showCursor: true,
    });
    const row = frame.rows.flat();

    // The cursor glyph occupies its own run — the placeholder's first cell.
    const cursor = row.find((run) => run.text === "█");
    expect(cursor).toBeDefined();
    expect(cursor && extractRgb(cursor.fg)).toBe<string>(SHELL_PALETTE.amber);

    // The remainder follows it as a second run — NOT the placeholder's full text.
    const rest = row.find((run) => run.text === "escribe the TUI…");
    expect(rest).toBeDefined();
    expect(rest && extractRgb(rest.fg)).toBe<string>(SHELL_PALETTE.faint);

    // The old defect rendered the whole placeholder as one un-overlapped run, cursor appended
    // after it — that run must not exist any more.
    expect(frameContains(frame, "Describe the TUI…")).toBe(false);
  });

  test("puts the cursor after the last character once the input is not empty", async () => {
    const frame = await renderInput({ value: "abc", placeholder: "…", showCursor: true });
    const row = frame.rows.flat();
    const caretIndex = row.findIndex((run) => run.text === "❯ ");
    const valueIndex = row.findIndex((run) => run.text === "abc");
    const cursorIndex = row.findIndex((run) => run.text === "█");
    expect(caretIndex).toBeGreaterThanOrEqual(0);
    expect(valueIndex).toBeGreaterThan(caretIndex);
    expect(cursorIndex).toBeGreaterThan(valueIndex);
  });

  test("renders no cursor at all when showCursor is false (design's disabled composer, drawChat() :255)", async () => {
    const frame = await renderInput({
      value: "",
      placeholder: "generating… esc to cancel",
      showCursor: false,
    });
    expect(frameContains(frame, "█")).toBe(false);
    const placeholder = findRun(frame, "generating… esc to cancel");
    expect(placeholder).toBeDefined();
    expect(placeholder && extractRgb(placeholder.fg)).toBe<string>(SHELL_PALETTE.faint);
  });
});
