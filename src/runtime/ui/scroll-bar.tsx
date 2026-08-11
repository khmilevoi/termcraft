import type { ScrollBarOptions } from "@opentui/core";

import { wrap } from "../model/reatom";
import { activeTokens } from "../model/tokens";
import type { Color } from "../types";
import { registerRenderableTags } from "./renderable-tags";

// `ScrollBarOptions` (the constructor's options parameter, which is what
// `@opentui/react`'s `ExtendedComponentProps` derives the `<scroll-bar>` JSX prop type from) does
// NOT list `scrollSize`, `viewportSize` or `scrollPosition` — see the wrapper's doc comment below
// for why they are plain property writes rather than constructor options. This LOCAL, NON-EXPORTED
// type is the narrowest fix: it widens the JSX element's prop type by exactly those three fields
// so the write order asserted below type-checks, without leaking `@opentui/core` into any exported
// declaration (§6).
type ScrollBarElementProps = ScrollBarOptions & {
  readonly scrollSize: number;
  readonly viewportSize: number;
  readonly scrollPosition: number;
};

/**
 * Props for the themed `ScrollBar`. `id` is the mandatory stable id (§3.2); `orientation` is
 * REQUIRED by the underlying renderable's constructor, and the scroll state is required because
 * an export snapshot must render it from props rather than from the renderable's own mutable
 * offset (spec §6.3). There is deliberately NO `children`: the renderable is a leaf (spec §6.1's
 * spike).
 */
export interface ScrollBarProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  readonly orientation: "horizontal" | "vertical";
  /** The full scrollable extent, in cells. */
  readonly contentSize: number;
  /** The visible window's extent, in cells. */
  readonly viewportSize: number;
  /** The window's offset into the content, in cells; clamped to `0..contentSize - viewportSize`. */
  readonly position: number;
  /** The track hue. Read one off `useTokens()` (spec §4.5). Defaults to `line`. */
  readonly trackColor?: Color;
  /** The thumb hue. Read one off `useTokens()` (spec §4.5). Defaults to `accentDim`. */
  readonly thumbColor?: Color;
  /** Step arrows at both ends; OFF by default, matching the design's scrollbar. */
  readonly showArrows?: boolean;
  /**
   * The arrow hue when `showArrows` is set. Defaults to `foregroundFaint`.
   *
   * DESIGN GAP, FLAGGED (CLAUDE.md): `design/termcraft-engine.js`'s `scrollbar()` draws its
   * track and thumb only — arrows are OFF unconditionally (its own comment: "Arrows off") — so
   * the design supplies no arrow hue anywhere for this control. `foregroundFaint` is chosen for
   * a case the design does not cover, not read off it.
   */
  readonly arrowColor?: Color;
  readonly width?: number;
  readonly height?: number;
  /** Invoked with the new offset when the bar is dragged; inert in the static render. */
  readonly onScroll?: (position: number) => void;
}

/**
 * A proportional scroll indicator (spec §6.1). Renders the OpenTUI `ScrollBarRenderable` — a
 * renderable with no intrinsic tag, registered by {@link registerRenderableTags} — whose inner
 * track is a `SliderRenderable` drawing a `█`/`▀`/`▄` thumb at half-cell precision.
 *
 * COLOURS AND ARROWS COME FROM THE DESIGN (`design/termcraft-engine.js`'s `scrollbar()`): a track
 * in `line`, a thumb in `amberDim` (the `accentDim` role), arrows off.
 *
 * DIVERGENCE, DOCUMENTED RATHER THAN SUBSTITUTED (CLAUDE.md): the design draws the track as a
 * `│` glyph rule, while `SliderRenderable` paints its track as a solid background fill. The glyph
 * half cannot be reproduced through this renderable, so the closest faithful mapping is used —
 * track BACKGROUND `line`, thumb FOREGROUND `accentDim`.
 *
 * PROP ORDER IS LOAD-BEARING, and this is measured rather than assumed. `scrollSize`,
 * `viewportSize` and `scrollPosition` are not constructor options; `@opentui/react`'s
 * `setInitialProperties` applies them as plain property writes, iterating `for (const propKey in
 * props)` — i.e. in the order written below. `scrollPosition`'s setter clamps against
 * `scrollSize - viewportSize`, so a position written before its bounds would clamp to 0.
 *
 * The same constructor-captured-handler divergence recorded on `./slider.tsx` applies to
 * `onChange` here.
 */
export function ScrollBar(props: ScrollBarProps) {
  registerRenderableTags();
  const tokens = activeTokens();
  const track = props.trackColor ?? tokens.line;
  const onScroll = props.onScroll;
  // Object literal key order IS the write order `setInitialProperties` applies (see the doc
  // comment above): `scrollSize`, then `viewportSize`, then `scrollPosition`, so a clamp against
  // `scrollSize - viewportSize` always sees both bounds already written. Do not reorder.
  const elementProps: ScrollBarElementProps = {
    id: props.id,
    orientation: props.orientation,
    scrollSize: props.contentSize,
    viewportSize: props.viewportSize,
    scrollPosition: props.position,
    width: props.width,
    height: props.height,
    showArrows: props.showArrows ?? false,
    trackOptions: {
      backgroundColor: track,
      foregroundColor: props.thumbColor ?? tokens.accentDim,
    },
    arrowOptions: {
      backgroundColor: track,
      foregroundColor: props.arrowColor ?? tokens.foregroundFaint,
    },
    onChange: onScroll === undefined ? undefined : wrap(onScroll),
  };
  return <scroll-bar {...elementProps} />;
}
