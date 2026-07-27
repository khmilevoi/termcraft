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

describe("ChatListPopup component (design 24-chats.dc.html, wsChats)", () => {
  test("distinct chatId values are preserved on their rendered selectable rows", async () => {
    const handle = await createHeadlessRenderer({ w: 74, h: 8 });
    open = handle;
    handle.mount(<ChatListPopup id="chats" rows={ROWS} selectedIndex={1} />);
    await handle.render();
    for (const row of ROWS) expect(handle.describe(`chats-row-${row.chatId}`)).not.toBeNull();
    expect(handle.rectOf("chats-row-chat-1")).not.toEqual(handle.rectOf("chats-row-chat-2"));
  });

  test("title is \"chats · \" + the full row count (design wsChats: title:'chats · '+list.length, engine:1048)", async () => {
    const handle = await createHeadlessRenderer({ w: 74, h: 8 });
    open = handle;
    handle.mount(<ChatListPopup id="chats" rows={ROWS} selectedIndex={0} />);
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain(`chats · ${ROWS.length}`);
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

  // Design 24-chats.dc.html ("The footer drops the `/new fresh chat` hint. `/new` cannot be
  // typed while the popup is open ... three hints leave room for the position readout"):
  // `wsChats`'s own footer draw (engine:1064-1066) is exactly ↑↓ select / ⏎ switch / esc close —
  // no `/new` hint at all.
  test("the footer renders only the select/switch/close hints, never /new (design 24-chats.dc.html)", async () => {
    const handle = await createHeadlessRenderer({ w: 74, h: 8 });
    open = handle;
    handle.mount(<ChatListPopup id="chats" rows={ROWS} selectedIndex={0} />);
    await handle.render();
    const frame = handle.capture();
    const footerText = lineText(frame, 5);
    expect(footerText).toContain("select");
    expect(footerText).toContain("switch");
    expect(footerText).toContain("close");
    expect(footerText).not.toContain("fresh chat");
    expect(footerText).not.toContain("/new");
  });

  // Defect 1 (Important): the popup used to map over ALL rows with no slice at all.
  describe("viewport cap (design wsChats: const cap=6, engine:1042-1067)", () => {
    const manyRows: readonly ChatListRow[] = Array.from({ length: 14 }, (_, i) => ({
      chatId: `chat-${i}`,
      label: `chat number ${i}`,
      when: `${i}d ago`,
      active: i === 0,
    }));

    test("renders at most 6 rows even when the full list has 14", async () => {
      const handle = await createHeadlessRenderer({ w: 90, h: 14 });
      open = handle;
      handle.mount(<ChatListPopup id="chats" rows={manyRows} selectedIndex={0} />);
      await handle.render();
      const rendered = manyRows.filter(
        (row) => handle.describe(`chats-row-${row.chatId}`) !== null,
      );
      expect(rendered.length).toBeLessThanOrEqual(6);
    });

    test("selecting the first row shows a trailing '▼ N more' row and no leading '▲ earlier' row", async () => {
      const handle = await createHeadlessRenderer({ w: 90, h: 14 });
      open = handle;
      handle.mount(<ChatListPopup id="chats" rows={manyRows} selectedIndex={0} />);
      await handle.render();
      const text = handle
        .capture()
        .rows.map((row) => row.map((run) => run.text).join(""))
        .join("\n");
      expect(text).toContain("▼ 8 more");
      expect(text).not.toContain("▲");
    });

    test("selecting the last row shows a leading '▲ N earlier' row and no trailing '▼ more' row", async () => {
      const handle = await createHeadlessRenderer({ w: 90, h: 14 });
      open = handle;
      handle.mount(<ChatListPopup id="chats" rows={manyRows} selectedIndex={13} />);
      await handle.render();
      const text = handle
        .capture()
        .rows.map((row) => row.map((run) => run.text).join(""))
        .join("\n");
      expect(text).toContain("▲ 8 earlier");
      expect(text).not.toContain("▼");
      expect(handle.describe("chats-row-chat-13")).not.toBeNull();
    });

    test("the viewport follows the selection: the selected row is always rendered", async () => {
      const handle = await createHeadlessRenderer({ w: 90, h: 14 });
      open = handle;
      handle.mount(<ChatListPopup id="chats" rows={manyRows} selectedIndex={7} />);
      await handle.render();
      expect(handle.describe("chats-row-chat-7")).not.toBeNull();
    });

    test("right-aligns a '<start>–<end> of <total>' position readout in the footer when overflowing", async () => {
      const handle = await createHeadlessRenderer({ w: 90, h: 14 });
      open = handle;
      handle.mount(<ChatListPopup id="chats" rows={manyRows} selectedIndex={7} />);
      await handle.render();
      const text = handle
        .capture()
        .rows.map((row) => row.map((run) => run.text).join(""))
        .join("\n");
      expect(text).toContain("6–11 of 14");
    });

    test("no position readout when the list fits inside the cap (no overflow)", async () => {
      const handle = await createHeadlessRenderer({ w: 90, h: 14 });
      open = handle;
      handle.mount(<ChatListPopup id="chats" rows={ROWS} selectedIndex={0} />);
      await handle.render();
      const text = handle
        .capture()
        .rows.map((row) => row.map((run) => run.text).join(""))
        .join("\n");
      expect(text).not.toMatch(/\d+–\d+ of \d+/);
    });
  });
});
