import { wrapText } from "ui/chat";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import { relativePageSourcePath } from "../model/repair-prompt";

/** Props for the {@link HostCrashPanel} halted-preview surface. */
export interface HostCrashPanelProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly pageSlug: string;
  /** The host's own bounded message, rendered verbatim and wrapped — never truncated. */
  readonly hostMessage: string;
  readonly attempts: number;
  readonly retryAvailable: boolean;
}

const BOLD = shellAttrs({ bold: true });

/** The design's block is `min(dw-6, 66)` wide with a 3-column gutter (`wsHostCrash`'s `bw`/`cwid`). */
const BLOCK_MAX_WIDTH = 66;
const BLOCK_PADDING = 3;

/**
 * The preview-region panel for a host that crashed while rendering (design `wsHostCrash`,
 * `design/12-errors-edge-states.dc.html`'s `ws-host-crash-120` and `ws-host-crash-noretry-120`).
 *
 * DISTINCT FROM `ErrorPanel` ON PURPOSE. `ErrorPanel` renders the GATE state
 * (`wsBrokenSource`): a candidate refused by static checks, never mounted. This one renders the
 * opposite — a design that passed every check, was mounted by a live host child, and threw. The
 * design's own comment lists the distinctions it makes so the two frames cannot be confused when
 * either is read alone: a bordered report rather than bare centred text, the `preview host ·
 * halted` title, an opening line naming *threw while rendering*, and ` HALTED ` in the status bar
 * instead of ` STATIC `.
 *
 * ONLY for a `DESIGN_RENDER_FAILED` circuit-open (spec §3.2.1). Every other host failure code
 * means the child never got as far as the page, and its screen is design iteration 9's — this
 * frame's headline and its `F6` offer would both be false there.
 *
 * The host message is wrapped, never truncated: the runtime already bounds it to 200 characters,
 * so there is no hidden text and therefore no affordance needed to reveal any.
 */
export function HostCrashPanel(props: HostCrashPanelProps) {
  const blockWidth = Math.min(Math.max(props.width - 6, 1), BLOCK_MAX_WIDTH);
  // What actually fits between the two border columns and the two paddings.
  const contentWidth = Math.max(blockWidth - 2 - BLOCK_PADDING * 2, 1);
  // The design wraps at `cwid-2`: the gutter column and the space after it are inside the
  // content width, so the text itself gets two columns less.
  const messageLines = wrapText(props.hostMessage, Math.max(contentWidth - 2, 1));
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
      {/* DIVERGENCE 1, closest faithful mapping: the engine positions this block by computed
          cell coordinates (`bx`/`by` from `dw`/`dh`); a flex column centred in the pane is the
          nearest OpenTUI equivalent — the same class of note `ErrorPanel.tsx` already carries
          for `wsBrokenSource`. */}
      <box
        id={`${props.id}-block`}
        border
        borderColor={SHELL_PALETTE.red}
        title="preview host · halted"
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
          ✗ design threw while rendering — no preview
        </text>
        <text id={`${props.id}-spacer-1`}> </text>
        <box id={`${props.id}-source`} flexDirection="row">
          <text id={`${props.id}-slug`} fg={SHELL_PALETTE.amberHi} attributes={BOLD}>
            {props.pageSlug}
          </text>
          <text id={`${props.id}-path`} fg={SHELL_PALETTE.fg}>
            {` · ${relativePageSourcePath(props.pageSlug)}`}
          </text>
        </box>
        <text id={`${props.id}-spacer-2`}> </text>
        <text id={`${props.id}-message-label`} fg={SHELL_PALETTE.dim}>
          host message
        </text>
        {messageLines.map((line, index) => (
          <box id={`${props.id}-message-${index}`} key={line + String(index)} flexDirection="row">
            <text id={`${props.id}-gutter-${index}`} fg={SHELL_PALETTE.red}>
              │
            </text>
            <text id={`${props.id}-message-text-${index}`} fg={SHELL_PALETTE.fg}>
              {` ${line}`}
            </text>
          </box>
        ))}
        <text id={`${props.id}-spacer-3`}> </text>
        <text id={`${props.id}-tally`} fg={SHELL_PALETTE.dim}>
          {tallyLine(props.attempts)}
        </text>
        <text id={`${props.id}-stopped`} fg={SHELL_PALETTE.dim}>
          restarts stopped — no preview until you act
        </text>
        {/* DIVERGENCE 2: the engine draws the tee rule by writing `├`/`┤` into the box's own
            border cells, which a flex child cannot reach — a full-width rule inside the box is
            the closest faithful mapping. */}
        <text id={`${props.id}-rule`} fg={SHELL_PALETTE.line}>
          {"─".repeat(contentWidth)}
        </text>
        <KeyRow
          id={`${props.id}-f5`}
          hotkey="F5"
          label="retry preview"
          note={
            props.retryAvailable
              ? "re-establish the host and mount again"
              : "unavailable in this session"
          }
          detail={
            props.retryAvailable ? "a broken design will die again" : "repair is the only route out"
          }
          keyFg={keyFg}
          labelFg={labelFg}
          noteFg={noteFg}
          bold={props.retryAvailable}
        />
        <KeyRow
          id={`${props.id}-f6`}
          hotkey="F6"
          label="repair…"
          note="write the failure into the composer"
          detail="nothing is sent — you press ⏎"
          keyFg={SHELL_PALETTE.amber}
          labelFg={SHELL_PALETTE.amberHi}
          noteFg={SHELL_PALETTE.dim}
          bold
        />
      </box>
    </box>
  );
}

/**
 * The design's line is written for the budgeted loop — `mounted 4× · 3 automatic restarts, all
 * identical`. A deterministic failure (every `ProtocolError`) opens the circuit on the FIRST
 * failure, so there is one incarnation and no restart at all; rendering the design's phrasing
 * with `1×` and `0 automatic restarts` would describe a loop that never happened.
 */
function tallyLine(attempts: number): string {
  if (attempts <= 1) return "mounted once · no restart was attempted";
  return `mounted ${attempts}× · ${attempts - 1} automatic restarts, all identical`;
}

interface KeyRowProps {
  readonly id: string;
  readonly hotkey: string;
  readonly label: string;
  readonly note: string;
  readonly detail: string;
  readonly keyFg: string;
  readonly labelFg: string;
  readonly noteFg: string;
  readonly bold: boolean;
}

/**
 * One two-line key row: `F5  retry preview     <note>` then the `<detail>` under the note
 * (`wsHostCrash`'s own `keyRow` helper, whose second line is always `faint`). The engine places
 * the three columns at absolute offsets `lx`, `lx+4`, `lx+20`; padded strings are the closest
 * faithful mapping in a flex row.
 */
function KeyRow(props: KeyRowProps) {
  return (
    <box id={props.id} flexDirection="column">
      <box id={`${props.id}-line`} flexDirection="row">
        <text
          id={`${props.id}-key`}
          fg={props.keyFg}
          attributes={props.bold ? BOLD : shellAttrs({})}
        >
          {props.hotkey.padEnd(4)}
        </text>
        <text
          id={`${props.id}-label`}
          fg={props.labelFg}
          attributes={props.bold ? BOLD : shellAttrs({})}
        >
          {props.label.padEnd(16)}
        </text>
        <text id={`${props.id}-note`} fg={props.noteFg}>
          {props.note}
        </text>
      </box>
      <box id={`${props.id}-detail-line`} flexDirection="row">
        <text id={`${props.id}-detail-pad`}>{" ".repeat(20)}</text>
        <text id={`${props.id}-detail`} fg={SHELL_PALETTE.faint}>
          {props.detail}
        </text>
      </box>
    </box>
  );
}
