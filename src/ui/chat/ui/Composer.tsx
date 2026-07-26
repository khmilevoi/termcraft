import { TextInput } from "ui/text-input";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";
import type { ShellToken } from "ui/theme";

/** Props for the chat composer (design `chatSeq` composer block, `design/termcraft-engine.js:442-452`). */
export interface ComposerProps {
  readonly id: string;
  readonly modelChip: string; // e.g. "claude · sonnet-4.5" — M22: sourced from agentIdentity
  readonly ctx: number | null; // ctx%; null hides the ctx tag
  readonly ctxCaution?: boolean; // ctx>=80 -> value flips to amberHi bold
  readonly disabled?: boolean; // read-only, unfocused, or generating with an EMPTY draft: caret faint, no cursor
  readonly placeholder: string; // "Ask for changes…" / "generating… esc to cancel" / etc
  readonly value: string; // current input (empty -> show placeholder)
  readonly attach?: { readonly text: string; readonly fg: ShellToken } | null; // optional line above input
}

const BOLD = shellAttrs({ bold: true });

/**
 * The chat composer (design `chatSeq` composer block, `design/termcraft-engine.js:442-452`;
 * `design/03-workspace-generating.dc.html`). Renders the composer's top seam row (model chip
 * left, ctx% tag right), an optional attach line, and the input row with the amber caret and
 * blinking cursor. The design draws the seam as a literal `├─…─┤` border rule with the chip/
 * ctx text painted directly onto it; this component instead renders the meta row as its own
 * flex row above a plain input block — the closest faithful mapping since OpenTUI boxes render
 * one full border, not per-glyph overlays onto a border line.
 *
 * Turn-time rendering (finding §2.5, phase-8 Task 16): design draws two distinct states for a
 * running turn, both in `design/termcraft-engine.js`'s `wsGenTyping` (`:259-277`) and confirmed
 * in prose by `design/03-workspace-generating.dc.html`'s `ws-gen-typing-120` paragraph — "Empty,
 * it shows the faint ❯ generating… esc to cancel placeholder with no caret. Holding a draft it
 * looks alive, because it is: amber ❯, text in full foreground, blinking caret." This component
 * needed NO change to reproduce either state: `value`/`disabled` (both already props) already
 * select exactly this pairing — an empty value falls to `TextInput`'s faint placeholder branch
 * regardless of `disabled`, and the caret/cursor already key off `disabled` alone. The caller
 * (`Workspace.tsx`) is what changed: `disabled` is no longer forced by `turn.phase === "running"`
 * on its own, only by a running turn WITH an empty draft — see its own comment at the call site.
 *
 * The input row itself is `ui/text-input`'s shared {@link TextInput} (finding §2.6, phase-8
 * Task 18) — the caret, the value-or-placeholder, and the cursor cell come from that one
 * component now, not a private copy.
 */
export function Composer(props: ComposerProps) {
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
      <TextInput
        id={`${props.id}-input`}
        value={props.value}
        placeholder={props.placeholder}
        caret={"❯ "}
        caretFg={props.disabled === true ? SHELL_PALETTE.faint : SHELL_PALETTE.amber}
        valueFg={SHELL_PALETTE.fg}
        placeholderFg={SHELL_PALETTE.faint}
        showCursor={props.disabled !== true}
      />
    </box>
  );
}
