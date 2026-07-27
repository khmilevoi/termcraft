import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import { computeChatListViewport } from "../model/chat-list";

/** A single chat row shown in the `/chats` popup list. */
export interface ChatListRow {
  readonly chatId: string;
  readonly label: string;
  readonly when: string;
  readonly active: boolean;
}

/** Props for the `/chats` popup component. `id` is the mandatory stable id (§3.2). */
export interface ChatListPopupProps {
  readonly id: string;
  readonly rows: readonly ChatListRow[];
  readonly selectedIndex: number;
}

/** Truncates a chat label past 40 chars with an ellipsis, then pads to the 44-col field width (design `wsChats`). */
function formatLabel(label: string): string {
  const truncated = label.length > 40 ? `${label.slice(0, 40)}…` : label;
  return truncated.padEnd(44, " ");
}

/**
 * The column the CHAT/WHEN header and every row label share.
 *
 * A row is drawn as a 2-cell selection marker plus a 2-cell active dot before its label, and
 * the design puts the header's own text at the SAME column as those labels: it draws rows from
 * `lx-1` (`this.put(b,lx-1,ly, sel?'▸':' ')`, `design/termcraft-engine.js:1053`) with the label
 * at `lx+3` (`:1057`), and the header at `lx` with three cells of its own padding
 * (`pad('',3)+pad('CHAT',44)+'WHEN'`, `:1050`) — both landing four cells in. Without this the
 * header sat four columns left of the values it labels.
 */
const COLUMN_INDENT = "    ";

/**
 * The `▲ N earlier` / `▼ N more` edge rows are indented two cells past the row marker, matching
 * design `wsChats`'s own `this.text(b,lx+1,ly,'▲ '+before+' earlier',…)` (`:1051`, `:1060`)
 * against rows that start at `lx-1`.
 */
const EDGE_INDENT = "  ";

/**
 * The `/chats` popup (design `wsChats`, `design/24-chats.dc.html`) — the chat list
 * the user browses/switches through. Renders only the popup box itself; the dimmed
 * backdrop behind it is the App's concern (this component never draws a backdrop).
 */
export function ChatListPopup(props: ChatListPopupProps) {
  const total = props.rows.length;
  // Defect 1 fix: cap the rendered rows at the design's fixed viewport (`wsChats`: `const
  // cap=6`, `design/termcraft-engine.js:1042`) and follow the selection through it, instead of
  // mapping over every row unconditionally.
  const viewport = computeChatListViewport({ total, selectedIndex: props.selectedIndex });
  const visibleRows = props.rows.slice(viewport.start, viewport.start + viewport.visibleCount);
  const overflowing = viewport.before > 0 || viewport.after > 0;

  return (
    <box
      id={props.id}
      border
      borderStyle="rounded"
      borderColor={SHELL_PALETTE.amber}
      // design `wsChats`: `title:'chats · '+list.length` (engine:1048).
      title={`chats · ${total}`}
      titleColor={SHELL_PALETTE.amberHi}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
    >
      <text
        id={`${props.id}-header`}
        fg={SHELL_PALETTE.faint}
        attributes={shellAttrs({ bold: true })}
      >
        {`${COLUMN_INDENT}${"CHAT".padEnd(44, " ")}WHEN`}
      </text>
      {viewport.before > 0 && (
        <text id={`${props.id}-before`} fg={SHELL_PALETTE.amberDim}>
          {`${EDGE_INDENT}▲ ${viewport.before} earlier`}
        </text>
      )}
      {visibleRows.map((row, i) => {
        const index = viewport.start + i;
        const selected = index === props.selectedIndex;
        const rowId = `${props.id}-row-${row.chatId}`;
        return (
          // keyed intrinsic wrapper — the function component itself carries no `key`.
          <box
            key={row.chatId}
            id={rowId}
            flexDirection="row"
            backgroundColor={selected ? SHELL_PALETTE.sel : undefined}
          >
            <text
              id={`${rowId}-marker`}
              fg={SHELL_PALETTE.amber}
              attributes={shellAttrs({ bold: true })}
            >
              {selected ? "▸ " : "  "}
            </text>
            <text id={`${rowId}-dot`} fg={selected ? SHELL_PALETTE.amber : SHELL_PALETTE.dim}>
              {row.active ? "● " : "○ "}
            </text>
            <text
              id={`${rowId}-label`}
              fg={selected ? SHELL_PALETTE.selFg : SHELL_PALETTE.fg}
              attributes={shellAttrs({ bold: selected })}
            >
              {formatLabel(row.label)}
            </text>
            <text id={`${rowId}-when`} fg={selected ? SHELL_PALETTE.selFg : SHELL_PALETTE.dim}>
              {row.when}
            </text>
          </box>
        );
      })}
      {viewport.after > 0 && (
        <text id={`${props.id}-after`} fg={SHELL_PALETTE.amberDim}>
          {`${EDGE_INDENT}▼ ${viewport.after} more`}
        </text>
      )}
      <box id={`${props.id}-footer`} flexDirection="row">
        <text
          id={`${props.id}-footer-nav-key`}
          fg={SHELL_PALETTE.amber}
          attributes={shellAttrs({ bold: true })}
        >
          {"↑↓"}
        </text>
        <text id={`${props.id}-footer-nav-label`} fg={SHELL_PALETTE.dim}>
          {" select "}
        </text>
        <text
          id={`${props.id}-footer-switch-key`}
          fg={SHELL_PALETTE.amber}
          attributes={shellAttrs({ bold: true })}
        >
          {"· ⏎"}
        </text>
        <text id={`${props.id}-footer-switch-label`} fg={SHELL_PALETTE.dim}>
          {" switch "}
        </text>
        {/*
          Design 24-chats.dc.html: "The footer drops the /new fresh chat hint. /new cannot be
          typed while the popup is open — it advertised a command this surface cannot run — and
          three hints leave room for the position readout." `wsChats`'s own footer draw
          (engine:1064-1066) is exactly ↑↓ select / ⏎ switch / esc close — no /new hint. The
          previous 4-hint footer (with "· /new fresh chat") did not match either source.
        */}
        <text
          id={`${props.id}-footer-esc-key`}
          fg={SHELL_PALETTE.amber}
          attributes={shellAttrs({ bold: true })}
        >
          {"· esc"}
        </text>
        <text id={`${props.id}-footer-esc-label`} fg={SHELL_PALETTE.dim}>
          {" close"}
        </text>
        {overflowing && <box id={`${props.id}-footer-spacer`} flexGrow={1} />}
        {overflowing && (
          // design: right-aligned "5–10 of 14" readout (engine:1067) — a flexGrow spacer stands
          // in for the engine's manual right-alignment math, the same idiom `StatusBar.tsx` uses
          // for its own right-aligned key hints.
          <text id={`${props.id}-footer-position`} fg={SHELL_PALETTE.faint}>
            {`${viewport.start + 1}–${viewport.start + viewport.visibleCount} of ${total}`}
          </text>
        )}
      </box>
    </box>
  );
}
