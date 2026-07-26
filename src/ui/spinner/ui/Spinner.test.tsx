import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { ELAPSED_INTERVAL_MS } from "../model/elapsed";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "../model/frames";
import { Spinner } from "./Spinner";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const glyphOf = (frame: { rows: StyledRun[][] }, label: string): string => {
  const run = findRun(frame, label);
  if (run === undefined) throw new Error("fixture bug: no spinner line rendered");
  return run.text.trimStart().slice(0, 1);
};

describe("Spinner (the one shared animated spinner)", () => {
  test("advances its glyph over time — the animation actually runs", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 4 });
    open = handle;
    handle.mount(<Spinner id="spin" label="working…" fg={SHELL_PALETTE.amber} bold />);
    await handle.render();

    const first = glyphOf(handle.capture(), "working…");
    expect(SPINNER_FRAMES).toContain(first);

    // Long enough to cross several ticks, so this cannot pass by landing on the same frame
    // again: the cycle has 10 frames and this waits ~4 of them.
    await new Promise((resolve) => setTimeout(resolve, SPINNER_INTERVAL_MS * 4));
    await handle.render();

    const later = glyphOf(handle.capture(), "working…");
    expect(SPINNER_FRAMES).toContain(later);
    // Without the connect-hook ticker this is the SAME glyph forever — which is exactly the
    // static-spinner bug this component exists to fix.
    expect(later).not.toBe(first);
  });

  test("keeps the caller's design-sourced colour and weight rather than defaulting its own", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 4 });
    open = handle;
    handle.mount(<Spinner id="spin" label="working…" fg={SHELL_PALETTE.amber} bold />);
    await handle.render();

    const run = findRun(handle.capture(), "working…");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amber);
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });

  test("renders no elapsed segment when startedAt is absent (design's plain `⠹ generating…` frame)", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 4 });
    open = handle;
    handle.mount(<Spinner id="spin" label="generating design…" fg={SHELL_PALETTE.amber} bold />);
    await handle.render();

    const run = findRun(handle.capture(), "generating design…");
    expect(run).toBeDefined();
    expect(run?.text).not.toContain("·");
  });

  test("appends and advances a ` · <elapsed>` segment once startedAt is provided (design's `· 2m 40s` shape)", async () => {
    const startedAt = Date.now();
    const handle = await createHeadlessRenderer({ w: 60, h: 4 });
    open = handle;
    handle.mount(
      <Spinner
        id="spin"
        label="generating design…"
        fg={SHELL_PALETTE.amber}
        bold
        startedAt={startedAt}
      />,
    );
    await handle.render();

    const first = findRun(handle.capture(), "generating design…");
    expect(first).toBeDefined();
    expect(first?.text).toContain("·");

    // Long enough to cross a full elapsed tick, so the suffix must have advanced.
    await new Promise((resolve) => setTimeout(resolve, ELAPSED_INTERVAL_MS + 250));
    await handle.render();

    const later = findRun(handle.capture(), "generating design…");
    expect(later?.text).toContain("·");
    expect(later?.text).not.toBe(first?.text);
  });
});
