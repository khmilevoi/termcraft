import { activeTokens } from "../model/tokens";
import type { ThemeTokens } from "../types";

/** Props for the `Panel` bordered container. `id` is the mandatory stable id (§3.2). */
export interface PanelProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string;
  /** Optional caption drawn into the top border. */
  readonly title?: string;
  readonly children?: unknown;
  /** Uniform inner padding inside the border. */
  readonly padding?: number;
  /** A semantic token for the border; defaults to `border`. Design variants: `accent` (active/popup), `accentHi` (hover), `danger` (error), `line` (dimmed). */
  readonly borderColor?: keyof ThemeTokens;
  /** A semantic token for the title; defaults to `foreground`. Design variants: `accentHi` (popup/active), `foregroundMuted` (welded sub-panel). */
  readonly titleColor?: keyof ThemeTokens;
}

/**
 * A titled, bordered column container (design-system §3.2). Default draws a
 * single-line border in `border` with an optional `title` in `foreground` bold —
 * the engine's `box()` defaults. `borderColor`/`titleColor` accept semantic tokens
 * so a caller renders the design's variants (an active/popup panel uses an `accent`
 * border + `accentHi` title; an error panel a `danger` border; a welded sub-panel a
 * `foregroundMuted` title). Colors resolve from tokens; the mandatory `id` flows to
 * the element for host geometry.
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
      borderColor={tokens[props.borderColor ?? "border"]}
      // design/termcraft-engine.js:52 — the caption is drawn at `x+2` as `' '+title+' '`.
      // OpenTUI already starts a left-aligned title at index 2, so the padding is the only
      // part this has to supply. DIVERGENCE: the design also draws it bold by default
      // (`titleBold !== false`); OpenTUI's box exposes `titleColor`/`titleAlignment` and no
      // attribute mask for the caption, so weight cannot be reproduced here.
      title={props.title === undefined ? undefined : ` ${props.title} `}
      titleColor={tokens[props.titleColor ?? "foreground"]}
      flexDirection="column"
      padding={props.padding}
    >
      {props.children}
    </box>
  );
}
