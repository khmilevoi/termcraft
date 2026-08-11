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
  /**
   * Stable id the shell keys on. Mandatory on every catalog component — see the module note: an
   * inline id is stable and part of the export vocabulary, but it is NOT addressable by the
   * host's geometry queries.
   */
  readonly id: string;
  /** Literal text, or further inline wrappers. */
  readonly children?: unknown;
  /**
   * The run's hue. Omitted, it INHERITS the enclosing `Text`'s colour (which itself defaults to
   * the theme's `foreground`) — OpenTUI merges text-node styles down the chain, so a `Span`
   * inside a red `Text` is red. Read one off `useTokens()` (spec §4.5).
   */
  readonly color?: Color;
}

/**
 * An inline run of text inside a `Text` (design-system §6.1). Its only styling is a hue — for
 * weight, slant or underline, wrap it in `Bold`, `Italic` or `Underline`. Must be nested in a
 * `Text`; on its own it has no container to attach to.
 */
export function Span(props: SpanProps) {
  return (
    <span id={props.id} fg={props.color}>
      {props.children}
    </span>
  );
}

/** Props for the inline `Bold`. `id` is the mandatory stable id (§3.2). */
export interface BoldProps {
  /**
   * Stable id the shell keys on. Mandatory on every catalog component — see the module note: an
   * inline id is stable and part of the export vocabulary, but it is NOT addressable by the
   * host's geometry queries.
   */
  readonly id: string;
  /** Literal text, or further inline wrappers. */
  readonly children?: unknown;
  /**
   * The run's hue. Omitted, it INHERITS the enclosing `Text`'s colour (which itself defaults to
   * the theme's `foreground`) — OpenTUI merges text-node styles down the chain, so a `Span`
   * inside a red `Text` is red. Read one off `useTokens()` (spec §4.5).
   */
  readonly color?: Color;
}

/**
 * A bold inline run inside a `Text` (design-system §6.1). The weight comes from the intrinsic
 * itself — `@opentui/react`'s `b` renderable ORs `TextAttributes.BOLD` into the run — so nesting
 * `Bold` inside `Italic` combines both rather than replacing one.
 */
export function Bold(props: BoldProps) {
  return (
    <b id={props.id} fg={props.color}>
      {props.children}
    </b>
  );
}

/** Props for the inline `Italic`. `id` is the mandatory stable id (§3.2). */
export interface ItalicProps {
  /**
   * Stable id the shell keys on. Mandatory on every catalog component — see the module note: an
   * inline id is stable and part of the export vocabulary, but it is NOT addressable by the
   * host's geometry queries.
   */
  readonly id: string;
  /** Literal text, or further inline wrappers. */
  readonly children?: unknown;
  /**
   * The run's hue. Omitted, it INHERITS the enclosing `Text`'s colour (which itself defaults to
   * the theme's `foreground`) — OpenTUI merges text-node styles down the chain, so a `Span`
   * inside a red `Text` is red. Read one off `useTokens()` (spec §4.5).
   */
  readonly color?: Color;
}

/**
 * An italic inline run inside a `Text` (design-system §6.1). The slant comes from the intrinsic
 * (`TextAttributes.ITALIC`); whether the terminal actually renders italics is the terminal's
 * choice, and the attribute is carried into the export snapshot either way.
 */
export function Italic(props: ItalicProps) {
  return (
    <i id={props.id} fg={props.color}>
      {props.children}
    </i>
  );
}

/** Props for the inline `Underline`. `id` is the mandatory stable id (§3.2). */
export interface UnderlineProps {
  /**
   * Stable id the shell keys on. Mandatory on every catalog component — see the module note: an
   * inline id is stable and part of the export vocabulary, but it is NOT addressable by the
   * host's geometry queries.
   */
  readonly id: string;
  /** Literal text, or further inline wrappers. */
  readonly children?: unknown;
  /**
   * The run's hue. Omitted, it INHERITS the enclosing `Text`'s colour (which itself defaults to
   * the theme's `foreground`) — OpenTUI merges text-node styles down the chain, so a `Span`
   * inside a red `Text` is red. Read one off `useTokens()` (spec §4.5).
   */
  readonly color?: Color;
}

/**
 * An underlined inline run inside a `Text` (design-system §6.1). The rule comes from the
 * intrinsic (`TextAttributes.UNDERLINE`), not from a drawn glyph, so it never consumes a row.
 */
export function Underline(props: UnderlineProps) {
  return (
    <u id={props.id} fg={props.color}>
      {props.children}
    </u>
  );
}

/** Props for the inline `Link`. `id` is the mandatory stable id (§3.2). */
export interface LinkProps {
  /**
   * Stable id the shell keys on. Mandatory on every catalog component — see the module note: an
   * inline id is stable and part of the export vocabulary, but it is NOT addressable by the
   * host's geometry queries.
   */
  readonly id: string;
  /** The link target, emitted as a terminal hyperlink. Required: a link with no target is text. */
  readonly href: string;
  /** The label; literal text, or further inline wrappers. */
  readonly children?: unknown;
  /**
   * The label's hue. Omitted, it INHERITS the enclosing `Text`'s colour (which itself defaults
   * to the theme's `foreground`) — OpenTUI merges text-node styles down the chain, so a `Link`
   * inside a red `Text` is red. Read one off `useTokens()` (spec §4.5).
   */
  readonly color?: Color;
}

/**
 * A terminal hyperlink inside a `Text` (design-system §6.1). The label renders as ordinary
 * inline text; `href` becomes the run's hyperlink target in terminals that support it.
 *
 * DESIGN GAP, RECORDED RATHER THAN GUESSED (CLAUDE.md): the design system defines no distinct
 * link hue, so an omitted `color` inherits the enclosing `Text`'s hue like every other inline
 * run instead of inventing one — pass `color={t.accent}` for the conventional highlighted link.
 *
 * DIVERGENCE: a hyperlink TARGET is not observable in a captured frame. `StyledRun`
 * (`src/host/protocol/types.ts:77-83`) carries text, colours and attributes and has no link
 * field, so an export snapshot preserves the label and drops the target. The tests assert the
 * label and its hue for exactly that reason.
 */
export function Link(props: LinkProps) {
  return (
    <a id={props.id} href={props.href} fg={props.color}>
      {props.children}
    </a>
  );
}

/** Props for the inline `LineBreak`. `id` is the mandatory stable id (§3.2) and its only prop. */
export interface LineBreakProps {
  /**
   * Stable id the shell keys on. Mandatory, with no exception carved for this element: `id` is
   * the ENTIRE prop surface the `br` intrinsic has (`LineBreakProps = Pick<SpanProps, "id">`,
   * `@opentui/react/src/types/components.d.ts:37`), and spec §6 states the rule without
   * exception — see the module note: an inline id is stable and part of the export vocabulary,
   * but it is NOT addressable by the host's geometry queries.
   */
  readonly id: string;
}

/**
 * A hard line break inside a `Text` (design-system §6.1). Takes no children and no styling — the
 * intrinsic emits a newline and nothing else. Use it to split one `Text` across rows without
 * paying for a second container.
 */
export function LineBreak(props: LineBreakProps) {
  return <br id={props.id} />;
}
