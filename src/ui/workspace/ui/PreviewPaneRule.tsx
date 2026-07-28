export interface PreviewPaneRuleProps {
  readonly id: string;
  /** The pane's inner content width in cells — `previewRegionSize(...).w`. */
  readonly width: number;
  /**
   * The rule's hue — design `paneShell` draws it in `pbf`, whatever hue the caller passed as
   * the pane's own border (`design/termcraft-engine.js:479`: `const pbf = o.prevBorderFg ||
   * P.border`; `:485`: `hline(b, px0+1, 2, pw-2, {fg:pbf})`). The one screen that varies it,
   * `wsFocus` (`:801`: `prevBorderFg: cf ? P.line : P.amber`), uses the same composer-focus
   * switch `Workspace.tsx` already applies to the pane's own `borderColor` — so the caller
   * passes that SAME value here rather than this component picking its own colour, which is
   * what keeps the rule from drifting out of step with the border it sits inside.
   */
  readonly color: `#${string}`;
}

/**
 * The rule separating the preview pane's tab strip from the design area (design `paneShell`,
 * `design/termcraft-engine.js:485`: `hline(b, px0+1, 2, pw-2)` in the pane's border hue).
 *
 * DIVERGENCE (documented, same class as this pane's existing frame-junction note in
 * `Workspace.tsx`): the design also welds the rule into the pane's own border with `├`/`┤`
 * tees at `px0` and `px0+pw-1`. Those two cells belong to the border columns, which an
 * OpenTUI flex child cannot reach — a child is laid out strictly inside the border box. The
 * closest faithful mapping is the rule itself, spanning the full content width, in the same
 * hue; the tees are not substituted with anything invented.
 */
export function PreviewPaneRule(props: PreviewPaneRuleProps) {
  return (
    <text id={props.id} fg={props.color}>
      {"─".repeat(Math.max(0, props.width))}
    </text>
  );
}
