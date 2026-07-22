import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { ErrorPanel } from "./ErrorPanel";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const HEADLINE = "could not render current design";
const CAUSE = 'pages/main/page.tsx — Gate: unknown widget "GpuPanel"';
const NEXT_STEP = "fix it in a repair turn — the composer stays open";
const RESTORE_HINT = "⏎ Restore… a working commit";

describe("ErrorPanel component (design wsBrokenSource)", () => {
  test("renders the headline with a leading red bold ✗", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 12 });
    open = handle;
    handle.mount(
      <ErrorPanel
        id="err"
        width={60}
        height={12}
        headline={HEADLINE}
        cause={CAUSE}
        nextStep={NEXT_STEP}
      />,
    );
    await handle.render();
    const run = findRun(handle.capture(), `✗ ${HEADLINE}`);
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.red);
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });

  test("renders the cause in the foreground hue, not bold", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 12 });
    open = handle;
    handle.mount(
      <ErrorPanel
        id="err"
        width={60}
        height={12}
        headline={HEADLINE}
        cause={CAUSE}
        nextStep={NEXT_STEP}
      />,
    );
    await handle.render();
    const run = findRun(handle.capture(), CAUSE);
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.fg);
    expect((run?.attrs ?? 0) & 1).toBe(0);
  });

  test("renders the next step in the faint hue", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 12 });
    open = handle;
    handle.mount(
      <ErrorPanel
        id="err"
        width={60}
        height={12}
        headline={HEADLINE}
        cause={CAUSE}
        nextStep={NEXT_STEP}
      />,
    );
    await handle.render();
    const run = findRun(handle.capture(), NEXT_STEP);
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("renders the restore inset with its titled amber border when restoreHint is provided", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 14 });
    open = handle;
    handle.mount(
      <ErrorPanel
        id="err"
        width={60}
        height={14}
        headline={HEADLINE}
        cause={CAUSE}
        nextStep={NEXT_STEP}
        restoreHint={RESTORE_HINT}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    const title = findRun(frame, "restore (v1)");
    expect(title).toBeDefined();
    expect(title && extractRgb(title.fg)).toBe<string>(SHELL_PALETTE.amberHi);

    const hint = findRun(frame, RESTORE_HINT);
    expect(hint).toBeDefined();
    expect(hint && extractRgb(hint.fg)).toBe<string>(SHELL_PALETTE.amberHi);
  });

  test("omits the restore inset when restoreHint is null", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 14 });
    open = handle;
    handle.mount(
      <ErrorPanel
        id="err"
        width={60}
        height={14}
        headline={HEADLINE}
        cause={CAUSE}
        nextStep={NEXT_STEP}
        restoreHint={null}
      />,
    );
    await handle.render();
    expect(findRun(handle.capture(), "restore (v1)")).toBeUndefined();
  });

  test("omits the restore inset when restoreHint is absent", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 14 });
    open = handle;
    handle.mount(
      <ErrorPanel
        id="err"
        width={60}
        height={14}
        headline={HEADLINE}
        cause={CAUSE}
        nextStep={NEXT_STEP}
      />,
    );
    await handle.render();
    expect(findRun(handle.capture(), "restore (v1)")).toBeUndefined();
  });
});
