import { BLINK_CURSOR, CURSOR_GLYPH, SHELL_PALETTE } from "ui/theme";

/** Props for the {@link PinInputPopup} new-pin comment input box. */
export interface PinInputPopupProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  /** The comment text typed so far; the cursor renders immediately after it. */
  readonly value: string;
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
 * This component deliberately does NOT use the shared `ui/text-input` `TextInput`
 * (finding §2.6, phase-8 Task 18): `wsPinInput` (`:642` — CORRECTED, not the task
 * brief's stale `:498`; verified at the source) draws the cursor one column PAST the
 * end of a 26-character value, `this.put(b,pxs+2+26,pys+1,'█',...)`, and the mock
 * never shows an empty state — this component already matches its own design source
 * as-is. It only needs `TextInput`'s overlap rule if it gains a placeholder.
 */
export function PinInputPopup(props: PinInputPopupProps) {
  return (
    <box
      id={props.id}
      border
      borderStyle="rounded"
      borderColor={SHELL_PALETTE.amber}
      title="new pin"
      titleColor={SHELL_PALETTE.amberHi}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
      padding={0}
    >
      <box id={`${props.id}-input`} flexDirection="row">
        <text id={`${props.id}-value`} fg={SHELL_PALETTE.fg}>
          {props.value}
        </text>
        <text id={`${props.id}-cursor`} fg={SHELL_PALETTE.amber} attributes={BLINK_CURSOR}>
          {CURSOR_GLYPH}
        </text>
      </box>
      <text id={`${props.id}-footer`} fg={SHELL_PALETTE.faint}>
        {"⏎ save · esc cancel"}
      </text>
    </box>
  );
}
