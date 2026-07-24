import { SHELL_PALETTE, shellAttrs } from "ui/theme";
import type { ShellToken } from "ui/theme";

/** Props for the chat composer (design `chatSeq` composer block, `design/termcraft-engine.js:442-452`). */
export interface ComposerProps {
  readonly id: string;
  readonly modelChip: string; // e.g. "claude · sonnet-4.5" — M22: sourced from agentIdentity
  readonly ctx: number | null; // ctx%; null hides the ctx tag
  readonly ctxCaution?: boolean; // ctx>=80 -> value flips to amberHi bold
  readonly disabled?: boolean; // generating/read-only: caret faint, no cursor
  readonly placeholder: string; // "Ask for changes…" / "generating… esc to cancel" / etc
  readonly value: string; // current input (empty -> show placeholder)
  readonly attach?: { readonly text: string; readonly fg: ShellToken } | null; // optional line above input
}

const BOLD = shellAttrs({ bold: true });
const BLINK_CURSOR = shellAttrs({ blink: true });
const CURSOR_GLYPH = "█";

/**
 * The chat composer (design `chatSeq` composer block, `design/termcraft-engine.js:442-452`;
 * `design/03-workspace-generating.dc.html`). Renders the composer's top seam row (model chip
 * left, ctx% tag right), an optional attach line, and the input row with the amber caret and
 * blinking cursor. The design draws the seam as a literal `├─…─┤` border rule with the chip/
 * ctx text painted directly onto it; this component instead renders the meta row as its own
 * flex row above a plain input block — the closest faithful mapping since OpenTUI boxes render
 * one full border, not per-glyph overlays onto a border line.
 */
export function Composer(props: ComposerProps) {
  const hasValue = props.value.length > 0;
  const showCursor = props.disabled !== true;
  const ctxValueFg = props.ctxCaution === true ? SHELL_PALETTE.amberHi : SHELL_PALETTE.fg;

  return (
    <box id={props.id} flexDirection="column">
      <box id={`${props.id}-seam`} flexDirection="row">
        <text id={`${props.id}-seam-model`} fg={SHELL_PALETTE.amberHi} attributes={BOLD}>
          {` ${props.modelChip} `}
        </text>
        <box id={`${props.id}-seam-spacer`} flexGrow={1} />
        {props.ctx != null ? (
          <box id={`${props.id}-seam-ctx`} flexDirection="row">
            <text id={`${props.id}-seam-ctx-label`} fg={SHELL_PALETTE.faint}>
              {" ctx "}
            </text>
            <text id={`${props.id}-seam-ctx-value`} fg={ctxValueFg} attributes={BOLD}>
              {`${props.ctx}% `}
            </text>
          </box>
        ) : null}
      </box>
      {props.attach != null ? (
        <text id={`${props.id}-attach`} fg={SHELL_PALETTE[props.attach.fg]}>
          {props.attach.text}
        </text>
      ) : null}
      <box id={`${props.id}-input`} flexDirection="row">
        <text
          id={`${props.id}-input-caret`}
          fg={props.disabled === true ? SHELL_PALETTE.faint : SHELL_PALETTE.amber}
          attributes={BOLD}
        >
          {"❯ "}
        </text>
        <text id={`${props.id}-input-text`} fg={hasValue ? SHELL_PALETTE.fg : SHELL_PALETTE.faint}>
          {hasValue ? props.value : props.placeholder}
        </text>
        {showCursor ? (
          <text id={`${props.id}-input-cursor`} fg={SHELL_PALETTE.amber} attributes={BLINK_CURSOR}>
            {CURSOR_GLYPH}
          </text>
        ) : null}
      </box>
    </box>
  );
}
