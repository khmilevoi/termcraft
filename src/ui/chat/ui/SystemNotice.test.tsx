import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { SystemNotice } from "./SystemNotice";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const HEADLINE = "✗ preview crashed while rendering — halted after 3 restarts";
const DETAIL = "the design passed Gate; the host died running it";

describe("SystemNotice (design wsHostCrash's chatSeq system entries)", () => {
  test("paints the headline red and the detail faint", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 6 });
    open = handle;
    handle.mount(<SystemNotice id="notice" headline={HEADLINE} detail={DETAIL} />);
    await handle.render();
    const frame = handle.capture();

    const headline = findRun(frame, "preview crashed while rendering");
    expect(headline).toBeDefined();
    expect(headline && extractRgb(headline.fg)).toBe<string>(SHELL_PALETTE.red);

    const detail = findRun(frame, DETAIL);
    expect(detail).toBeDefined();
    expect(detail && extractRgb(detail.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("draws no border, role header or timestamp — it is not a persisted record", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 6 });
    open = handle;
    handle.mount(<SystemNotice id="notice" headline={HEADLINE} detail={DETAIL} />);
    await handle.render();
    const text = handle
      .capture()
      .rows.flat()
      .map((run) => run.text)
      .join("");
    expect(text).not.toContain("─");
    expect(text).not.toContain("❯");
    expect(text).not.toContain("●");
  });
});
