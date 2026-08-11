import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/**
 * The seven glyph sets `@opentui/core@0.4.5` ships (`lib/ascii.font.d.ts:3`), declared locally
 * rather than re-exported so an OpenTUI upgrade changes this adapter and not one saved page (§6).
 * Omitting `font` leaves OpenTUI's own default, `tiny`.
 */
export type AsciiFontName = "tiny" | "block" | "shade" | "slick" | "huge" | "grid" | "pallet";

/** Props for the `AsciiFont` display text. `id` is the mandatory stable id (§3.2). */
export interface AsciiFontProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  /**
   * The string to draw. REQUIRED, where upstream's is optional: a banner with no text renders
   * nothing, and a silently empty element in an authored page reads as a broken render.
   */
  readonly text: string;
  /** Which glyph set to draw with; omitted leaves OpenTUI's `tiny`. */
  readonly font?: AsciiFontName;
  /**
   * The glyph hue; defaults to the theme's `foreground`.
   *
   * DESIGN GAP, RECORDED RATHER THAN GUESSED (CLAUDE.md): the project's design system contains
   * no ASCII-banner screen — `design/*.dc.html` and `design/termcraft-engine.js` have none — so
   * there is no design hue to take. The default is therefore the CATALOG's own established one
   * (`Text` defaults to `foreground` too), not an invented accent.
   *
   * DELIBERATE OMISSION: upstream also accepts an ARRAY of colours for a per-row gradient. §6.1
   * asks for a display-text wrapper, not a gradient API, and nothing in the design system would
   * pick the stops. Adding it later is additive.
   */
  readonly color?: Color;
  /** The fill behind the glyph block. Read one off `useTokens()` (spec §4.5). */
  readonly background?: Color;
}

/**
 * Large ASCII-art display text (design-system §6.1). Renders one OpenTUI `ascii-font` element,
 * sized by the chosen glyph set rather than by width/height props — upstream `Omit`s both
 * (`@opentui/core/renderables/ASCIIFont.d.ts:7`), so wrap it in a `Box` when it needs to be
 * placed or constrained. The mandatory `id` resolves for host geometry: unlike the inline text
 * family, this is a real layout `Renderable`.
 */
export function AsciiFont(props: AsciiFontProps) {
  return (
    <ascii-font
      id={props.id}
      text={props.text}
      font={props.font}
      color={props.color ?? activeTokens().foreground}
      backgroundColor={props.background}
    />
  );
}
