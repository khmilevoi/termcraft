import { TextEditor } from "ui/text-input";
import type { EditorBridge } from "ui/text-input";
import { SHELL_PALETTE } from "ui/theme";

/** The content width of the box, inside its border. */
const PIN_INPUT_WIDTH = 38;

/**
 * The popup's own outer cell footprint — the border plus its two content rows (comment field,
 * footer hint). The preview shell needs it to anchor the box beside the pin badge without
 * letting it overrun the frame (`pinInputAnchor`).
 */
export const PIN_INPUT_POPUP_SIZE = { width: PIN_INPUT_WIDTH + 2, height: 4 } as const;

/** Props for the {@link PinInputPopup} new-pin comment input box. */
export interface PinInputPopupProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  /** Whether keys reach the comment field. False on a read-only screen. */
  readonly focused: boolean;
  /** The pin editor's wiring — `deps.editors.pin`. */
  readonly bridge: EditorBridge;
}

/**
 * The new-pin comment input box (design `wsPinInput`,
 * `design/termcraft-engine.js:633-643`; `design/08-pin-comments.dc.html`). Renders
 * only the input box itself — the numbered anchor badge marking the click point and
 * the dimmed workspace backdrop behind the popup are the App/overlay's concern, not
 * this component's.
 *
 * divergence: the design draws the footer hint (`⏎ save · esc cancel`) as a
 * separate text line one row below the box's own 3-row rect (`box(...,pw,3,...)`
 * then `text(...,pys+3,...)`), outside the bordered frame. OpenTUI's popup here is
 * a single bordered box, so the footer folds into the same box's column layout as
 * a second row — the closest faithful mapping.
 *
 * divergence (width): design sizes the box `pw = Math.min(40, dw - 14)` (`wsPinInput` `:696`),
 * where `dw` is the preview pane's inner width — a shrink term that keeps the box inside the pane
 * when it is anchored beside the badge. The box keeps the design's own upper bound, 40, at every
 * pane width and the shell slides it back inside instead (`pinInputAnchor`) — same guarantee, one
 * fixed width, so the field never changes size under the caret as the pane resizes.
 *
 * The comment field is `ui/text-input`'s {@link TextEditor} in its single-line form. Design draws
 * the cursor one column past the end of the value (`this.put(b,pxs+2+26,pys+1,'█',…)`, `:699`),
 * which is exactly where the terminal's own cursor sits after the last character — the placement
 * this component used to emulate now holds by construction.
 */
export function PinInputPopup(props: PinInputPopupProps) {
  return (
    <box
      id={props.id}
      width={PIN_INPUT_POPUP_SIZE.width}
      border
      borderStyle="rounded"
      borderColor={SHELL_PALETTE.amber}
      title="new pin"
      titleColor={SHELL_PALETTE.amberHi}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
      padding={0}
    >
      <TextEditor
        id={`${props.id}-input`}
        placeholder=""
        // Design draws no caret glyph for this field — `wsPinInput` `:699` starts the text at
        // `pxs+2` with no `❯` — so the caret run is empty and the editor owns the whole row.
        caret=""
        caretFg={SHELL_PALETTE.amber}
        valueFg={SHELL_PALETTE.fg}
        placeholderFg={SHELL_PALETTE.faint}
        cursorFg={SHELL_PALETTE.amber}
        // Single-line: `InputRenderable` enforces height 1, no wrapping, and newline stripping
        // including from paste — which is what a one-row comment field wants.
        multiline={false}
        rows={1}
        width={PIN_INPUT_WIDTH}
        focused={props.focused}
        showCursor={props.focused}
        bridge={props.bridge}
      />
      <text id={`${props.id}-footer`} fg={SHELL_PALETTE.faint}>
        {"⏎ save · esc cancel"}
      </text>
    </box>
  );
}
