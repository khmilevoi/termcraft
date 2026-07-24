import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { TrustPrompt } from "./TrustPrompt";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const FOLDER = "/home/user/my-project";

describe("TrustPrompt component (design spec §3.1)", () => {
  test("renders the 'trust' box title in amberHi", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 10 });
    open = handle;
    handle.mount(<TrustPrompt id="trust" folder={FOLDER} />);
    await handle.render();
    const title = findRun(handle.capture(), "trust");
    expect(title).toBeDefined();
    expect(title && extractRgb(title.fg)).toBe<string>(SHELL_PALETTE.amberHi);
  });

  test("renders the 'trust this folder?' line in amberHi bold", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 10 });
    open = handle;
    handle.mount(<TrustPrompt id="trust" folder={FOLDER} />);
    await handle.render();
    const run = findRun(handle.capture(), "trust this folder?");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });

  test("renders the folder path in the dim hue", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 10 });
    open = handle;
    handle.mount(<TrustPrompt id="trust" folder={FOLDER} />);
    await handle.render();
    const run = findRun(handle.capture(), FOLDER);
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.dim);
  });

  test("renders the trust affordance '⏎ trust' in green bold", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 10 });
    open = handle;
    handle.mount(<TrustPrompt id="trust" folder={FOLDER} />);
    await handle.render();
    const run = findRun(handle.capture(), "⏎ trust");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.green);
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });

  test("renders the read-only affordance 'esc read-only' in red bold", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 10 });
    open = handle;
    handle.mount(<TrustPrompt id="trust" folder={FOLDER} />);
    await handle.render();
    const run = findRun(handle.capture(), "esc read-only");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.red);
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });
});
