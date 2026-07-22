import { SHELL_PALETTE, shellAttrs } from "ui/theme";

/** Props for the {@link TrustPrompt} workspace-trust popup. */
export interface TrustPromptProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  /** The project folder path shown under the prompt copy, e.g. "/home/user/my-project". */
  readonly folder: string;
}

const BOLD = shellAttrs({ bold: true });

/**
 * The workspace-trust prompt (design spec §3.1). Shown before any design code
 * executes for a `.termcraft/` this machine has not trusted yet — "designs in
 * this project are code and will run; trust this folder?" Enter trusts and
 * enables execution/preview; Esc completes open as ready but read-only (chat
 * and history stay visible, execution and preview stay disabled).
 *
 * divergence: no design mock (`design/*.dc.html`) covers this popup — GAP noted
 * in the phase-7 map. Layout and copy follow spec §3.1 verbatim, styled as a
 * centered rounded amber box matching the other popups' vocabulary (title in
 * `amberHi`, background painted so it reads over the dimmed backdrop the App
 * renders separately — this component renders only the box itself).
 */
export function TrustPrompt(props: TrustPromptProps) {
  return (
    <box
      id={props.id}
      border
      borderStyle="rounded"
      borderColor={SHELL_PALETTE.amber}
      title="trust"
      titleColor={SHELL_PALETTE.amberHi}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
      padding={1}
    >
      <text id={`${props.id}-body`} fg={SHELL_PALETTE.fg}>
        designs in this project are code and will run;
      </text>
      <text id={`${props.id}-question`} fg={SHELL_PALETTE.amberHi} attributes={BOLD}>
        trust this folder?
      </text>
      <text id={`${props.id}-folder`} fg={SHELL_PALETTE.dim}>
        {props.folder}
      </text>
      <box id={`${props.id}-affordance`} flexDirection="row" marginTop={1}>
        <text id={`${props.id}-trust`} fg={SHELL_PALETTE.green} attributes={BOLD}>
          ⏎ trust
        </text>
        <text id={`${props.id}-sep`} fg={SHELL_PALETTE.faint}>
          {"  ·  "}
        </text>
        <text id={`${props.id}-readonly`} fg={SHELL_PALETTE.red} attributes={BOLD}>
          esc read-only
        </text>
      </box>
    </box>
  );
}
