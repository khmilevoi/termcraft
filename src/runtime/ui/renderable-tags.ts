import {
  FrameBufferRenderable,
  ScrollBarRenderable,
  SliderRenderable,
  TextTableRenderable,
} from "@opentui/core";
import { extend } from "@opentui/react";

// The one-time `extend({…})` registration for the four OpenTUI renderables that ship with no
// intrinsic JSX tag (spec §6.1). termcraft calls this on ITS OWN side; an authored page never
// sees `extend()` and never names an `@opentui/*` identity. The prop types the four tags check
// against come from the paired `./renderable-tags.augmentation.d.ts` — read its header for why
// the augmentation is a separate file.
//
// TAG NAMES follow OpenTUI's own intrinsic vocabulary (`ascii-font`, `tab-select`,
// `line-number`): kebab-case, unprefixed. They exist only inside `src/runtime/ui/`.

let registered = false;

/**
 * Register the four tagless renderables as JSX tags. Idempotent, and called as the FIRST
 * statement of each wrapper's component body rather than at module scope: React runs a component
 * function during render and creates its host instances during commit, so a call in the body is
 * provably ordered before the reconciler looks the tag up in `getComponentCatalogue()`, without
 * making `src/runtime/ui/*` import-order-sensitive.
 */
export function registerRenderableTags(): void {
  if (registered) return;
  registered = true;
  extend({
    slider: SliderRenderable,
    "scroll-bar": ScrollBarRenderable,
    "text-table": TextTableRenderable,
    "frame-buffer": FrameBufferRenderable,
  });
}
