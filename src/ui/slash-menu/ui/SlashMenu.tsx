import { reasonLabel } from "ui/actions";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import type { SlashMenuProps } from "../types";

// design's own literal reason for a locked row that carries no capability-sourced
// `UnavailableReason` — `/chats` has no Kernel capability of its own to source a hint from, yet
// every locked command in `commandRegistry()` shares this exact `lock` string
// (`design/termcraft-engine.js:927-930`), which `slashRows()` copies verbatim into `_why` at
// `:945` whenever a row locks (`:937-938` glosses `_lk` as "comes back on its own"). Without
// this fallback a hint-less locked row would fall through to its plain description, which is
// exactly the two-state `enabled`/`dimmed` bug this task exists to fix.
const LOCKED_FALLBACK_REASON = "locked · turn running";

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
        const { availability, hint } = row.state;
        const locked = availability === "locked";
        const unavailable = availability === "unavailable";
        const off = locked || unavailable;

        // design/termcraft-engine.js:953-961, colour by colour:
        //   marker  off ? faint : amber                                            (:957)
        //   dot     un ? faint : lk ? amberDim : sel ? selFg : amber                (:958)
        //   cmd     un ? faint : lk ? dim      : sel ? selFg : fg                   (:959)
        //   text    un ? faint : lk ? amberDim : sel ? selFg : dim                  (:961)
        // — and the text itself is the reason, not the description, whenever the row is off
        // (`:960`'s `const txt=off?c._why:c.desc`).
        const markerFg = off ? SHELL_PALETTE.faint : SHELL_PALETTE.amber;
        const dotFg = unavailable
          ? SHELL_PALETTE.faint
          : locked
            ? SHELL_PALETTE.amberDim
            : selected
              ? SHELL_PALETTE.selFg
              : SHELL_PALETTE.amber;
        const cmdFg = unavailable
          ? SHELL_PALETTE.faint
          : locked
            ? SHELL_PALETTE.dim
            : selected
              ? SHELL_PALETTE.selFg
              : SHELL_PALETTE.fg;
        const descFg = unavailable
          ? SHELL_PALETTE.faint
          : locked
            ? SHELL_PALETTE.amberDim
            : selected
              ? SHELL_PALETTE.selFg
              : SHELL_PALETTE.dim;
        // A locked row always has a reason in the design (every `lock`-bearing command shares
        // one string, `slashRows` :945), even when this row's own `ActionRowState.hint` is
        // `null` (e.g. `/chats`, which has no Kernel capability to source a hint from) — fall
        // back to the design's own lock text rather than silently showing the description.
        const reasonText =
          hint !== null ? reasonLabel(hint) : locked ? LOCKED_FALLBACK_REASON : null;
        const descText = off && reasonText !== null ? reasonText : row.command.desc;
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
              fg={markerFg}
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
              attributes={shellAttrs({ bold: selected && !off })}
            >
              {row.command.cmd.padEnd(13, " ")}
            </text>
            <text id={`${props.id}-row-${row.command.cmd}-desc`} fg={descFg}>
              {descText}
            </text>
          </box>
        );
      })}
    </box>
  );
}
