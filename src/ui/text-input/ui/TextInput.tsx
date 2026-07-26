import { BLINK_CURSOR, CURSOR_GLYPH, SHELL_PALETTE, shellAttrs } from "ui/theme";

import type { TextInputProps } from "../types";

const BOLD = shellAttrs({ bold: true });

/**
 * The one insertion-point input (finding §2.6). The rule, from the design's own draw order —
 * `text(...)` then `put(...)` at the SAME column — Home's `home()`, `design/termcraft-engine.js:
 * 145-146`: `this.text(b,ix+4,iy+1,'Describe the TUI you want to design…',{fg:P.faint});
 * this.put(b,ix+4,iy+1,'█',{fg:P.amber,blink:true});`; the composer's own placeholder branch,
 * `drawChat()` `:256`: `this.text(...,'Ask for changes…',...); this.put(b,x+3,composerTop+2,'█',
 * ...)` at the SAME `x+3` the text started at. The cursor sits over the placeholder's first cell
 * while the input is empty, and after the last character once it is not — `wsGenTyping()`
 * `:270-274` draws the composer holding a draft exactly that way: `text(...,draft,...)` then
 * `put(b,3+draft.length,...)`, one column past the text, not overlapping it.
 *
 * CORRECTED (this task, read every design line before citing it — this bundle's own standing
 * instruction): the brief's own citations for this rule (`:136-137` for Home, `:208-209`/
 * `:451-452` for the composer) point at unrelated code. `:136-137` is `home()`'s `checking`/
 * `typed` setup, two lines above the actual draw; `:208-209` is `workspace()`'s chat/preview
 * divider bookkeeping (`div=chatW-1`); `:451-452` is the `/model` tweaks screen's row-selection
 * paint. Re-cited above to the lines that actually draw the overlap.
 *
 * THE OLD PREMISE WAS WRONG. `Home.tsx` documented this as a knowing divergence — "Flexbox can't
 * overlap two siblings in the same cell, so the closest faithful mapping appends the cursor right
 * after the text" — which painted `❯ Describe the TUI you want to design…█`. No overlap is needed:
 * while the placeholder shows, its FIRST CHARACTER is simply rendered as the cursor cell and the
 * remainder as a second run. That is exactly what `put`-over-`text` produces, with no absolute
 * positioning at all.
 *
 * `PinInputPopup` deliberately does NOT use this: `wsPinInput` — `design/termcraft-engine.js:642`
 * (not the brief's `:498`; same stale-citation issue as above) — draws its cursor one column past
 * the end of a 26-character value, and the mock never shows an empty state, so that component
 * already matches its own design source. It needs this rule only if it gains a placeholder.
 */
export function TextInput(props: TextInputProps) {
  const hasValue = props.value.length > 0;

  const caret = (
    <text id={`${props.id}-caret`} fg={props.caretFg} attributes={BOLD}>
      {props.caret}
    </text>
  );

  if (hasValue) {
    return (
      <box id={props.id} flexDirection="row">
        {caret}
        <text id={`${props.id}-value`} fg={props.valueFg}>
          {props.value}
        </text>
        {props.showCursor ? (
          <text id={`${props.id}-cursor`} fg={SHELL_PALETTE.amber} attributes={BLINK_CURSOR}>
            {CURSOR_GLYPH}
          </text>
        ) : null}
      </box>
    );
  }

  if (!props.showCursor) {
    return (
      <box id={props.id} flexDirection="row">
        {caret}
        <text id={`${props.id}-placeholder`} fg={props.placeholderFg}>
          {props.placeholder}
        </text>
      </box>
    );
  }

  // Empty AND focused: the placeholder's first cell IS the cursor.
  return (
    <box id={props.id} flexDirection="row">
      {caret}
      <text id={`${props.id}-cursor`} fg={SHELL_PALETTE.amber} attributes={BLINK_CURSOR}>
        {CURSOR_GLYPH}
      </text>
      <text id={`${props.id}-placeholder-rest`} fg={props.placeholderFg}>
        {props.placeholder.slice(1)}
      </text>
    </box>
  );
}
