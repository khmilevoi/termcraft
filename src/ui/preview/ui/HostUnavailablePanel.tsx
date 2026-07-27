import { wrapText } from "ui/chat";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import { hostFailurePhrase } from "../model/host-failure-phrase";

/** Props for the {@link HostUnavailablePanel} surface. */
export interface HostUnavailablePanelProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly pageSlug: string;
  /** The failing incarnation's own code, shown raw — the stable thing a user can quote. */
  readonly failureCode: string | undefined;
  /** The host's bounded message. Empty/absent draws no gutter at all, so nothing looks withheld. */
  readonly hostMessage: string;
  /** How many host incarnations were started: 4 for a spent budget, 1 for a deterministic failure. */
  readonly attempts: number;
  readonly retryAvailable: boolean;
}

const BOLD = shellAttrs({ bold: true });

/** The design's block is `min(dw-6, 68)` with a 10-column label gutter (`wsHostUnavailable`). */
const BLOCK_MAX_WIDTH = 68;
const BLOCK_PADDING = 3;
const LABEL_COLUMN = 10;

/**
 * The preview-region panel for a host that never got as far as running the design (design
 * `wsHostUnavailable`, `design/12-errors-edge-states.dc.html`'s `ws-host-unavailable-120` and
 * `ws-host-unavailable-noretry-120`).
 *
 * DISTINCT FROM `HostCrashPanel`, which is the same end state reached the other way. That one
 * says the design threw and offers `F6` to have the agent repair it. Here the design was never
 * run, so the design draws three distinctions that survive this frame alone: the title reads
 * `preview host · unavailable`, a green `✓` line explicitly CLEARS the page of blame so a reader
 * does not go edit a file that is fine, and the status mode chip reads ` NO HOST ` rather than
 * ` HALTED `. `F6` is not named at all — no page edit makes a temp directory writable.
 *
 * Every phrase comes from the design's own closed table (`hostFailurePhrase`); this component
 * writes no prose of its own.
 */
export function HostUnavailablePanel(props: HostUnavailablePanelProps) {
  const blockWidth = Math.min(Math.max(props.width - 6, 1), BLOCK_MAX_WIDTH);
  const contentWidth = Math.max(blockWidth - 2 - BLOCK_PADDING * 2, 1);
  // The design wraps the runtime message at `cwid = bw-6-col`, i.e. inside the label column.
  const message = props.hostMessage.trim();
  const messageLines =
    message.length === 0 ? [] : wrapText(message, Math.max(contentWidth - LABEL_COLUMN, 1));
  const starts = Math.max(props.attempts, 1);
  const restarts = Math.max(starts - 1, 0);
  const keyFg = props.retryAvailable ? SHELL_PALETTE.amber : SHELL_PALETTE.faint;
  const labelFg = props.retryAvailable ? SHELL_PALETTE.amberHi : SHELL_PALETTE.faint;
  const noteFg = props.retryAvailable ? SHELL_PALETTE.dim : SHELL_PALETTE.faint;

  return (
    <box
      id={props.id}
      width={props.width}
      height={props.height}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      {/* DIVERGENCE 1, closest faithful mapping: the engine positions this block by computed cell
          coordinates; a flex column centred in the pane is the nearest OpenTUI equivalent — the
          same note `HostCrashPanel` and `ErrorPanel` already carry. */}
      <box
        id={`${props.id}-block`}
        border
        borderColor={SHELL_PALETTE.red}
        title="preview host · unavailable"
        titleColor={SHELL_PALETTE.red}
        backgroundColor={SHELL_PALETTE.bg}
        width={blockWidth}
        flexDirection="column"
        paddingLeft={BLOCK_PADDING}
        paddingRight={BLOCK_PADDING}
        paddingTop={1}
        paddingBottom={1}
      >
        <text id={`${props.id}-headline`} fg={SHELL_PALETTE.red} attributes={BOLD}>
          ✗ preview host unavailable — your design was never run
        </text>
        {/* ONE wrapping `<text>` with two spans, not a flex row of two `<text>`s: the design
            draws this as a single unwrapped line, which fits its own 4-character `main` but
            clips at a longer slug. A row of text items would wrap into two narrow columns
            (`ChatRecord`'s own note); spans keep it one flow, so a long slug pushes the tail
            onto a second line instead of losing it. */}
        <text id={`${props.id}-cleared`} fg={SHELL_PALETTE.dim} wrapMode="word">
          <span id={`${props.id}-cleared-mark`} fg={SHELL_PALETTE.green}>
            ✓
          </span>
          <span id={`${props.id}-cleared-text`} fg={SHELL_PALETTE.dim}>
            {` ${props.pageSlug} · unchanged and not implicated — nothing to fix here`}
          </span>
        </text>
        <text id={`${props.id}-spacer-1`}> </text>
        <box id={`${props.id}-failure`} flexDirection="row">
          <text id={`${props.id}-failure-label`} fg={SHELL_PALETTE.dim}>
            {"failure".padEnd(LABEL_COLUMN)}
          </text>
          <text id={`${props.id}-failure-code`} fg={SHELL_PALETTE.fg} attributes={BOLD}>
            {props.failureCode ?? "UNKNOWN"}
          </text>
        </box>
        <box id={`${props.id}-phrase-row`} flexDirection="row">
          <text id={`${props.id}-phrase-pad`}>{" ".repeat(LABEL_COLUMN)}</text>
          <text id={`${props.id}-phrase`} fg={SHELL_PALETTE.dim}>
            {hostFailurePhrase(props.failureCode)}
          </text>
        </box>
        {/* No gutter at all when the runtime message adds nothing — the design's own rule, so
            nothing looks withheld. */}
        {messageLines.map((line, index) => (
          <box id={`${props.id}-message-${index}`} key={line + String(index)} flexDirection="row">
            <text id={`${props.id}-message-pad-${index}`}>{" ".repeat(LABEL_COLUMN - 2)}</text>
            <text id={`${props.id}-message-gutter-${index}`} fg={SHELL_PALETTE.amberDim}>
              ┊
            </text>
            <text id={`${props.id}-message-text-${index}`} fg={SHELL_PALETTE.fg}>
              {` ${line}`}
            </text>
          </box>
        ))}
        <text id={`${props.id}-spacer-2`}> </text>
        <box id={`${props.id}-attempts`} flexDirection="row">
          <text id={`${props.id}-attempts-label`} fg={SHELL_PALETTE.dim}>
            {"attempts".padEnd(LABEL_COLUMN)}
          </text>
          <text id={`${props.id}-attempts-count`} fg={SHELL_PALETTE.fg}>
            {`${starts} ${starts === 1 ? "start" : "starts"} · ${restarts} automatic restart${restarts === 1 ? "" : "s"}`}
          </text>
        </box>
        <box id={`${props.id}-class-row`} flexDirection="row">
          <text id={`${props.id}-class-pad`}>{" ".repeat(LABEL_COLUMN)}</text>
          <text id={`${props.id}-class`} fg={SHELL_PALETTE.dim}>
            {restarts > 0
              ? "every start failed the same way"
              : "deterministic — a restart cannot change it"}
          </text>
        </box>
        <text id={`${props.id}-spacer-3`}> </text>
        <text id={`${props.id}-circuit`} fg={SHELL_PALETTE.dim}>
          {props.retryAvailable
            ? "the restart circuit is open — no preview until a host starts"
            : "the restart circuit is open — no preview for this session"}
        </text>
        {/* DIVERGENCE 2: the engine draws the tee rule into the box's own border cells, which a
            flex child cannot reach — a full-width rule inside the box is the nearest mapping. */}
        <text id={`${props.id}-rule`} fg={SHELL_PALETTE.line}>
          {"─".repeat(contentWidth)}
        </text>
        <box id={`${props.id}-f5`} flexDirection="row">
          <text
            id={`${props.id}-f5-key`}
            fg={keyFg}
            attributes={props.retryAvailable ? BOLD : shellAttrs({})}
          >
            {"F5".padEnd(4)}
          </text>
          <text
            id={`${props.id}-f5-label`}
            fg={labelFg}
            attributes={props.retryAvailable ? BOLD : shellAttrs({})}
          >
            {"retry host".padEnd(16)}
          </text>
          <text id={`${props.id}-f5-note`} fg={noteFg}>
            {props.retryAvailable
              ? "start a new host and mount again"
              : "no host can be started in this session"}
          </text>
        </box>
        <box id={`${props.id}-f5-detail-row`} flexDirection="row">
          <text id={`${props.id}-f5-detail-pad`}>{" ".repeat(20)}</text>
          <text id={`${props.id}-f5-detail`} fg={SHELL_PALETTE.faint}>
            {props.retryAvailable
              ? "the cause may still be present"
              : "nothing in this pane will bring it back"}
          </text>
        </box>
        <text id={`${props.id}-spacer-4`}> </text>
        <text id={`${props.id}-agent-note`} fg={SHELL_PALETTE.faint}>
          {props.retryAvailable
            ? "talking to the agent cannot start a host"
            : "the composer stays live — but this is not the agent's to fix"}
        </text>
      </box>
    </box>
  );
}
