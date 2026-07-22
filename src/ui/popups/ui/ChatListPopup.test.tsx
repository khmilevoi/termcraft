import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import type { ChatListRow } from "./ChatListPopup";
import { ChatListPopup } from "./ChatListPopup";

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

const ROWS: readonly ChatListRow[] = [
  {
    chatId: "chat-1",
    label: "build a system monitor with cpu / mem gauges",
    when: "now",
    active: true,
  },
  { chatId: "chat-2", label: "make the process table sortable", when: "8m ago", active: false },
  { chatId: "chat-3", label: "try a 256-color palette variant", when: "1h ago", active: false },
];

test("chat rows retain the exact chatId used by chat.switch", () => {
  expect(ROWS.map((row) => row.chatId)).toEqual(["chat-1", "chat-2", "chat-3"]);
});

describe("ChatListPopup component (design 24-chats.dc.html, wsChats)", () => {
  test('title is "chats"', async () => {
    const handle = await createHeadlessRenderer({ w: 74, h: 8 });
    open = handle;
    handle.mount(<ChatListPopup id="chats" rows={ROWS} selectedIndex={0} />);
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("chats");
  });

  test("the header row shows CHAT and WHEN in faint bold", async () => {
    const handle = await createHeadlessRenderer({ w: 74, h: 8 });
    open = handle;
    handle.mount(<ChatListPopup id="chats" rows={ROWS} selectedIndex={0} />);
    await handle.render();
    const frame = handle.capture();
    const chatRun = findRun(frame, "CHAT");
    const whenRun = findRun(frame, "WHEN");
    expect(chatRun && extractRgb(chatRun.fg)).toBe(SHELL_PALETTE.faint);
    expect((chatRun?.attrs ?? 0) & 0b1).toBe(0b1);
    expect(whenRun && extractRgb(whenRun.fg)).toBe(SHELL_PALETTE.faint);
    expect((whenRun?.attrs ?? 0) & 0b1).toBe(0b1);
  });

  test("the selected row shows the ▸ glyph and the sel background", async () => {
    const handle = await createHeadlessRenderer({ w: 74, h: 8 });
    open = handle;
    handle.mount(<ChatListPopup id="chats" rows={ROWS} selectedIndex={1} />);
    await handle.render();
    const frame = handle.capture();
    expect(lineText(frame, 2)).not.toContain("▸");
    expect(lineText(frame, 3)).toContain("▸");
    const marker = findRun(frame, "▸");
    expect(marker && extractRgb(marker.bg)).toBe(SHELL_PALETTE.sel);
    const label = findRun(frame, "make the process table sortable");
    expect(label && extractRgb(label.bg)).toBe(SHELL_PALETTE.sel);
    expect(label && extractRgb(label.fg)).toBe(SHELL_PALETTE.selFg);
  });

  test("an active row shows the ● dot, an inactive row shows ○", async () => {
    const handle = await createHeadlessRenderer({ w: 74, h: 8 });
    open = handle;
    handle.mount(<ChatListPopup id="chats" rows={ROWS} selectedIndex={0} />);
    await handle.render();
    const frame = handle.capture();
    expect(lineText(frame, 2)).toContain("●");
    expect(lineText(frame, 3)).toContain("○");
    expect(lineText(frame, 4)).toContain("○");
  });

  test("the footer renders the select/switch/close hints", async () => {
    const handle = await createHeadlessRenderer({ w: 74, h: 8 });
    open = handle;
    handle.mount(<ChatListPopup id="chats" rows={ROWS} selectedIndex={0} />);
    await handle.render();
    const frame = handle.capture();
    const footerText = lineText(frame, 5);
    expect(footerText).toContain("select");
    expect(footerText).toContain("switch");
    expect(footerText).toContain("fresh chat");
    expect(footerText).toContain("close");
  });
});
