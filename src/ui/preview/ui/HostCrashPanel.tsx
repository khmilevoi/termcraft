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
  /**
   * The page's TREE-relative entry — `design/pages.json`'s binding, never slug-derived
   * (task 16). `null` when the descriptor list does not name this page, which the panel says
   * out loud rather than drawing a path that cannot exist.
   */
  readonly entryRelPath: string | null;
  /** The host's own bounded message, rendered verbatim and wrapped — never truncated. */
  readonly hostMessage: string;
  readonly attempts: number;
  readonly retryAvailable: boolean;
  /**
   * Why a repair turn cannot run right now, or `null` when it can (design
   * `design/30-workspace-first-launch.dc.html` §"The collision", engine `wsHostCrash`'s
   * `o.agentDead` branch). Built by `ui/agent-health`'s `agentBlockedNote` so the line here and
   * the badge in the status bar cannot state the same fact two different ways.
   *
   * The hint slot is NOT affected: preview halt still outranks health there — one badge, and this
   * one is already the point of the frame.
   */
  readonly agentBlocked: { readonly line: string; readonly f6Detail: string } | null;
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
            {props.entryRelPath === null
              ? " · no entry in design/pages.json"
              : ` · ${relativePageSourcePath(props.entryRelPath)}`}
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
          detail={props.agentBlocked?.f6Detail ?? "nothing is sent — you press ⏎"}
          keyFg={SHELL_PALETTE.amber}
          labelFg={SHELL_PALETTE.amberHi}
          noteFg={SHELL_PALETTE.dim}
          bold
        />
        {/* DIVERGENCE 3: the engine's own `keyRow`/`text` helpers write characters at a fixed
            column offset with no bounds check, so a real `agentBlockedNote` line — built from the
            agent's own name and cause — would silently overflow the block's right border in the
            raw mockup. OpenTUI's `<text>` wraps instead, the closest faithful mapping: nothing is
            hidden or truncated, unlike an invented truncation would be. Same applies to the F6
            row's `detail` above.

            KNOWN DEFECT (branch review finding 1, 2026-08-02 fix wave), not merely a coverage
            gap. The engine's own `bh` budgets +2 rows for this branch
            (`design/termcraft-engine.js:1207`, `bh += agentDead ? 2 : 0`) — one spacer, one
            line, on the assumption the line fits in a single row. The wrapping this DIVERGENCE
            describes actually costs +4 at OpenTUI's real (`BLOCK_MAX_WIDTH`-bounded) content
            width for the default fixtures this file's own tests use: the F6 `detail` wraps to a
            second line (+1), the spacer above this block (+1), and the wrapped `line` itself
            becomes two rows instead of one (+2). At a 120×24 terminal (region {w:74, h:18} per
            `previewRegionSize`) the block then needs 22 rows against an 18-row region it is
            handed — a real, measured 4-row overflow AT THAT WIDTH, confirmed by rendering (not
            reasoned about abstractly): `rectOf("...-block").height` reads 18 with
            `agentBlocked: null` and 22 with it set, at every height in 24..27 — see
            `HostCrashPanel.test.tsx`'s own "KNOWN DEFECT" test for the exact pinned numbers.

            120×24 is NOT the worst supported case. `MIN_FRAME` (`ui/mirror/model/screen.ts:11`)
            is 80×24, which narrows the region to {w:48, h:18} — the block's own
            `BLOCK_MAX_WIDTH` clamp does not help at a width this narrow, the same text just
            wraps onto more lines instead — and there the block needs 31 rows against the same
            18-row region: an overflow of 13, not 4. 100×24 (region {w:61, h:18}) sits between
            the two, at 27 rows needed, an overflow of 9. Only at 120 columns does the `null`
            variant exactly fill the region with no slack to begin with (18 of 18) — at 80 and
            100 columns `agentBlocked: null` ALREADY overflows on its own, with no `agentBlocked`
            involved at all: 27 rows at 80×24 and 24 rows at 100×24, both against the same
            18-row region. This branch therefore DEEPENED an existing overflow rather than
            introducing one, and a correct bounding fix has to work across widths — not just
            recover the 4 rows this branch adds at 120 columns.

            `Workspace.tsx`'s `ws-preview` box clips this with its own `overflow="hidden"`
            (`:778`), and because this component centers the block (`justifyContent="center"`
            above), the excess splits across both edges rather than pinning to the top the way
            the engine's own `Math.max(0, ...)` clamp on `by` would. The concrete visible
            consequence depends on how much chrome sits above the region at a given terminal
            height (the tab strip and its rule, absorbed into the SAME `overflow="hidden"`
            ancestor), measured here at 120 columns: at h=24 it collides with the tab rule (the
            block's top border overwrites it) and its own bottom border row vanishes; at h=25
            both the bottom padding row and the bottom border row are lost; at h=26..27 only the
            bottom border row is lost. For the exact fixtures this suite uses, no MESSAGE TEXT is
            lost at any of those heights — only border/padding chrome — but that is a property of
            these specific string lengths splitting the 4-row deficit evenly across the block's
            own top and bottom padding+border (2 non-text rows each) at 120 columns; it is not a
            guarantee for other message lengths, and the 80×24/100×24 numbers above show it does
            not hold at narrower widths either, where the deficit is far larger than border and
            padding chrome alone can absorb.

            Bounding the block's own height to the region it is given, without breaking the
            "wrapped, never truncated" contract text that fits must keep, needs predicting every
            wrapped region's row count (this block's host message, the F6 detail line, and now
            this `agentBlocked.line` too) BEFORE OpenTUI's own layout pass runs, in order to
            reproduce the engine's own `Math.max(0, floor((dh-bh)/2))` clamp on `by` — which pins
            the block to the region's top rather than centering it into negative space once
            content overflows. That prediction has to track a wrap algorithm this component does
            not own end-to-end (row layout inside a `flexDirection="row"` `KeyRow`, not just
            `wrapText`'s own single-column case), which is a bigger change than this fix wave
            carries. Tracked here, not silently accepted — see the pinning test below. */}
        {props.agentBlocked !== null && (
          <>
            <text id={`${props.id}-agent-spacer`}> </text>
            <text id={`${props.id}-agent-blocked`} fg={SHELL_PALETTE.red}>
              {props.agentBlocked.line}
            </text>
          </>
        )}
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
