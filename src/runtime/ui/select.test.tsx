import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { themeTokens } from "../model/tokens";
import { Select } from "./select";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  // A host-input atom, so a leaked "export" would silently change every later test's frame.
  hostModeAtom.set("preview");
});

const T = themeTokens("dark-default");
const lineRuns = (frame: { rows: StyledRun[][] }, row: number): StyledRun[] =>
  frame.rows[row] ?? [];
const runWith = (frame: { rows: StyledRun[][] }, row: number, needle: string) =>
  lineRuns(frame, row).find((run) => run.text.includes(needle));

const ITEMS = [
  { id: "a", label: "alpha" },
  { id: "b", label: "bravo" },
  { id: "c", label: "charlie" },
];

describe("Select component (spec §6.1)", () => {
  test("renders every item label on its own row", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="a" />);
    await handle.render();
    const frame = handle.capture();
    expect(runWith(frame, 0, "alpha")).toBeDefined();
    expect(runWith(frame, 1, "bravo")).toBeDefined();
    expect(runWith(frame, 2, "charlie")).toBeDefined();
  });

  test("the selected row follows the design's selection recipe", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="b" />);
    await handle.render();
    const selected = runWith(handle.capture(), 1, "bravo");
    expect(selected && extractRgb(selected.fg)).toBe<string>(T.selectionFg);
    expect(selected && extractRgb(selected.bg)).toBe<string>(T.selection);
  });

  test("an unselected row uses the foreground hue over the background fill", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="b" />);
    await handle.render();
    const other = runWith(handle.capture(), 0, "alpha");
    expect(other && extractRgb(other.fg)).toBe<string>(T.foreground);
    expect(other && extractRgb(other.bg)).toBe<string>(T.background);
  });

  test("a focused Select lifts its body onto the surface token (preview)", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="b" focused />);
    await handle.render();
    const other = runWith(handle.capture(), 0, "alpha");
    expect(other && extractRgb(other.bg)).toBe<string>(T.surface);
  });
});

// §6.3: an interactive widget must render a DEFINED STATIC STATE under export. Asserted, not
// noted — a focus lift and a cursor that follows keys are exactly what makes a snapshot vary.
describe("Select export determinism (spec §6.3)", () => {
  // These tests exercise the forced `blur()` half of D3's "nothing focused" guarantee only
  // (`focused={false}` under export). The second half — the focused fill collapsing onto the
  // unfocused one in `select.tsx` — is unasserted defence-in-depth: because the widget is
  // blurred, `focusedBackgroundColor` is never read, so these tests would stay green even if
  // that collapse were deleted. Do not remove the collapse on the strength of these passing.
  test("under export nothing is focused: the body never lifts, even with `focused`", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="b" focused />);
    await handle.render();
    const other = runWith(handle.capture(), 0, "alpha");
    expect(other && extractRgb(other.bg)).toBe<string>(T.background);
    expect(other && extractRgb(other.bg)).not.toBe<string>(T.surface);
  });

  test("under export the selection is the prop's, on a re-render as much as on the first", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="a" />);
    await handle.render();
    const first = runWith(handle.capture(), 0, "alpha");
    expect(first && extractRgb(first.bg)).toBe<string>(T.selection);

    handle.mount(<Select id="agent" items={ITEMS} selectedId="c" />);
    await handle.render();
    const frame = handle.capture();
    const moved = runWith(frame, 2, "charlie");
    const vacated = runWith(frame, 0, "alpha");
    expect(moved && extractRgb(moved.bg)).toBe<string>(T.selection);
    expect(vacated && extractRgb(vacated.bg)).toBe<string>(T.background);
  });
});
