import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { themeTokens } from "../model/tokens";
import { Textarea } from "./textarea";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const T = themeTokens("dark-default");
const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame).find((run) => run.text.includes(needle));
const allText = (frame: { rows: StyledRun[][] }) =>
  allRuns(frame)
    .map((run) => run.text)
    .join("");

describe("Textarea component (spec §6.1)", () => {
  test("paints its value in the foreground token", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(<Textarea id="note" value="alpha" height={3} />);
    await handle.render();
    const run = findRun(handle.capture(), "alpha");
    expect(run?.text).toContain("alpha");
    expect(run && extractRgb(run.fg)).toBe<string>(T.foreground);
  });

  test("paints the placeholder in the faint token when the value is empty", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(<Textarea id="note" placeholder="type here" height={3} />);
    await handle.render();
    const run = findRun(handle.capture(), "type here");
    expect(run?.text).toContain("type here");
    expect(run && extractRgb(run.fg)).toBe<string>(T.foregroundFaint);
  });

  test("a focused Textarea lifts its body onto the surface token (preview)", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(<Textarea id="note" value="alpha" height={3} focused />);
    await handle.render();
    const run = findRun(handle.capture(), "alpha");
    expect(run && extractRgb(run.bg)).toBe<string>(T.surface);
  });

  test("mounts and renders a frame with both handlers attached (no hang on teardown)", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(
      <Textarea id="note" value="alpha" height={3} onChange={() => {}} onSubmit={() => {}} />,
    );
    await handle.render();
    expect(handle.renderError()).toBeNull();
    expect(handle.capture().rows.length).toBeGreaterThan(0);
  });
});

// §6.3. The load-bearing one is the SECOND test: OpenTUI's `initialValue` is a one-shot latch,
// so without the export remount key a snapshot would keep painting whatever text the instance
// happened to be created with — the exact "internal state instead of props" §6.3 forbids.
describe("Textarea export determinism (spec §6.3)", () => {
  // These tests exercise the forced `blur()` half of D3's "nothing focused" guarantee only
  // (`focused={false}` under export). The second half — the focused fill collapsing onto the
  // unfocused one in `textarea.tsx` — is unasserted defence-in-depth: because the widget is
  // blurred, `focusedBackgroundColor` is never read, so these tests would stay green even if
  // that collapse were deleted. Do not remove the collapse on the strength of these passing.
  test("under export nothing is focused: the body never lifts, even with `focused`", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(<Textarea id="note" value="alpha" height={3} focused />);
    await handle.render();
    const run = findRun(handle.capture(), "alpha");
    expect(run && extractRgb(run.bg)).toBe<string>(T.background);
    expect(run && extractRgb(run.bg)).not.toBe<string>(T.surface);
  });

  test("under export the rendered text is the prop's on EVERY render, not only the first", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(<Textarea id="note" value="alpha" height={3} />);
    await handle.render();
    expect(allText(handle.capture())).toContain("alpha");

    handle.mount(<Textarea id="note" value="bravo" height={3} />);
    await handle.render();
    const frame = handle.capture();
    expect(allText(frame)).toContain("bravo");
    expect(allText(frame)).not.toContain("alpha");
  });
});
