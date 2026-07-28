import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer, renderNodeOnce } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { themeTokens } from "../model/tokens";
import { Panel } from "./panel";
import { Text } from "./text";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();

describe("Panel bordered container (design-system §3.2)", () => {
  test("draws its title into the border in the foreground hue", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 5 });
    open = handle;
    handle.mount(
      <Panel id="p" title="Info">
        <Text id="body">body</Text>
      </Panel>,
    );
    await handle.render();
    const title = allRuns(handle.capture()).find((run) => run.text.includes("Info"));
    expect(title && extractRgb(title.fg)).toBe<string>(themeTokens("dark-default").foreground);
  });

  test("draws a border in the theme's border hue and wraps its child", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 5 });
    open = handle;
    handle.mount(
      <Panel id="p" title="Info">
        <Text id="body">body</Text>
      </Panel>,
    );
    await handle.render();
    const runs = allRuns(handle.capture());
    const border = runs.find(
      (run) => (run.fg as { rgb?: string }).rgb === themeTokens("dark-default").border,
    );
    expect(border).toBeDefined();
    expect(runs.some((run) => run.text.includes("body"))).toBe(true);
  });

  test("renders the design's rounded frame with a space-padded title", async () => {
    const frame = await renderNodeOnce(
      <Panel id="p" title="Часы">
        <Text id="body">x</Text>
      </Panel>,
      { w: 20, h: 4 },
    );
    const top = frame.rows[0]?.map((run) => run.text).join("") ?? "";
    // design/termcraft-engine.js:47,52 — rounded corners; title at x+2 as ' '+title+' '.
    expect(top.startsWith("╭─ Часы ")).toBe(true);
    expect(top.endsWith("╮")).toBe(true);
  });
});
