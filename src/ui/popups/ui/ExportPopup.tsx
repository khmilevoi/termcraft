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

/** Props for the {@link ExportFailurePopup} export-failure popup. */
export interface ExportFailurePopupProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  /** The page the export was working on when it failed, or `null` if none was reached yet. */
  readonly pageSlug: string | null;
  /** Bytes written so far, or `null` if none was reached yet (both retained from the last
   * `export.progress` — the terminal payload itself carries neither, ui/mirror `ExportMirror`). */
  readonly sizeBytes: number | null;
  /** The failure's bounded `FailureDtoV1.safeMessage`. */
  readonly safeMessage: string;
}

/**
 * The export-failure popup — a design gap: `design/13-export-feedback.dc.html` (`wsExport`)
 * only mocks the success confirmation, no failed-export screen exists. This is the closest
 * faithful mapping: the same "export ^E" popup frame as {@link ExportPopup}, using the red
 * error-band vocabulary already established for failures (`ErrorPanel`, `SHELL_PALETTE.red`)
 * instead of inventing a new pattern, and the same "⏎ ok" dismiss line.
 */
export function ExportFailurePopup(props: ExportFailurePopupProps) {
  const headline =
    props.pageSlug === null ? "✗ export failed" : `✗ export failed ${props.pageSlug}`;
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
      <text id={`${props.id}-headline`} fg={SHELL_PALETTE.red} attributes={BOLD}>
        {headline}
      </text>
      {props.sizeBytes !== null && (
        <text id={`${props.id}-size`} fg={SHELL_PALETTE.dim}>
          {`${props.sizeBytes} bytes`}
        </text>
      )}
      <text id={`${props.id}-message`} fg={SHELL_PALETTE.faint}>
        {props.safeMessage}
      </text>
      <text id={`${props.id}-dismiss`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
        {"⏎ ok"}
      </text>
    </box>
  );
}
