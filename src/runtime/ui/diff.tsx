import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/** Props for the themed `Diff` view. `id` is the mandatory stable id (§3.2). */
export interface DiffProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string;
  /**
   * The change to render, as ONE unified diff (a `--- / +++ / @@` patch). Only the first patch
   * in the string is rendered. An empty or unparseable value renders nothing rather than failing.
   */
  readonly patch: string;
  /** `unified` stacks the two sides, `split` puts them side by side. Defaults to `unified`. */
  readonly view?: "unified" | "split";
  /** Whether to draw the line-number gutters. Defaults to off. */
  readonly showLineNumbers?: boolean;
  /** How over-long lines break; defaults to the renderer's own wrapping. */
  readonly wrap?: "word" | "char" | "none";
  /** The content hue; defaults to the theme's `foreground`. */
  readonly color?: Color;
  /** The gutter digits' hue; defaults to the theme's `foregroundFaint`. */
  readonly lineNumberColor?: Color;
  /** The `+` sign's hue; defaults to the theme's `success`. */
  readonly addedColor?: Color;
  /** The `-` sign's hue; defaults to the theme's `danger`. */
  readonly removedColor?: Color;
  /**
   * The band behind an added line. Defaults to the theme's `background` — i.e. NO band; see the
   * component's own note on why, and supply a project token here to paint one.
   */
  readonly addedBackground?: Color;
  /** The band behind a removed line. Defaults to the theme's `background` — i.e. NO band. */
  readonly removedBackground?: Color;
}

/**
 * A themed unified/split diff view (design-system §6.1, the "Documents and code" group). Takes
 * one unified `patch` string and renders it with `+`/`-` signs, optional line-number gutters, and
 * every colour resolved from the active theme. The mandatory `id` flows to the element so the
 * host can answer geometry queries and the shell can select/pin it.
 *
 * DEGRADATION, NOT FAILURE. An empty patch, or a string that is not a patch at all, renders an
 * empty frame; nothing throws. A patch whose hunk header disagrees with its body renders the
 * renderer's own parse-error message instead of the diff — a divergence recorded here because the
 * message is drawn in the renderer's own red, which is not a theme colour and cannot be
 * overridden through any prop.
 *
 * COLOURS, AND THE ONE GAP. `color`/`lineNumberColor`/`addedColor`/`removedColor` default to the
 * theme's `foreground`/`foregroundFaint`/`success`/`danger` — the design's own vocabulary, where
 * green marks the live/resolved/positive and red the failed/negative.
 *
 * The row BACKGROUNDS are the gap. The design system carries no diff view at all: it paints no
 * green band anywhere, and the only red band it paints is the failure strip (`danger` on
 * `dangerDim`), which means something else. Rather than invent a diff palette, this component
 * carries the semantics on the signs and leaves both rows on the ordinary `background` — and
 * exposes `addedBackground`/`removedBackground` so a project whose own design system declares
 * diff hues can supply them. Passing the theme background EXPLICITLY is also what keeps
 * `@opentui/core`'s hard-coded `#1a4d1a`/`#4d1a1a` bands out of an authored page.
 *
 * Selection colours are passed from the theme but are not props: selection is host-driven chrome,
 * not page styling. The syntax-highlighting client is never exposed (spec §6).
 */
export function Diff(props: DiffProps) {
  const tokens = activeTokens();
  // EVERY colour is passed. A prop left undefined is not "inherit" — `@opentui/core` substitutes
  // a hard-coded hue of its own (#888888 gutter, #22c55e/#ef4444 signs, #1a4d1a/#4d1a1a bands),
  // which would put an off-palette colour into an authored page. Tests beside this file assert
  // none of those five reaches a frame.
  const background = tokens.background;
  return (
    <diff
      id={props.id}
      diff={props.patch}
      view={props.view ?? "unified"}
      showLineNumbers={props.showLineNumbers ?? false}
      wrapMode={props.wrap}
      fg={props.color ?? tokens.foreground}
      lineNumberFg={props.lineNumberColor ?? tokens.foregroundFaint}
      lineNumberBg={background}
      addedSignColor={props.addedColor ?? tokens.success}
      removedSignColor={props.removedColor ?? tokens.danger}
      addedBg={props.addedBackground ?? background}
      removedBg={props.removedBackground ?? background}
      contextBg={background}
      addedLineNumberBg={background}
      removedLineNumberBg={background}
      selectionBg={tokens.selection}
      selectionFg={tokens.selectionFg}
    />
  );
}
