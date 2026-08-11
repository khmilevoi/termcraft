import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/**
 * THE INLINE TEXT FAMILY (spec §6.1). Six wrappers over OpenTUI's text-node intrinsics —
 * `span`, `b`, `i`, `u`, `a`, `br` — kept in ONE module because they share one contract that
 * has to be stated once and obeyed by all of them:
 *
 *  - **They are only valid inside a `Text`.** Each renders a `TextNodeRenderable`
 *    (`@opentui/core/renderables/TextNode.d.ts:17`), which is not a layout renderable and has no
 *    container of its own; a `Text` is what holds them. `TextProps.children` is widened to accept
 *    them.
 *  - **Their `id` is mandatory but NOT host-addressable.** `TextNodeRenderable` extends
 *    `BaseRenderable` — no Yoga node, no screen rect — and the host's `rectOf`/`checkHit` walk
 *    `Renderable.findDescendantById` (`@opentui/core/Renderable.d.ts:187`), which never reaches a
 *    text node. DIVERGENCE, DOCUMENTED RATHER THAN SILENTLY DROPPED (CLAUDE.md): the id is
 *    carried, stable, and part of the authored-page contract spec §6 states without exception,
 *    but the shell cannot select or pin an inline run today. `ui/inline.test.tsx` pins that fact.
 *  - **Weight, slant and underline are the dedicated wrappers, not `Span` flags.** Two spellings
 *    for one effect is what §4.5 removed from the colour model; one spelling is kept here.
 *  - **No background prop in this stage.** `Text` has none either, and splitting the text
 *    vocabulary for `Span` alone would cost more than it buys. Adding it later is additive.
 */

/** Props for the inline `Span`. `id` is the mandatory stable id (§3.2). */
export interface SpanProps {
  /** Stable id the shell keys on. Mandatory on every catalog component — see the module note. */
  readonly id: string;
  /** Literal text, or further inline wrappers. */
  readonly children?: unknown;
  /** The run's hue; defaults to the theme's `foreground`. Read one off `useTokens()` (spec §4.5). */
  readonly color?: Color;
}

/**
 * An inline run of text inside a `Text` (design-system §6.1). Its only styling is a hue — for
 * weight, slant or underline, wrap it in `Bold`, `Italic` or `Underline`. Must be nested in a
 * `Text`; on its own it has no container to attach to.
 */
export function Span(props: SpanProps) {
  return (
    <span id={props.id} fg={props.color ?? activeTokens().foreground}>
      {props.children}
    </span>
  );
}
