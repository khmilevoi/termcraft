import { parseColor } from "@opentui/core";
import type { FrameBufferRenderable, OptimizedBuffer } from "@opentui/core";

import { wrap } from "../model/reatom";
import type { Color } from "../types";
import { registerRenderableTags } from "./renderable-tags";

/**
 * The cell surface a `FrameBuffer`'s `draw` callback paints into (spec §6.1's "raw drawing …
 * the last escape hatch"). Every colour is a `Color` value read off `useTokens()`; the
 * underlying `OptimizedBuffer` is never handed out, so a page cannot reach the renderer.
 * Coordinates are buffer-local, origin top-left; a write outside the buffer is DROPPED.
 */
export interface FrameBufferSurface {
  /** The buffer's width in cells — the `width` prop. */
  readonly width: number;
  /** The buffer's height in cells — the `height` prop. */
  readonly height: number;
  /** Fill the whole buffer with one hue. */
  clear(color: Color): void;
  /**
   * Paint one cell.
   *
   * ASYMMETRY WITH {@link drawText}, DOCUMENTED (CLAUDE.md): an omitted `background` here
   * defaults to the OPAQUE {@link TRANSPARENT} constant, which ERASES whatever a prior
   * `clear()` painted at that cell. `drawText`'s omitted `background` instead defaults to
   * `undefined`, which PRESERVES it. The difference is forced by the vendor FFI, not a choice
   * made here: `OptimizedBuffer.setCell` takes a required `rgbaPtr` for its background
   * argument, while `drawText` takes an `optionalRgbaPtr` that can mean "leave it alone" — see
   * `createSurface`'s call sites below.
   */
  setCell(x: number, y: number, glyph: string, color: Color, background?: Color): void;
  /**
   * Paint a run of text starting at `x`,`y`. An omitted `background` PRESERVES whatever is
   * already there — see {@link setCell}'s doc comment for why the two methods differ here.
   */
  drawText(text: string, x: number, y: number, color: Color, background?: Color): void;
  /** Fill a rectangle with one hue. */
  fillRect(x: number, y: number, width: number, height: number, color: Color): void;
}

/** Props for the low-level `FrameBuffer`. `id` is the mandatory stable id (§3.2). */
export interface FrameBufferProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  /** Buffer width in cells. REQUIRED by the underlying renderable (spec §6.1's spike). */
  readonly width: number;
  /** Buffer height in cells. REQUIRED by the underlying renderable (spec §6.1's spike). */
  readonly height: number;
  /**
   * Paints the buffer. REQUIRED: the renderable renders NOTHING until it is drawn into (spec
   * §6.1's spike), so an optional `draw` would make the blank render the default.
   */
  readonly draw: (surface: FrameBufferSurface) => void;
}

/** The transparent fill the surface uses when a caller gives no background. */
const TRANSPARENT = parseColor("transparent");

/**
 * Wrap one live `OptimizedBuffer` in the `Color`-typed, bounds-checked surface. Non-exported:
 * the buffer type must not reach the facade's surface (spec §6).
 */
function createSurface(buffer: OptimizedBuffer, width: number, height: number): FrameBufferSurface {
  const inside = (x: number, y: number): boolean =>
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height;
  return {
    width,
    height,
    clear(color) {
      buffer.clear(parseColor(color));
    },
    setCell(x, y, glyph, color, background) {
      // Bounds-checked here rather than trusting the native buffer to clip: an out-of-range
      // write is a page's bug, and dropping it keeps the frame deterministic either way.
      if (!inside(x, y)) return;
      buffer.setCell(
        x,
        y,
        glyph,
        parseColor(color),
        background === undefined ? TRANSPARENT : parseColor(background),
      );
    },
    drawText(text, x, y, color, background) {
      if (!inside(x, y)) return;
      buffer.drawText(
        text,
        x,
        y,
        parseColor(color),
        background === undefined ? undefined : parseColor(background),
      );
    },
    fillRect(x, y, rectWidth, rectHeight, color) {
      if (!inside(x, y)) return;
      buffer.fillRect(
        x,
        y,
        Math.min(rectWidth, width - x),
        Math.min(rectHeight, height - y),
        parseColor(color),
      );
    },
  };
}

/**
 * A raw cell buffer for bespoke graphics — spec §6.1's "last escape hatch". Renders the OpenTUI
 * `FrameBufferRenderable`, a renderable with no intrinsic tag, registered by
 * {@link registerRenderableTags}.
 *
 * HOW `draw` REACHES THE BUFFER, and why a `ref` is used INTERNALLY. The renderable exposes its
 * buffer only as an instance field and renders nothing until something paints into it (spec
 * §6.1's spike), so an instance handle is the only path. §6 forbids PASSING `ref` through to an
 * authored page, which this does not do: the callback ref below is termcraft's own, the page sees
 * only {@link FrameBufferSurface}, and the renderable never escapes. Because the inline callback's
 * identity changes on every render, React re-invokes it on every re-render, so a theme change
 * repaints the buffer.
 *
 * DETERMINISM (spec §6.3): the whole rendered state is a pure function of `draw`, `width` and
 * `height`, with no internal offset, focus or selection — so the export frame equals the preview
 * frame for the same props, which is what `./frame-buffer.test.tsx` asserts.
 */
export function FrameBuffer(props: FrameBufferProps) {
  registerRenderableTags();
  const draw = wrap(props.draw);
  return (
    <frame-buffer
      id={props.id}
      width={props.width}
      height={props.height}
      ref={(instance: FrameBufferRenderable | null): void => {
        if (instance === null) return;
        draw(createSurface(instance.frameBuffer, props.width, props.height));
      }}
    />
  );
}
