import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { StatusBar } from "./StatusBar";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const lineRuns = (frame: { rows: StyledRun[][] }, row: number): StyledRun[] =>
  frame.rows[row] ?? [];
const lineText = (frame: { rows: StyledRun[][] }, row: number) =>
  lineRuns(frame, row)
    .map((run) => run.text)
    .join("");
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  lineRuns(frame, 0).find((run) => run.text.includes(needle));

describe("StatusBar component (design statusBar/wsStatus)", () => {
  test("renders the full left cluster in canonical order with the design hexes", async () => {
    const handle = await createHeadlessRenderer({ w: 120, h: 1 });
    open = handle;
    handle.mount(
      <StatusBar
        id="status"
        width={120}
        mode={{ text: "STATIC", fg: "amberHi", bg: "line" }}
        page={{ text: "main", fg: "dim" }}
        size={{ w: 80, h: 24 }}
        hint={{ text: "git off", fg: "amberHi", bg: "line" }}
        ctx={55}
        hintKeys={[
          ["F2", "fullscreen"],
          ["F3", "tweaks"],
        ]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    // Adjacent segments sharing one style (fg/bg/bold) coalesce into a single styled
    // run (host/render/model/span-rows.ts), so segment order is asserted against the
    // concatenated row text, not distinct run identities.
    const text = lineText(frame, 0);
    let cursor = -1;
    for (const needle of ["STATIC", "main", "80×24", "git off", "ctx 55%", "F2"]) {
      const idx = text.indexOf(needle, cursor + 1);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }

    const mode = findRun(frame, "STATIC");
    expect(mode && extractRgb(mode.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect(mode && extractRgb(mode.bg)).toBe<string>(SHELL_PALETTE.line);
    expect((mode?.attrs ?? 0) & 1).toBe(1);

    const page = findRun(frame, "main");
    expect(page && extractRgb(page.fg)).toBe<string>(SHELL_PALETTE.dim);

    const size = findRun(frame, "80×24");
    expect(size && extractRgb(size.fg)).toBe<string>(SHELL_PALETTE.dim);

    const hint = findRun(frame, "git off");
    expect(hint && extractRgb(hint.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect(hint && extractRgb(hint.bg)).toBe<string>(SHELL_PALETTE.line);
  });

  test("a below-minimum size segment renders red-on-bg (design sizeErr)", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 1 });
    open = handle;
    handle.mount(
      <StatusBar
        id="status"
        width={60}
        mode={{ text: "FULLSCREEN", fg: "bg", bg: "amber" }}
        size={{ w: 78, h: 22, min: { w: 80, h: 24 } }}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const size = findRun(frame, "78×22 < 80×24");
    expect(size).toBeDefined();
    expect(size && extractRgb(size.fg)).toBe<string>(SHELL_PALETTE.bg);
    expect(size && extractRgb(size.bg)).toBe<string>(SHELL_PALETTE.red);
    expect((size?.attrs ?? 0) & 1).toBe(1);
  });

  test("ctx% is hidden under 100 cols unless caution forces it", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 1 });
    open = handle;
    handle.mount(
      <StatusBar
        id="status"
        width={80}
        mode={{ text: "STATIC", fg: "amberHi", bg: "line" }}
        ctx={42}
      />,
    );
    await handle.render();
    expect(findRun(handle.capture(), "ctx 42%")).toBeUndefined();
  });

  test("ctxCaution shows ctx% under 100 cols and flips it to amberHi", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 1 });
    open = handle;
    handle.mount(
      <StatusBar
        id="status"
        width={80}
        mode={{ text: "STATIC", fg: "amberHi", bg: "line" }}
        ctx={85}
        ctxCaution
      />,
    );
    await handle.render();
    const ctx = findRun(handle.capture(), "ctx 85%");
    expect(ctx).toBeDefined();
    expect(ctx && extractRgb(ctx.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect((ctx?.attrs ?? 0) & 1).toBe(1);
  });

  test("ctx% at width>=100 without caution renders in the faint hue, not bold", async () => {
    const handle = await createHeadlessRenderer({ w: 120, h: 1 });
    open = handle;
    handle.mount(
      <StatusBar
        id="status"
        width={120}
        mode={{ text: "STATIC", fg: "amberHi", bg: "line" }}
        ctx={42}
      />,
    );
    await handle.render();
    const ctx = findRun(handle.capture(), "ctx 42%");
    expect(ctx && extractRgb(ctx.fg)).toBe<string>(SHELL_PALETTE.faint);
    expect((ctx?.attrs ?? 0) & 1).toBe(0);
  });

  test.each([
    ["^E", "export"],
    ["m", "model"],
    ["/", "cmd"],
  ])("hint key glyph %s is always filtered out", async (glyph, label) => {
    const handle = await createHeadlessRenderer({ w: 60, h: 1 });
    open = handle;
    handle.mount(
      <StatusBar
        id="status"
        width={60}
        mode={{ text: "STATIC", fg: "amberHi", bg: "line" }}
        hintKeys={[
          [glyph, label],
          ["F2", "fullscreen"],
        ]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, label)).toBeUndefined();
    expect(findRun(frame, "F2")).toBeDefined();
  });

  test("a plain hint key list renders its glyph", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 1 });
    open = handle;
    handle.mount(
      <StatusBar
        id="status"
        width={60}
        mode={{ text: "STATIC", fg: "amberHi", bg: "line" }}
        hintKeys={[["F2", "fullscreen"]]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const glyph = findRun(frame, "F2");
    expect(glyph).toBeDefined();
    expect(glyph && extractRgb(glyph.fg)).toBe<string>(SHELL_PALETTE.amber);
    expect(findRun(frame, "fullscreen")).toBeDefined();
  });

  test("hint keys are trimmed to fit, keeping at least one", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 1 });
    open = handle;
    handle.mount(
      <StatusBar
        id="status"
        width={40}
        mode={{ text: "STATIC", fg: "amberHi", bg: "line" }}
        page={{ text: "a very long page label indeed", fg: "dim" }}
        hintKeys={[
          ["F2", "fullscreen"],
          ["F3", "tweaks"],
          ["F4", "interact"],
        ]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "F2")).toBeDefined();
    expect(findRun(frame, "F4")).toBeUndefined();
  });
});
