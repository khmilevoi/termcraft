import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import type { SlashMenuProps } from "../types";

/**
 * The non-modal slash-command autocomplete popup (design `slashMenu`,
 * `design/23-slash-menu.dc.html`). Anchored directly above the composer by the
 * caller's layout — this component only renders the box + rows, no backdrop dim
 * (design: "not a modal, no backdrop dimming, the design behind stays at full
 * contrast").
 */
export function SlashMenu(props: SlashMenuProps) {
  const title = props.typed === "/" ? "commands" : props.typed;
  return (
    <box
      id={props.id}
      border
      borderStyle="rounded"
      borderColor={SHELL_PALETTE.amber}
      title={title}
      titleColor={SHELL_PALETTE.amberHi}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
    >
      {props.rows.map((row, index) => {
        const selected = index === props.selectedIndex;
        const dimmed = row.state.dimmed;
        const dotFg = dimmed
          ? SHELL_PALETTE.faint
          : selected
            ? SHELL_PALETTE.selFg
            : SHELL_PALETTE.amber;
        const cmdFg = dimmed
          ? SHELL_PALETTE.faint
          : selected
            ? SHELL_PALETTE.selFg
            : SHELL_PALETTE.fg;
        const descFg = dimmed
          ? SHELL_PALETTE.faint
          : selected
            ? SHELL_PALETTE.selFg
            : SHELL_PALETTE.dim;
        return (
          // keyed intrinsic wrapper — function components carry no `key` in this
          // repo's no-@types/react environment; the box takes it instead.
          <box
            key={row.command.cmd}
            id={`${props.id}-row-${row.command.cmd}`}
            flexDirection="row"
            backgroundColor={selected ? SHELL_PALETTE.sel : undefined}
          >
            <text
              id={`${props.id}-row-${row.command.cmd}-marker`}
              fg={SHELL_PALETTE.amber}
              attributes={shellAttrs({ bold: selected })}
            >
              {selected ? "▸ " : "  "}
            </text>
            <text id={`${props.id}-row-${row.command.cmd}-dot`} fg={dotFg}>
              {row.command.dot === true ? "● " : "  "}
            </text>
            <text
              id={`${props.id}-row-${row.command.cmd}-cmd`}
              fg={cmdFg}
              attributes={shellAttrs({ bold: selected && !dimmed })}
            >
              {row.command.cmd.padEnd(13, " ")}
            </text>
            <text id={`${props.id}-row-${row.command.cmd}-desc`} fg={descFg}>
              {row.command.desc}
            </text>
          </box>
        );
      })}
    </box>
  );
}
