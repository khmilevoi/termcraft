import { SHELL_PALETTE, shellAttrs } from "ui/theme";

/** Props for the {@link ExportPopup} export-feedback popup. */
export interface ExportPopupProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  /** e.g. "system-monitor" — the exported project's name. */
  readonly projectName: string;
  /** Output path lines, e.g. ".termcraft/export/design-prompt.md". */
  readonly paths: readonly string[];
  /** e.g. "reads current page.tsx on disk · incl uncommitted". */
  readonly caveat: string;
}

const BOLD = shellAttrs({ bold: true });

/**
 * The export-feedback popup (design `wsExport`, `design/13-export-feedback.dc.html`) —
 * a quiet confirmation shown after Ctrl+E: what was written and where, dismissed with
 * "⏎ ok". Not a wizard, no multi-step flow. This component renders only the box itself;
 * the dimmed backdrop behind it (the design mock actually leaves the workspace at full
 * contrast for this screen) is the App's concern, not this popup's.
 *
 * divergence: the design (`wsExport`, engine.js:634) colors the first path line
 * `P.fg` and only the remaining ones `P.dim`. Per this component's spec, all path
 * lines render `P.dim` uniformly for MVP simplicity.
 */
export function ExportPopup(props: ExportPopupProps) {
  return (
    <box
      id={props.id}
      border
      borderStyle="rounded"
      borderColor={SHELL_PALETTE.amber}
      title="export ^E"
      titleColor={SHELL_PALETTE.amberHi}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
      padding={0}
    >
      <text id={`${props.id}-success`} fg={SHELL_PALETTE.green} attributes={BOLD}>
        {`✓ exported ${props.projectName}`}
      </text>
      {props.paths.map((path, index) => (
        // keyed intrinsic wrapper — function components carry no `key` in this
        // repo's no-@types/react environment; the text takes it instead.
        <text
          key={`${props.id}-path-${index}`}
          id={`${props.id}-path-${index}`}
          fg={SHELL_PALETTE.dim}
        >
          {path}
        </text>
      ))}
      <text id={`${props.id}-caveat`} fg={SHELL_PALETTE.faint}>
        {props.caveat}
      </text>
      <text id={`${props.id}-dismiss`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
        {"⏎ ok"}
      </text>
    </box>
  );
}
