import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { themeTokens } from "../model/tokens";
import { Tabs } from "./tabs";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame).find((run) => run.text.includes(needle));

const TABS = [
  { id: "files", label: "Files" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
] as const;

describe("Tabs component (design-system §3.2)", () => {
  test("renders every tab label", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 1 });
    open = handle;
    handle.mount(<Tabs id="menu" tabs={TABS} activeId="edit" />);
    await handle.render();
    const frame = handle.capture();
    for (const tab of TABS) expect(findRun(frame, tab.label)?.text).toContain(tab.label);
  });

  test("the active tab label carries the accent hue and the bold attr", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 1 });
    open = handle;
    handle.mount(<Tabs id="menu" tabs={TABS} activeId="edit" />);
    await handle.render();
    const active = findRun(handle.capture(), "Edit");
    expect((active?.fg as { rgb: string }).rgb).toBe(themeTokens("dark-default").accent);
    expect((active?.attrs ?? 0) & 0b1).toBe(0b1);
  });

  test("an inactive tab label is muted and not bold", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 1 });
    open = handle;
    handle.mount(<Tabs id="menu" tabs={TABS} activeId="edit" />);
    await handle.render();
    const inactive = findRun(handle.capture(), "Files");
    expect((inactive?.fg as { rgb: string }).rgb).toBe(themeTokens("dark-default").foregroundMuted);
    expect((inactive?.attrs ?? 0) & 0b1).toBe(0);
  });
});
