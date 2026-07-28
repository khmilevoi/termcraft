import { SHELL_PALETTE } from "ui/theme";

export interface PreviewPaneRuleProps {
  readonly id: string;
  /** The pane's inner content width in cells — `previewRegionSize(...).w`. */
  readonly width: number;
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
    <text id={props.id} fg={SHELL_PALETTE.amber}>
      {"─".repeat(Math.max(0, props.width))}
    </text>
  );
}
