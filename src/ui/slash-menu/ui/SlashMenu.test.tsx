import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import type { ScoredSlashRow, SlashCommand } from "ui/actions";
import { SHELL_PALETTE } from "ui/theme";

import { SlashMenu } from "./SlashMenu";

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
const findRun = (frame: { rows: StyledRun[][] }, needle: string): StyledRun | undefined =>
  frame.rows.flat().find((run) => run.text.includes(needle));

/** Builds a `ScoredSlashRow` fixture without going through the real capability pipeline. */
function makeRow(
  command: Partial<SlashCommand> & Pick<SlashCommand, "cmd" | "desc" | "order">,
  state: Partial<ScoredSlashRow["state"]> = {},
): ScoredSlashRow {
  return {
    command: { capability: null, ...command },
    state: { visible: true, enabled: true, dimmed: false, hint: null, ...state },
  };
}

describe("SlashMenu component (design 23-slash-menu.dc.html, slashMenu/wsSlash)", () => {
  test("renders all provided rows in order", async () => {
    const rows = [
      makeRow({ cmd: "/new", desc: "start a new chat", order: 1 }),
      makeRow({ cmd: "/chats", desc: "switch or list chats", order: 2 }),
      makeRow({ cmd: "/export", desc: "write the export package", order: 3 }),
    ];
    const handle = await createHeadlessRenderer({ w: 48, h: 6 });
    open = handle;
    handle.mount(<SlashMenu id="slash" typed="/" rows={rows} selectedIndex={0} />);
    await handle.render();
    const frame = handle.capture();
    expect(lineText(frame, 1)).toContain("/new");
    expect(lineText(frame, 1)).toContain("start a new chat");
    expect(lineText(frame, 2)).toContain("/chats");
    expect(lineText(frame, 2)).toContain("switch or list chats");
    expect(lineText(frame, 3)).toContain("/export");
    expect(lineText(frame, 3)).toContain("write the export package");
  });

  test('title is "commands" when typed is exactly "/"', async () => {
    const rows = [makeRow({ cmd: "/new", desc: "start a new chat", order: 1 })];
    const handle = await createHeadlessRenderer({ w: 40, h: 4 });
    open = handle;
    handle.mount(<SlashMenu id="slash" typed="/" rows={rows} selectedIndex={0} />);
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("commands");
  });

  test("title is the typed text for a longer prefix", async () => {
    const rows = [makeRow({ cmd: "/chats", desc: "switch or list chats", order: 2 })];
    const handle = await createHeadlessRenderer({ w: 40, h: 4 });
    open = handle;
    handle.mount(<SlashMenu id="slash" typed="/ch" rows={rows} selectedIndex={0} />);
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("/ch");
  });

  test("a dimmed row's text uses the faint hex", async () => {
    const rows = [
      makeRow(
        { cmd: "/commit-infra", desc: "infrastructure · clean", order: 6, clean: true },
        { enabled: false, dimmed: true },
      ),
    ];
    const handle = await createHeadlessRenderer({ w: 40, h: 4 });
    open = handle;
    handle.mount(<SlashMenu id="slash" typed="/" rows={rows} selectedIndex={-1} />);
    await handle.render();
    const frame = handle.capture();
    const cmdRun = findRun(frame, "/commit-infra");
    const descRun = findRun(frame, "infrastructure");
    expect(cmdRun && extractRgb(cmdRun.fg)).toBe(SHELL_PALETTE.faint);
    expect(descRun && extractRgb(descRun.fg)).toBe(SHELL_PALETTE.faint);
  });

  test('the selected row shows the "▸" glyph and the sel background', async () => {
    const rows = [
      makeRow({ cmd: "/new", desc: "start a new chat", order: 1 }),
      makeRow({ cmd: "/chats", desc: "switch or list chats", order: 2 }),
    ];
    const handle = await createHeadlessRenderer({ w: 40, h: 5 });
    open = handle;
    handle.mount(<SlashMenu id="slash" typed="/" rows={rows} selectedIndex={1} />);
    await handle.render();
    const frame = handle.capture();
    expect(lineText(frame, 1)).not.toContain("▸");
    expect(lineText(frame, 2)).toContain("▸");
    const selectedMarker = findRun(frame, "▸");
    expect(selectedMarker && extractRgb(selectedMarker.bg)).toBe(SHELL_PALETTE.sel);
    const selectedCmd = findRun(frame, "/chats");
    expect(selectedCmd && extractRgb(selectedCmd.bg)).toBe(SHELL_PALETTE.sel);
    expect(selectedCmd && extractRgb(selectedCmd.fg)).toBe(SHELL_PALETTE.selFg);
  });

  test("a row with command.dot renders the commit dot", async () => {
    const rows = [
      makeRow({
        cmd: "/commit-page",
        desc: "current page · 1 file",
        order: 5,
        dot: true,
      }),
    ];
    const handle = await createHeadlessRenderer({ w: 40, h: 4 });
    open = handle;
    handle.mount(<SlashMenu id="slash" typed="/" rows={rows} selectedIndex={0} />);
    await handle.render();
    expect(lineText(handle.capture(), 1)).toContain("●");
  });
});
