import { isExport } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/** Props for the `ScrollBox` scrolling viewport. `id` is the mandatory stable id (§3.2). */
export interface ScrollBoxProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  readonly children?: unknown;
  /** Content axis, and therefore the scrolling axis. Defaults to `column`. */
  readonly direction?: "row" | "column";
  /** Gap between the content's children. */
  readonly gap?: number;
  /** Inner padding around the content. */
  readonly padding?: number;
  /** Flex grow factor of the viewport itself. */
  readonly grow?: number;
  readonly width?: number;
  /** Viewport height in rows. A viewport shorter than its content is the point. */
  readonly height?: number;
  readonly border?: boolean;
  /** The frame hue; defaults to the theme's `border`. Read one off `useTokens()` (§4.5). */
  readonly borderColor?: Color;
  /** The viewport fill; defaults to the theme's `background`. Read one off `useTokens()`. */
  readonly background?: Color;
  /** Whether the viewport holds keyboard focus. Always false under export (§6.3). */
  readonly focused?: boolean;
  /**
   * Pin the viewport to the NEWEST content — the design's chat-scroll "following" state
   * (`design/termcraft-engine.js:1474-1495`, §28). IGNORED UNDER EXPORT (§6.3): a snapshot is
   * always taken at offset 0.
   */
  readonly follow?: boolean;
}

/**
 * A scrolling viewport (design-system §3.2, spec §6.1). Renders one OpenTUI `<scrollbox>`: a
 * fixed-size frame over content taller (or wider) than itself, with a proportional scrollbar
 * themed to the design's §28 recipe — a track in `line` and a thumb in `accentDim`, arrows off
 * (`design/termcraft-engine.js:1478-1483`); this is a REAL DESIGN FACT, drawn there. A focused
 * frame is drawn in `accentHi`, the hue the design's own palette legend labels `focus`
 * (`design/termcraft-engine.js:1876`) — but the design ships no screen of an authored page's
 * focused scroll frame, so `focusedBorderColor = accentHi` is a MAPPING onto existing vocabulary,
 * recorded here rather than invented as a new hue.
 *
 * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED: the design's thumb is `█` with `▀`/`▄` at
 * half-cell precision, drawn by the engine itself. OpenTUI's `SliderRenderable` draws its own
 * glyphs and exposes only two colours, so this wrapper reproduces the HUES and the arrows-off
 * rule and not the half-cell thumb.
 *
 * NO SCROLL-OFFSET PROP, AND NO SCROLL CALLBACK. `ScrollBoxOptions` carries neither: `scrollTop`
 * exists only as a class setter, and the scrollbars' own `onChange` is overwritten by
 * `ScrollBoxRenderable`'s constructor after the caller's spread. Position is therefore expressed
 * declaratively, through `follow`, which is the design's own vocabulary for it.
 *
 * EXPORT DETERMINISM (§6.3): under `hostMode === "export"` the viewport is pinned to the START
 * edge — offset 0 — whatever `follow` says, and the frame is blurred with its focused hue
 * collapsed onto the unfocused one.
 */
export function ScrollBox(props: ScrollBoxProps) {
  const tokens = activeTokens();
  const exporting = isExport();
  const horizontal = props.direction === "row";
  const frameColor = props.borderColor ?? tokens.border;
  // §6.3: sticky at the START edge under export pins the offset to 0 POSITIVELY, rather than
  // relying on a fresh instance happening to begin there.
  const startEdge = horizontal ? "left" : "top";
  const newestEdge = horizontal ? "right" : "bottom";
  const following = props.follow === true;
  return (
    <scrollbox
      id={props.id}
      width={props.width}
      height={props.height}
      flexGrow={props.grow}
      border={props.border}
      borderStyle="rounded"
      borderColor={frameColor}
      focusedBorderColor={exporting ? frameColor : tokens.accentHi}
      backgroundColor={props.background ?? tokens.background}
      focused={exporting ? false : props.focused}
      scrollX={horizontal}
      scrollY={!horizontal}
      stickyScroll={exporting ? true : following}
      stickyStart={exporting ? startEdge : following ? newestEdge : undefined}
      contentOptions={{
        flexDirection: props.direction ?? "column",
        gap: props.gap,
        padding: props.padding,
      }}
      scrollbarOptions={{
        showArrows: false,
        trackOptions: { backgroundColor: tokens.line, foregroundColor: tokens.accentDim },
      }}
    >
      {props.children}
    </scrollbox>
  );
}
