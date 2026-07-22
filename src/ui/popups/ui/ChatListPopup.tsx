import { SHELL_PALETTE, shellAttrs } from "ui/theme";

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
 * The `/chats` popup (design `wsChats`, `design/24-chats.dc.html`) — the chat list
 * the user browses/switches through. Renders only the popup box itself; the dimmed
 * backdrop behind it is the App's concern (this component never draws a backdrop).
 */
export function ChatListPopup(props: ChatListPopupProps) {
  return (
    <box
      id={props.id}
      border
      borderStyle="rounded"
      borderColor={SHELL_PALETTE.amber}
      title="chats"
      titleColor={SHELL_PALETTE.amberHi}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
    >
      <text
        id={`${props.id}-header`}
        fg={SHELL_PALETTE.faint}
        attributes={shellAttrs({ bold: true })}
      >
        {`${"CHAT".padEnd(44, " ")}WHEN`}
      </text>
      {props.rows.map((row, index) => {
        const selected = index === props.selectedIndex;
        return (
          // keyed intrinsic wrapper — the function component itself carries no `key`.
          <box
            key={row.chatId}
            id={`${props.id}-row-${index}`}
            flexDirection="row"
            backgroundColor={selected ? SHELL_PALETTE.sel : undefined}
          >
            <text
              id={`${props.id}-row-${index}-marker`}
              fg={SHELL_PALETTE.amber}
              attributes={shellAttrs({ bold: true })}
            >
              {selected ? "▸ " : "  "}
            </text>
            <text
              id={`${props.id}-row-${index}-dot`}
              fg={selected ? SHELL_PALETTE.amber : SHELL_PALETTE.dim}
            >
              {row.active ? "● " : "○ "}
            </text>
            <text
              id={`${props.id}-row-${index}-label`}
              fg={selected ? SHELL_PALETTE.selFg : SHELL_PALETTE.fg}
              attributes={shellAttrs({ bold: selected })}
            >
              {formatLabel(row.label)}
            </text>
            <text
              id={`${props.id}-row-${index}-when`}
              fg={selected ? SHELL_PALETTE.selFg : SHELL_PALETTE.dim}
            >
              {row.when}
            </text>
          </box>
        );
      })}
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
        <text
          id={`${props.id}-footer-new-key`}
          fg={SHELL_PALETTE.amber}
          attributes={shellAttrs({ bold: true })}
        >
          {"· /new"}
        </text>
        <text id={`${props.id}-footer-new-label`} fg={SHELL_PALETTE.dim}>
          {" fresh chat "}
        </text>
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
      </box>
    </box>
  );
}
