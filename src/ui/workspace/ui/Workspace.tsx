import { MouseButton, type MouseEvent } from "@opentui/core";
import { reatomComponent, useWrap } from "@reatom/react";

import type { PinDtoV1 } from "core/protocol";
import { HOTKEYS, filterSlashRows } from "ui/actions";
import type { HotkeyAction } from "ui/actions";
import {
  AgentStatusBlock,
  ChatRecord,
  ChatScrollback,
  Composer,
  PinList,
  SystemNotice,
  foldTurnTimeline,
  markdownLineRows,
} from "ui/chat";
import type { MarkdownLine } from "ui/chat";
import type { UiPreviewFrame } from "ui/kernel";
import type { PreviewMirror, TurnMirror } from "ui/mirror";
import {
  EmptyState,
  ErrorPanel,
  FrameView,
  HostCrashPanel,
  HostUnavailablePanel,
  OpeningState,
  PreviewOverlays,
  acknowledgeFrame,
  frameLocalPoint,
  hostFailureCodeOf,
  isDesignRenderFailure,
  requestGeometry,
} from "ui/preview";
import type { HoverGeometry, PendingPin, Rect } from "ui/preview";
import { SlashMenu } from "ui/slash-menu";
import { StatusBar } from "ui/status-bar";
import type { StatusBarHintKey, StatusBarModeChip } from "ui/status-bar";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import {
  agentStatusMaxRows,
  composerRowCount,
  pinListRowCount,
  scrollbackMaxRows,
} from "../model/agent-block-budget";
import { deriveComposerAttach } from "../model/attach";
import { agentHealthBadge } from "../model/health-badge";
import { selectPage } from "../model/page-selection";
import { derivePinListRows } from "../model/pins";
import {
  chatColumnWidth,
  previewFrameOrigin,
  previewPaneHeight,
  previewRegionSize,
  previewTabStripWidth,
} from "../model/preview-geometry";
import type { CellSize } from "../model/preview-geometry";
import { deriveTabs, tabsOverflow } from "../model/tabs";
import type { TabEntry } from "../model/tabs";
import type { WorkspaceDeps } from "../types";
import { PreviewPaneRule } from "./PreviewPaneRule";

const BOLD = shellAttrs({ bold: true });

/**
 * The one halted-preview fact the panel, the status bar, the composer attach line and the chat
 * notice all four read — derived once in `Workspace` so the four can never disagree about
 * whether the host halted or whose fault it was.
 */
type PreviewHalt = null | { readonly retryAvailable: boolean; readonly designAtFault: boolean };

/** The status-bar mode chip for the current turn/fullscreen state (design mode-chip literals). */
function modeChip(
  turn: TurnMirror,
  fullscreen: boolean,
  readOnly: boolean,
  previewHalt: PreviewHalt,
): StatusBarModeChip {
  if (readOnly) return { text: "READ-ONLY", fg: "amberHi", bg: "line" };
  if (turn.phase === "running") return { text: "GENERATING", fg: "bg", bg: "amber" };
  if (fullscreen) return { text: "FULLSCREEN", fg: "bg", bg: "amber" };
  // Each halted screen names its own chip, and the design calls the difference one of the
  // distinctions that must let the two be told apart on sight: ` HALTED ` for a render crash
  // (`wsHostCrash`), ` NO HOST ` when the host never ran the design (`wsHostUnavailable`).
  if (previewHalt !== null)
    return { text: previewHalt.designAtFault ? "HALTED" : "NO HOST", fg: "bg", bg: "red" };
  return { text: "STATIC", fg: "amberHi", bg: "line" };
}

function hotkeyGlyph(key: string): string {
  if (key === "ctrl+e") return "^E";
  if (key.startsWith("ctrl+")) return `Ctrl+${key.slice(5).toUpperCase()}`;
  return key.toUpperCase();
}

function hotkeyHint(action: HotkeyAction, label = action.label): StatusBarHintKey {
  // MVP-inert keys are shown but do nothing — the design's own `dis` treatment, which is also
  // exactly what this component already rendered for them.
  return action.inert === true
    ? [hotkeyGlyph(action.key), label, "dis"]
    : [hotkeyGlyph(action.key), label];
}

function fullscreenHint(label: string): readonly StatusBarHintKey[] {
  return HOTKEYS.filter((action) => action.id === "preview.fullscreen").map((action) =>
    hotkeyHint(action, label),
  );
}

/**
 * The right-aligned hint keys for the current state (design `hintKeys` defaults). CORRECTED
 * (finding §2.5, phase-8 Task 16): the running branch used to append the F2 "full" hint after
 * "esc cancel" — the plainer `workspace(w,h,'gen')` screen's own key row
 * (`design/termcraft-engine.js:215`) does show F2, but the dedicated, more detailed generating
 * screens this task is about do not: `wsGenTyping` (`:275-276`) and `wsSlashTurn` (`:1005-1006`)
 * both draw the SAME exact pair, `keys:[['⏎','send','dis'],['esc','cancel']]` — a faint,
 * explicitly-disabled `⏎ send` alongside the live `esc cancel`, no F2 at all.
 */
function hintKeys(
  turn: TurnMirror,
  fullscreen: boolean,
  previewHalt: PreviewHalt,
): readonly StatusBarHintKey[] {
  if (fullscreen) return fullscreenHint("windowed");
  // design/termcraft-engine.js:1005-1006 (`wsSlashTurn`) / :275-276 (`wsGenTyping`).
  if (turn.phase === "running")
    return [
      ["⏎", "send", "dis"],
      ["esc", "cancel"],
    ];
  // `preview.retry` and `preview.repair` are advertised ONLY where they actually act. Showing
  // them unconditionally would put a live-looking `F5 retry`/`F6 repair` in the status bar for
  // the entire session, for actions that do nothing in every other phase — the same "advertised
  // but inert" trap this file's own `dis` state and the `q`/`/exit` divergence exist to avoid.
  //
  // `F6` additionally requires the PAGE to be at fault: `wsHostUnavailable`'s own key row is
  // `F5 · F2 · F3` with no repair key at all, because no page edit could start a host.
  return HOTKEYS.filter((action) => {
    // A key bound without being drawn (the page-step extension, `HotkeyAction.hint`) never
    // enters the row: this row is a transcription of the design's own key rows.
    if (action.hint === false) return false;
    if (action.id === "preview.retry") return previewHalt !== null;
    if (action.id === "preview.repair") return previewHalt?.designAtFault === true;
    return true;
  }).map((action) =>
    action.id === "preview.retry" && previewHalt?.retryAvailable === false
      ? // Both no-retry variants mark F5 `dis` in the key row.
        [hotkeyGlyph(action.key), action.label, "dis"]
      : hotkeyHint(action),
  );
}

/** design `wsOpening`'s own key row (`design/termcraft-engine.js:247`). */
const OPENING_HINT_KEYS: readonly StatusBarHintKey[] = [["⏎", "send", "dis"]];

/** The collapsed record lines for a terminal turn (✓ per changed page, or ✗ on a non-success). */
function terminalRecordLines(
  turn: Extract<TurnMirror, { phase: "terminal" }>,
): readonly MarkdownLine[] {
  if (turn.outcome === "completed") {
    if (turn.changedPages.length === 0) return [{ spans: [{ text: "✓ no changes" }] }];
    return turn.changedPages.map((page) => ({ spans: [{ text: `✓ updated ${page.pageSlug}` }] }));
  }
  return [{ spans: [{ text: `✗ ${turn.outcome}` }] }];
}

/**
 * The rows `AgentStatusBlock` always draws OUTSIDE the folded timeline: the spinner line, and
 * nothing else.
 *
 * WAS 3 (defect fix, 2026-07-26): it also counted a `● agent` presence line and a connection
 * meta line the block used to draw on top of the panel's OWN `ws-chat-agent` header — the
 * duplicate `● claude` the design never has (see {@link AgentStatusBlockProps}). Those two rows
 * are gone from the block, so budgeting for them would now under-fill the timeline by two rows
 * on every live turn. (Gate-retry rows are still NOT counted here, since they're bounded at 3
 * and rare — underestimating the budget by that amount
 * on the rare turn that has both a long timeline AND active retries just makes the fold trigger
 * one row earlier than strictly necessary, never a layout break). Fed into `agentStatusMaxRows`
 * (`../model/agent-block-budget.ts`) alongside `frameH` and every OTHER row-consuming sibling in
 * `ws-chat-stream` — this constant alone is NOT the whole budget calculation (review round 1,
 * Finding 1: subtracting only this from bare `frameH`, with no upper bound, silently overflowed
 * the panel on real terminal sizes). The design's own ceiling on the other side of that
 * calculation is `MAX_TIMELINE_ROWS` (11) — see that constant's own doc comment for the 12-row
 * citation this value does NOT independently derive from.
 */
const AGENT_BLOCK_CHROME_ROWS = 1;

/**
 * Renders the ordered tab strip (design `drawTabs`, `design/18-tab-management.dc.html`):
 * ▸ active amber-bold, dim inactive, faint ghost. When the summed tab widths exceed `width`
 * (`tabsOverflow`), paints the leading/trailing `‹`/`›` scroll indicators (design `o.scroll`
 * branch, `termcraft-engine.js:385,389`).
 *
 * DIVERGENCE (plan prose vs. engine source): WP-9's task text describes the indicators as
 * "faint"; the engine's actual `o.scroll` branch paints them
 * `this.text(b,x,y,'‹',{fg:P.amber,bold:true})` / the matching `›` — amber, bold, not faint.
 * The engine source is the design's ground truth (CLAUDE.md "design is a source of truth"), so
 * this renders `SHELL_PALETTE.amber` bold, matching the drawn glyph exactly.
 *
 * `stripWidth` is `../model/preview-geometry.ts`'s own `previewTabStripWidth` — the pane's
 * outer width less its border and the design's own indent (`drawTabs(b, px0+2, 1, pw-4, …)`,
 * `design/termcraft-engine.js:484`), matching `tabsOverflow`'s best-effort estimate
 * (`../model/tabs.ts`). Bounding the strip box to exactly this width is what makes
 * `overflow="hidden"` clip the tab content the way the engine's fixed-width character buffer
 * naturally would, and the trailing `›` (pinned with `position="absolute" right={0}`) always
 * lands at the strip's true right edge instead of after however much tab content the row would
 * otherwise emit (which, since the preview column is flush against the terminal's own right
 * edge, would render past the canvas and never appear at all).
 */
function renderTabs(
  tabs: readonly TabEntry[],
  stripWidth: number,
  onTabMouseDown: (pageSlug: string, event: MouseEvent) => void,
) {
  const overflow = tabsOverflow(tabs, stripWidth);
  return (
    <box
      id="ws-tabs"
      flexDirection="row"
      position="relative"
      marginLeft={1}
      width={stripWidth}
      height={1}
      overflow="hidden"
    >
      {overflow && (
        <text id="ws-tabs-scroll-left" fg={SHELL_PALETTE.amber} attributes={BOLD}>
          {"‹ "}
        </text>
      )}
      {tabs.map((tab) => (
        <text
          key={tab.pageSlug}
          id={`ws-tab-${tab.pageSlug}`}
          // §3.3 "Tabs switch pages" — the design's only page-switch affordance. Each tab owns
          // its own handler rather than one strip-level hit test over column arithmetic: OpenTUI
          // delivers the hit `target` itself (`MouseEvent.target`), so the slug comes from the
          // element that was actually clicked, never from a width estimate that could drift out
          // of step with what `drawTabs` painted.
          onMouseDown={(event: MouseEvent) => onTabMouseDown(tab.pageSlug, event)}
          fg={
            tab.active ? SHELL_PALETTE.amber : tab.ghost ? SHELL_PALETTE.faint : SHELL_PALETTE.dim
          }
          attributes={tab.active ? BOLD : 0}
        >
          {tab.active ? `▸ ${tab.title}  ` : `  ${tab.title} `}
        </text>
      ))}
      {overflow && (
        <text
          id="ws-tabs-scroll-right"
          position="absolute"
          right={0}
          top={0}
          fg={SHELL_PALETTE.amber}
          attributes={BOLD}
        >
          {"›"}
        </text>
      )}
    </box>
  );
}

/** Selects the preview region content: enlarge is handled by the App; here opening/empty/error/frame/ready. */
function renderPreviewRegion(
  preview: PreviewMirror,
  uiFrame: UiPreviewFrame | null,
  hasPages: boolean,
  opening: boolean,
  region: CellSize,
  interaction: Readonly<{
    pins: readonly PinDtoV1[];
    pendingPin: PendingPin | null;
    selectionRect: Rect | null;
    hover: HoverGeometry | null;
    onRendered: (frame: UiPreviewFrame) => void;
    onMouseMove: (event: MouseEvent) => void;
    onMouseDown: (event: MouseEvent) => void;
  }>,
) {
  // FIRST, ahead of every other branch. "There are no pages" and "the pages have not been read
  // yet" are different facts, and only this one is true while `projectId` is null — the preview
  // machine cannot have failed or halted for a project that has not opened, so no branch below
  // is being pre-empted. Design `wsOpening` (`design/30-workspace-first-launch.dc.html`).
  if (opening) {
    return <OpeningState id="ws-preview-opening" width={region.w} height={region.h} />;
  }
  // every existing branch below stays exactly as it is: failed -> circuit-open -> !hasPages ->
  // frame -> "preparing preview…"
  if (preview.phase === "failed") {
    return (
      <ErrorPanel
        id="ws-preview-error"
        width={region.w}
        height={region.h}
        headline="could not render current design"
        cause={preview.failure.safeMessage}
        nextStep="fix it in a repair turn — the composer stays open"
        restoreHint={null}
      />
    );
  }
  if (preview.phase === "circuit-open") {
    // The PAGE threw — design `wsHostCrash`, which offers both F5 retry and F6 repair.
    if (isDesignRenderFailure(preview.finalFailure)) {
      return (
        <HostCrashPanel
          id="ws-preview-crash"
          width={region.w}
          height={region.h}
          pageSlug={preview.pageSlug}
          hostMessage={preview.finalFailure.safeMessage}
          attempts={preview.attempts}
          retryAvailable={preview.retryAvailable}
        />
      );
    }
    // The host never got as far as the page (spec §3.2.1) — a spawn failure, a handshake or
    // mount timeout, a broken pipe, a runtime-integrity mismatch. Design `wsHostUnavailable`
    // (iteration 9), which clears the page of blame and names no repair key at all.
    return (
      <HostUnavailablePanel
        id="ws-preview-unavailable"
        width={region.w}
        height={region.h}
        pageSlug={preview.pageSlug}
        failureCode={hostFailureCodeOf(preview.finalFailure)}
        hostMessage={preview.finalFailure.safeMessage}
        attempts={preview.attempts}
        retryAvailable={preview.retryAvailable}
      />
    );
  }
  if (!hasPages) return <EmptyState id="ws-preview-empty" width={region.w} height={region.h} />;
  if (uiFrame !== null) {
    const frameRect = { x: 0, y: 0, width: uiFrame.frame.width, height: uiFrame.frame.height };
    return (
      <box
        id="ws-preview-canvas"
        position="relative"
        // Clamped to the region, not sized by the frame: a frame the host has not yet
        // re-rendered at the current pane size (see `previewTargetSize` in
        // `ui/app/model/deps.ts`) is a transient the pane clips, never an overdraw that
        // eats the pane's own border and the rows below it. `overflow="hidden"` is what
        // makes the clamp actually cut the content rather than merely mis-measure the box.
        width={Math.min(uiFrame.frame.width, region.w)}
        height={Math.min(uiFrame.frame.height, region.h)}
        overflow="hidden"
        onMouseMove={interaction.onMouseMove}
        onMouseDown={interaction.onMouseDown}
      >
        <FrameView
          id="ws-preview-frame"
          frame={uiFrame.frame}
          onRendered={() => interaction.onRendered(uiFrame)}
        />
        <PreviewOverlays
          id="ws-preview-overlays"
          frameRect={frameRect}
          pins={interaction.pins}
          pendingPin={interaction.pendingPin}
          selectionRect={interaction.selectionRect}
          hover={interaction.hover}
        />
      </box>
    );
  }
  return (
    <box id="ws-preview-ready" flexGrow={1} alignItems="center" justifyContent="center">
      <text id="ws-preview-ready-text" fg={SHELL_PALETTE.faint}>
        preparing preview…
      </text>
    </box>
  );
}

/**
 * The Workspace shell (design §3.2, design/02-workspace-idle.dc.html): the chat panel (~37%),
 * the preview region with its tab strip, and the status bar. A `reatomComponent` — it reads
 * the mirror slices and the UI-local atoms directly, so any Kernel event or focus change
 * re-renders exactly the affected region.
 *
 * DIVERGENCE: OpenTUI flex siblings cannot auto-tee their borders, so the chat/preview frames
 * render as adjacent rounded boxes rather than one fused frame with `┬`/`┴` junctions (plan
 * GAP decision on frame junctions). Live frame streaming fills `previewFrame` from the App's
 * `PreviewSession` consumer.
 */
export const Workspace = reatomComponent<{ deps: WorkspaceDeps; readOnly: boolean }>((props) => {
  const { mirror, terminal, previewFrame, local, interaction } = props.deps;
  const size = terminal();
  const turn = mirror.turn();
  const preview = mirror.preview();
  // `projectId === null` inside a mounted Workspace means exactly one thing: `deriveScreen`
  // routed a pending startup open here and the Kernel's ready sequence has not published
  // anything yet (`ui/mirror/model/screen.ts`). No new flag is needed for it.
  const opening = mirror.project().projectId === null;
  // design `wsOpening`'s own `narrow` (`termcraft-engine.js:235`): at the floor the size segment
  // is dropped and the phrase shortens, the same restraint the idle shell already applies below
  // 100 columns.
  const narrow = size.w < 100;
  const descriptors = mirror.pageDescriptors();
  // The page the Workspace is showing — the tab-strip pick when there is one, else the Kernel's
  // own active slug (`../model/page-selection.ts`). Read ONCE here so the tab strip, the pin
  // list, the composer attach line and the status bar all name the same page.
  const activePageSlug = props.deps.activePageSlug();
  const uiFrame = previewFrame();
  const composerFocused = local.focus() === "composer";
  const fullscreen = local.fullscreen();
  const composerValue = local.composer();
  const healthBadge = agentHealthBadge(local.agentHealth(), narrow);
  const slashOpen = !props.readOnly && local.overlay() === "slash-menu";
  const slashRows = slashOpen
    ? filterSlashRows(composerValue, {
        capabilities: mirror.capabilities(),
        turnRunning: turn.phase === "running",
        screen: "workspace",
      })
    : [];

  const identity = mirror.agentIdentity();
  // DIVERGENCE (design sample data, not layout): design/02-workspace-idle.dc.html and
  // design/03-workspace-generating.dc.html hardcode the composer chip (`codex · gpt5.5 · high`),
  // the `● codex` presence line, and the `chat · codex` chat-panel title as literal sample data
  // (user decision 2026-07-23). MVP ships Claude only; every one of those identity texts below
  // is now sourced from the kernel snapshot's `agentIdentity` (via the mirror), never a
  // hardcoded literal — the glyphs (`●`), placement, and colors stay exactly as designed.
  // `AgentIdentityV1` carries no effort field, so the design's `· high` segment is dropped from
  // the composer chip (effort/model-picker selection is out of MVP scope). `identity === null`
  // (no backend selected yet / kernel not yet emitting identity) renders the neutral empty
  // text below — never an invented fallback like "agent".
  const agentLabel = identity?.backendId ?? "";
  const modelChip = identity === null ? "" : `${identity.backendId} · ${identity.modelLabel}`;
  // TRIAGE #38: `buildAgentIdentity()` returns `null` by default today (no producer wired yet —
  // `core/kernel/model/kernel.ts`), so an empty `agentLabel` is the common case, not a rare one.
  // The chat-panel title's ` · ${agentLabel}` segment must not paint a dangling separator for
  // it — computed once here so both the title and the presence line agree on when to drop it.
  const chatTitleSuffix = agentLabel === "" ? "" : ` · ${agentLabel}`;

  const w = size.w;
  const h = size.h;
  const chatW = chatColumnWidth(w);
  // Every preview measurement comes from ONE module (`../model/preview-geometry.ts`) so the
  // rectangle the host is asked to render into, the box it is painted into, and the origin
  // the mouse is mapped against can never drift apart.
  const tabStripWidth = previewTabStripWidth(size, fullscreen);
  const previewRegion = previewRegionSize(size, fullscreen);
  // The pane's border and its header rule share ONE hue (design `paneShell` `:479,485` — the
  // rule is drawn in `pbf`, the same value passed as the pane's own border colour; `wsFocus`
  // `:801` is the one screen that varies it, `prevBorderFg: cf ? P.line : P.amber`, the exact
  // composer-focus switch this codebase already applies to the pane's `borderColor` below).
  // Computed once here, not inlined twice, so the rule and the border can never drift apart.
  const previewBorderColor =
    composerFocused && !fullscreen ? SHELL_PALETTE.line : SHELL_PALETTE.amber;
  const frameH = previewPaneHeight(size);
  const ghostSlug = turn.phase === "running" && descriptors.length === 0 ? activePageSlug : null;
  const tabs = deriveTabs(descriptors, activePageSlug, ghostSlug);
  const active = descriptors.find((descriptor) => descriptor.pageSlug === activePageSlug);
  const minSize = active !== undefined && active.status === "ready" ? active.minSize : null;
  const ctx = turn.phase === "running" ? (turn.usage?.contextPercent ?? null) : null;
  const pins = activePageSlug === null ? [] : (mirror.pinsByPage().get(activePageSlug) ?? []);
  const pinRows = derivePinListRows(pins);
  const records = mirror.records();
  const selection = mirror.selection();
  const previewNotice = mirror.previewNotice();
  // The one preview state the status bar, the composer attach line and the preview panel all
  // three read — derived once here so the three can never disagree about whether the host halted.
  const previewHalt: PreviewHalt =
    preview.phase === "circuit-open"
      ? {
          retryAvailable: preview.retryAvailable,
          designAtFault: isDesignRenderFailure(preview.finalFailure),
        }
      : null;
  const composerAttach = deriveComposerAttach({
    readOnly: props.readOnly,
    selection,
    activePageSlug,
    openPins: pins,
    turnRunning: turn.phase === "running",
    composerValue,
    slashOpen,
    previewCrashed: previewHalt,
  });
  // Review round 1, Finding 1: the row budget `foldTurnTimeline` gets as `maxRows` must both cap
  // at the design's own 11-row ceiling AND measure real remaining space inside `ws-chat-stream`
  // — not bare `frameH`, which ignores `ws-chat`'s own border and every sibling this block shares
  // the panel with. See `agentStatusMaxRows`'s own doc comment (`../model/agent-block-budget.ts`).
  const pinRowCount = pinListRowCount(pinRows);
  const composerRows = composerRowCount(composerAttach !== null);
  const agentBlockMaxRows = agentStatusMaxRows({
    frameH,
    chromeRows: AGENT_BLOCK_CHROME_ROWS,
    hasAgentLine: agentLabel !== "",
    pinListRows: pinRowCount,
    composerRows,
  });
  // `ws-chat`'s own inner content width: the panel's width less its left/right border. This is
  // what every `<text>` inside `ws-chat-stream` actually wraps against, so it is what the row
  // budget must measure with.
  const chatContentWidth = Math.max(1, chatW - 2);
  const terminalLines = turn.phase === "terminal" ? terminalRecordLines(turn) : [];
  // What the ephemeral region claims this frame — the running turn's block, the finished turn's
  // collapsed record, or nothing. The scrollback below takes whatever is left over.
  const liveBlockRows =
    turn.phase === "running"
      ? AGENT_BLOCK_CHROME_ROWS + agentBlockMaxRows
      : turn.phase === "terminal"
        ? 1 + markdownLineRows(terminalLines, chatContentWidth)
        : 0;
  const scrollbackRows = scrollbackMaxRows({
    frameH,
    hasAgentLine: agentLabel !== "",
    liveBlockRows,
    pinListRows: pinRowCount,
    composerRows,
  });
  const selectionRect = interaction.selectionRect();
  const hover = interaction.hover();
  const pendingPin = interaction.pendingPin();
  const acknowledgeRenderedFrame = useWrap(
    (rendered: UiPreviewFrame) => acknowledgeFrame(props.deps, rendered),
    "ui.Workspace.acknowledgeRenderedFrame",
  );
  const requestAtMouse = (purpose: "hover" | "select" | "pin", event: MouseEvent) => {
    const current = previewFrame();
    if (current === null) return;
    const origin = previewFrameOrigin(size, fullscreen);
    const frameRect = {
      x: origin.x,
      y: origin.y,
      width: current.frame.width,
      height: current.frame.height,
    };
    const point = frameLocalPoint({ absolute: { x: event.x, y: event.y }, frameRect });
    requestGeometry(props.deps, purpose, point.x, point.y);
  };
  const onPreviewMouseMove = useWrap(
    (event: MouseEvent) => requestAtMouse("hover", event),
    "ui.Workspace.onPreviewMouseMove",
  );
  // Left click only: the tab context menu (rename · move · remove — `design/18-tab-management
  // .dc.html`) is v1.0 and out of scope here, so a right click on a tab must do nothing rather
  // than fall through to some other meaning.
  const onTabMouseDown = useWrap((pageSlug: string, event: MouseEvent) => {
    if (event.button !== MouseButton.LEFT) return;
    selectPage(props.deps, pageSlug);
  }, "ui.Workspace.onTabMouseDown");
  const onPreviewMouseDown = useWrap((event: MouseEvent) => {
    if (props.readOnly) return;
    if (event.button === MouseButton.RIGHT) return requestAtMouse("pin", event);
    if (event.button === MouseButton.LEFT) requestAtMouse("select", event);
  }, "ui.Workspace.onPreviewMouseDown");
  const composerPlaceholder = opening
    ? "project opening…"
    : props.readOnly
      ? "read-only — Send disabled"
      : turn.phase === "running"
        ? "generating… esc to cancel"
        : composerFocused
          ? "Ask for changes…"
          : "tab → focus composer";

  return (
    <box
      id="ws-root"
      flexDirection="column"
      width={w}
      height={h}
      backgroundColor={SHELL_PALETTE.bg}
    >
      <box id="ws-main" flexDirection="row" height={frameH}>
        {!fullscreen && (
          <box
            id="ws-chat"
            width={chatW}
            height={frameH}
            flexDirection="column"
            border
            borderStyle="rounded"
            borderColor={
              turn.phase === "running"
                ? SHELL_PALETTE.amberDim
                : composerFocused
                  ? SHELL_PALETTE.amber
                  : SHELL_PALETTE.line
            }
            // While a turn runs, the chat panel takes the design's own generating-frame chrome
            // (`wsSlashTurn`, `design/termcraft-engine.js:991`: `chatTitle:'❯ chat · working'`,
            // `chatBorderFg:P.amberDim`) — a literal title, not `agentLabel`-suffixed, and it wins
            // over the focus-derived styling below (`paneShell`'s own `titleFg` default is
            // `P.amber`, not `P.amberHi`, since `wsSlashTurn` never overrides `chatTitleFg`).
            title={
              turn.phase === "running"
                ? " ❯ chat · working "
                : composerFocused
                  ? ` ❯ chat${chatTitleSuffix} `
                  : ` chat${chatTitleSuffix} `
            }
            titleColor={
              turn.phase === "running"
                ? SHELL_PALETTE.amber
                : composerFocused
                  ? SHELL_PALETTE.amberHi
                  : SHELL_PALETTE.faint
            }
            position="relative"
          >
            {/*
             * `overflow="hidden"` is the design's own clip, not a defensive extra: `chatSeq`
             * stops drawing at `composerTop - 1` (`design/termcraft-engine.js:571`, and again
             * inside every per-entry loop), so chat content physically cannot reach the composer
             * or the panel's bottom border. Without it, any row the budget below mis-predicts
             * paints straight over both — which is exactly how a long agent reply used to
             * overwrite the composer's own `Ask for changes…` row.
             */}
            <box id="ws-chat-stream" flexGrow={1} flexDirection="column" overflow="hidden">
              {agentLabel !== "" && (
                <text id="ws-chat-agent" fg={SHELL_PALETTE.green} attributes={BOLD}>
                  {`● ${agentLabel}`}
                </text>
              )}
              {/*
               * The persisted chat scrollback (design §3.2: "the block collapses into the
               * persisted agent record… above" — spec:149-160). Fed by the mirror's `records`
               * slice (WP-10 Task 7, the active chat's tail) and painted ABOVE the ephemeral
               * block below — never mixed with it, matching `design/03-workspace-generating.
               * dc.html`'s `chatSeq`/`drawChat` layering (persisted seq entries, then the live
               * `⠹ generating design…` block).
               */}
              <ChatScrollback
                id="ws-scrollback"
                records={records}
                agentLabel={agentLabel}
                width={chatContentWidth}
                maxRows={scrollbackRows}
              />
              {/* Below the persisted tail, above the live turn block — chronologically the crash
                  follows the turn that produced the design, which is exactly where the design
                  draws it (`wsHostCrash`'s own `chatSeq`). */}
              {previewNotice !== null && (
                <SystemNotice
                  id="ws-preview-notice"
                  headline={previewNotice.headline}
                  detail={previewNotice.detail}
                />
              )}
              {turn.phase === "running" && (
                <AgentStatusBlock
                  id="ws-agent"
                  startedAt={turn.startedAt}
                  gateRetries={turn.gateRetries.map((retry) => ({
                    retryNumber: retry.retryNumber,
                  }))}
                  {...foldTurnTimeline({
                    entries: turn.timeline,
                    // design `chatSeq`: text is drawn at `tx+2` inside `iw = chatW-3`, and
                    // `thinkRow` wraps at `iw-2` — so the thread's own wrap width is `chatW-5`.
                    width: Math.max(8, chatW - 5),
                    maxRows: agentBlockMaxRows,
                    // The design's `full`/`long` cap; `short`/`first` use 3/4 per frame.
                    liveCap: 5,
                  })}
                />
              )}
              {turn.phase === "terminal" && (
                <ChatRecord
                  id="ws-record"
                  role="agent"
                  agentLabel={agentLabel}
                  dim
                  lines={terminalLines}
                />
              )}
              {/*
               * DIVERGENCE (M12 data-source gap): the mirror carries `PinDtoV1` but no
               * per-pin anchor-resolution signal — anchor resolution is a host-render
               * concern (`rectOf`, spec §4.2) and `PreviewOverlays` places every open pin
               * by fraction without ever marking one an orphan. So `visible` has no kernel
               * source yet; `derivePinListRows` passes `visible: true` for every pin
               * (matching what the preview always draws) until a render-resolved
               * element-id set reaches the mirror. The full open/resolved/orphan row
               * structure and the exact §3.2 "not visible…" marker copy are implemented in
               * `PinList` and stay dormant for the orphan case, rather than fabricating a
               * resolution signal. `derivePinListRows` also numbers each open pin's badge
               * among open pins only, matching `PreviewOverlays`' own numbering.
               */}
              <PinList id="ws-pins" pageSlug={activePageSlug ?? ""} pins={pinRows} />
            </box>
            <Composer
              id="ws-composer"
              modelChip={modelChip}
              ctx={ctx}
              ctxCaution={ctx !== null && ctx >= 80}
              // finding §2.5 (phase-8 Task 16): a running turn no longer forces `disabled` on
              // its own. `design/03-workspace-generating.dc.html`'s own prose (the `ws-gen-
              // typing-120` paragraph) draws the line exactly here: "Empty, it shows the faint
              // ❯ generating… esc to cancel placeholder with no caret. Holding a draft it looks
              // alive, because it is: amber ❯, text in full foreground, blinking caret." — i.e.
              // an EMPTY composer during a turn still reads as disabled (faint caret, no
              // cursor), but a non-empty draft does not, matching `wsGenTyping`
              // (`design/termcraft-engine.js:259-277`) exactly.
              disabled={
                props.readOnly ||
                !composerFocused ||
                (turn.phase === "running" && composerValue.length === 0)
              }
              placeholder={composerPlaceholder}
              value={composerValue}
              attach={composerAttach}
            />
            {
              // design/termcraft-engine.js:966 (`slashMenu(){ const rows=…; if(!rows.length)
              // return 0; …}`) and :155 (`if(rows.length) this.slashBox(...)`) both refuse to
              // draw the widget at all once there is nothing to show — `SlashMenu` itself always
              // opens its bordered, titled box unconditionally, so the guard belongs here.
              // Without it, typing a slash prefix past every match (e.g. `/commit-x`) left an
              // empty amber-bordered box titled with whatever was typed, because `intent.ts`'s
              // `slash-input` case appends every character with no re-check and only
              // `slash-backspace` at length 0 closes the overlay. Matches `Home.tsx`'s own
              // `props.rows.length > 0 &&` guard for the identical component.
              slashOpen && slashRows.length > 0 && (
                <box id="ws-slash-anchor" position="absolute" left={0} right={0} bottom={3}>
                  <SlashMenu
                    id="ws-slash-menu"
                    typed={composerValue}
                    rows={slashRows}
                    selectedIndex={local.slashSelection()}
                  />
                </box>
              )
            }
          </box>
        )}
        <box
          id="ws-preview"
          flexGrow={1}
          height={frameH}
          flexDirection="column"
          overflow="hidden"
          border
          borderStyle="rounded"
          borderColor={previewBorderColor}
        >
          {renderTabs(tabs, tabStripWidth, onTabMouseDown)}
          <PreviewPaneRule
            id="ws-preview-rule"
            width={previewRegion.w}
            color={previewBorderColor}
          />
          {/* design `paneShell`: `dy = 4` — one blank row between the rule and the design. */}
          <box id="ws-preview-gap" height={1} />
          {renderPreviewRegion(preview, uiFrame, descriptors.length > 0, opening, previewRegion, {
            pins,
            pendingPin,
            selectionRect,
            hover,
            onRendered: acknowledgeRenderedFrame,
            onMouseMove: onPreviewMouseMove,
            onMouseDown: onPreviewMouseDown,
          })}
        </box>
      </box>
      <StatusBar
        id="ws-status"
        width={w}
        // DIVERGENCE (design sample data + no runtime source): `wsOpening` opens its bar with a
        // ` codex · gpt5.5 · high ` chip. `StatusBar` has no combo segment at all — every workspace
        // frame after §07 passes `combo:false`, which is exactly what `buildLeftSegments` implements —
        // and while the project is opening `mirror.agentIdentity()` is still null, so there is no
        // honest value to draw. The segment is dropped; every other segment of the opening bar is
        // implemented verbatim.
        mode={
          // design `wsOpening`: ` OPENING `, not ` STATIC `. STATIC asserts a finished,
          // unchanging design, which is exactly the claim this state cannot make.
          opening
            ? { text: "OPENING", fg: "bg", bg: "amber" }
            : modeChip(turn, fullscreen, props.readOnly, previewHalt)
        }
        page={
          // The page slot is FILLED, not dropped: there is no page slug yet, so it carries
          // Home's own phrase for the same state, verbatim (design `wsOpening`, and
          // `Home.tsx:337` for the identical slot choice).
          opening
            ? { text: narrow ? "opening…" : "opening project…", fg: "amber", bold: true }
            : activePageSlug !== null
              ? { text: activePageSlug, fg: "dim" }
              : null
        }
        // design `wsOpening`: the size segment is one of the two things dropped at the floor.
        size={opening && narrow ? null : { w, h, min: minSize }}
        ctx={ctx}
        ctxCaution={ctx !== null && ctx >= 80}
        hint={
          // design 30, "The badge vocabulary": precedence, highest first — read-only, turn
          // running, preview halt, agent health, none.
          //
          // `turn running` MUST outrank health by rule, not by taste: while a turn runs the agent
          // is alive by demonstration, and a stale `✗ … not signed in` sitting under it would
          // contradict what is happening on screen in the same second.
          //
          // Preview halt outranks health because it is the more urgent, more specific fact — and
          // §30 answers the collision directly: the halt keeps the slot, and the halt PANEL says
          // what health would have said (see `HostCrashPanel`'s `agentDead`).
          props.readOnly
            ? { text: "Send · Tweaks · pins disabled", fg: "faint", bg: "line" }
            : // finding §2.5 (phase-8 Task 16): design/termcraft-engine.js:1005-1006 (`wsSlashTurn`)
              // / :275-276 (`wsGenTyping`) — `hint:'⚠ turn running — send disabled'`, and
              // `wsStatus`'s own defaults (`:494`) resolve an unstyled hint to `fg:P.amberHi,
              // bg:P.line` exactly.
              turn.phase === "running"
              ? { text: "⚠ turn running — send disabled", fg: "amberHi", bg: "line" }
              : // Each halted screen's own hint, red on redDim: `render crashed`
                // (`wsHostCrash`) or `host unavailable` (`wsHostUnavailable`).
                previewHalt !== null
                ? {
                    text: previewHalt.designAtFault ? "render crashed" : "host unavailable",
                    fg: "red",
                    bg: "redDim",
                  }
                : healthBadge
        }
        hintKeys={
          // design `wsOpening`: `keys:[['⏎','send','dis']]` and nothing else. F2/F3/F4 are
          // dropped rather than drawn inert — none of the three has anything to act on yet (no
          // preview, no page to tweak or interact with), and Home's own `checking` state shows
          // the same restraint.
          opening ? OPENING_HINT_KEYS : hintKeys(turn, fullscreen, previewHalt)
        }
      />
    </box>
  );
}, "ui.Workspace");
