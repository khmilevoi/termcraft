import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/** Props for the `Panel` bordered container. `id` is the mandatory stable id (§3.2). */
export interface PanelProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string;
  /** Optional caption drawn into the top border. */
  readonly title?: string;
  readonly children?: unknown;
  /** Uniform inner padding inside the border. */
  readonly padding?: number;
  /** The border hue; defaults to the theme's `border`. Design variants: `t.accent` (active/popup), `t.accentHi` (hover), `t.danger` (error), `t.line` (dimmed). */
  readonly borderColor?: Color;
  /** The title hue; defaults to the theme's `foreground`. Design variants: `t.accentHi` (popup/active), `t.foregroundMuted` (welded sub-panel). */
  readonly titleColor?: Color;
}

/**
 * A titled, bordered column container (design-system §3.2). Draws the design's rounded
 * frame (`box()`'s own default, `design/termcraft-engine.js:47`) with an optional `title`
 * space-padded into the top border (`:52`'s `' '+title+' '`), or no caption at all when
 * `title` is absent or empty — matching the engine's own `if(o.title){…}` guard.
 * `borderColor`/`titleColor` accept semantic tokens so a caller renders the design's variants
 * (an active/popup panel uses an `accent` border + `accentHi` title; an error panel a
 * `danger` border; a welded sub-panel a `foregroundMuted` title). Colors resolve from
 * tokens; the mandatory `id` flows to the element for host geometry.
 */
export function Panel(props: PanelProps) {
  const tokens = activeTokens();
  return (
    <box
      id={props.id}
      border
      // design/termcraft-engine.js:47 — `box()`'s own default is ROUNDED (`const r =
      // o.rounded !== false`); square corners are the opt-out, and no design screen takes it.
      borderStyle="rounded"
      borderColor={props.borderColor ?? tokens.border}
      // design/termcraft-engine.js:52 — the caption is drawn at `x+2` as `' '+title+' '`,
      // guarded by `if(o.title){…}`: a falsy title (absent OR `""`) draws NO caption at all.
      // `=== undefined` alone treated `title=""` as present and punched two bare spaces into
      // the border; `!props.title` matches the engine's own falsy check exactly. OpenTUI
      // already starts a left-aligned title at index 2, so the padding is the only part this
      // has to supply. DIVERGENCE: the design also draws it bold by default (`titleBold !==
      // false`); OpenTUI's box exposes `titleColor`/`titleAlignment` and no attribute mask
      // for the caption, so weight cannot be reproduced here.
      title={props.title ? ` ${props.title} ` : undefined}
      titleColor={props.titleColor ?? tokens.foreground}
      flexDirection="column"
      padding={props.padding}
    >
      {props.children}
    </box>
  );
}
