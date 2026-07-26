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
  foldTurnTimeline,
} from "ui/chat";
import type { MarkdownLine } from "ui/chat";
import type { UiPreviewFrame } from "ui/kernel";
import type { PreviewMirror, TurnMirror } from "ui/mirror";
import {
  EmptyState,
  ErrorPanel,
  FrameView,
  PreviewOverlays,
  acknowledgeFrame,
  frameLocalPoint,
  requestGeometry,
} from "ui/preview";
import type { HoverGeometry, PendingPin, Rect } from "ui/preview";
import { SlashMenu } from "ui/slash-menu";
import { StatusBar } from "ui/status-bar";
import type { StatusBarHintKey, StatusBarModeChip } from "ui/status-bar";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import { deriveComposerAttach } from "../model/attach";
import { derivePinListRows } from "../model/pins";
import { deriveTabs, tabsOverflow } from "../model/tabs";
import type { TabEntry } from "../model/tabs";
import type { WorkspaceDeps } from "../types";

const BOLD = shellAttrs({ bold: true });

/** The status-bar mode chip for the current turn/fullscreen state (design mode-chip literals). */
function modeChip(turn: TurnMirror, fullscreen: boolean, readOnly: boolean): StatusBarModeChip {
  if (readOnly) return { text: "READ-ONLY", fg: "amberHi", bg: "line" };
  if (turn.phase === "running") return { text: "GENERATING", fg: "bg", bg: "amber" };
  if (fullscreen) return { text: "FULLSCREEN", fg: "bg", bg: "amber" };
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
function hintKeys(turn: TurnMirror, fullscreen: boolean): readonly StatusBarHintKey[] {
  if (fullscreen) return fullscreenHint("windowed");
  // design/termcraft-engine.js:1005-1006 (`wsSlashTurn`) / :275-276 (`wsGenTyping`).
  if (turn.phase === "running")
    return [
      ["⏎", "send", "dis"],
      ["esc", "cancel"],
    ];
  return HOTKEYS.map((action) => hotkeyHint(action));
}

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
 * The rows `AgentStatusBlock` always draws OUTSIDE the folded timeline — the `● agent` presence
 * line, the connection meta line, and the spinner line (3 fixed rows; gate-retry rows are NOT
 * counted here, since they're bounded at 3 and rare — underestimating the budget by that amount
 * on the rare turn that has both a long timeline AND active retries just makes the fold trigger
 * one row earlier than strictly necessary, never a layout break). Subtracted from `frameH` so the
 * timeline's own `maxRows` budget leaves room for this block's own chrome, not just itself.
 */
const AGENT_BLOCK_CHROME_ROWS = 3;

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
 * `width` is the preview column's outer width (matching `tabsOverflow`'s own best-effort
 * estimate, `../model/tabs.ts`); the strip box is bounded to `width - 2` — the parent
 * `ws-preview` box's own left/right `border` — so `overflow="hidden"` clips the tab content
 * the way the engine's fixed-width character buffer naturally would, and the trailing `›`
 * (pinned with `position="absolute" right={0}`) always lands at the strip's true right edge
 * instead of after however much tab content the row would otherwise emit (which, since the
 * preview column is flush against the terminal's own right edge, would render past the
 * canvas and never appear at all).
 */
function renderTabs(tabs: readonly TabEntry[], width: number) {
  const overflow = tabsOverflow(tabs, width);
  const stripWidth = Math.max(0, width - 2);
  return (
    <box
      id="ws-tabs"
      flexDirection="row"
      position="relative"
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

/** Selects the preview region content: enlarge is handled by the App; here empty/error/frame/ready. */
function renderPreviewRegion(
  preview: PreviewMirror,
  uiFrame: UiPreviewFrame | null,
  hasPages: boolean,
  width: number,
  height: number,
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
  if (preview.phase === "failed") {
    return (
      <ErrorPanel
        id="ws-preview-error"
        width={width}
        height={height}
        headline="could not render current design"
        cause={preview.failure.safeMessage}
        nextStep="fix it in a repair turn — the composer stays open"
        restoreHint={null}
      />
    );
  }
  if (preview.phase === "circuit-open") {
    return (
      <ErrorPanel
        id="ws-preview-circuit"
        width={width}
        height={height}
        headline="preview stopped after repeated failures"
        cause={preview.finalFailure.safeMessage}
        nextStep={
          preview.retryAvailable ? "press retry to try again" : "the preview is unavailable"
        }
        restoreHint={null}
      />
    );
  }
  if (!hasPages) return <EmptyState id="ws-preview-empty" width={width} height={height} />;
  if (uiFrame !== null) {
    const frameRect = { x: 0, y: 0, width: uiFrame.frame.width, height: uiFrame.frame.height };
    return (
      <box
        id="ws-preview-canvas"
        position="relative"
        width={uiFrame.frame.width}
        height={uiFrame.frame.height}
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
  const descriptors = mirror.pageDescriptors();
  const project = mirror.project();
  const uiFrame = previewFrame();
  const composerFocused = local.focus() === "composer";
  const fullscreen = local.fullscreen();
  const composerValue = local.composer();
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
  const chatW = Math.round(w * 0.37);
  // Fullscreen (F2) drops the chat column entirely (`!fullscreen &&` below), so the preview pane
  // — tab strip and preview region alike — must claim the FULL terminal width, matching the
  // design engine's `paneShell(..., {noChat:true})` (`termcraft-engine.js:392-401`: `chatW=0`
  // when `noChat`, so `pw = w - 0 = w`). Previously both were sized `w - chatW` unconditionally,
  // clipping the tab strip ~chatW columns early and mis-sizing EmptyState/ErrorPanel/the ready
  // placeholder in fullscreen — `requestAtMouse` above already branches the same way
  // (`fullscreen ? 0 : chatW`) for the live frame's mouse-cell origin.
  const previewWidth = fullscreen ? w : w - chatW;
  const frameH = h - 1;
  const ghostSlug =
    turn.phase === "running" && descriptors.length === 0 ? project.activePageSlug : null;
  const tabs = deriveTabs(descriptors, project.activePageSlug, ghostSlug);
  const active = descriptors.find((descriptor) => descriptor.pageSlug === project.activePageSlug);
  const minSize = active !== undefined && active.status === "ready" ? active.minSize : null;
  const ctx = turn.phase === "running" ? (turn.usage?.contextPercent ?? null) : null;
  const pins =
    project.activePageSlug === null ? [] : (mirror.pinsByPage().get(project.activePageSlug) ?? []);
  const selection = mirror.selection();
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
    const frameRect = {
      x: (fullscreen ? 0 : chatW) + 1,
      y: 2,
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
  const onPreviewMouseDown = useWrap((event: MouseEvent) => {
    if (props.readOnly) return;
    if (event.button === MouseButton.RIGHT) return requestAtMouse("pin", event);
    if (event.button === MouseButton.LEFT) requestAtMouse("select", event);
  }, "ui.Workspace.onPreviewMouseDown");
  const composerPlaceholder = props.readOnly
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
                ? "❯ chat · working"
                : composerFocused
                  ? `❯ chat${chatTitleSuffix}`
                  : `chat${chatTitleSuffix}`
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
            <box id="ws-chat-stream" flexGrow={1} flexDirection="column">
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
                records={mirror.records()}
                agentLabel={agentLabel}
              />
              {turn.phase === "running" && (
                <AgentStatusBlock
                  id="ws-agent"
                  agentName={agentLabel}
                  connection="working"
                  startedAt={turn.startedAt}
                  gateRetries={turn.gateRetries.map((retry) => ({
                    retryNumber: retry.retryNumber,
                  }))}
                  {...foldTurnTimeline({
                    entries: turn.timeline,
                    // design `chatSeq`: text is drawn at `tx+2` inside `iw = chatW-3`, and
                    // `thinkRow` wraps at `iw-2` — so the thread's own wrap width is `chatW-5`.
                    width: Math.max(8, chatW - 5),
                    maxRows: Math.max(3, frameH - AGENT_BLOCK_CHROME_ROWS),
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
                  lines={terminalRecordLines(turn)}
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
              <PinList
                id="ws-pins"
                pageSlug={project.activePageSlug ?? ""}
                pins={derivePinListRows(pins)}
              />
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
              attach={deriveComposerAttach({
                readOnly: props.readOnly,
                selection,
                activePageSlug: project.activePageSlug,
                openPins: pins,
                turnRunning: turn.phase === "running",
                composerValue,
                slashOpen,
              })}
            />
            {slashOpen && (
              <box id="ws-slash-anchor" position="absolute" left={0} right={0} bottom={3}>
                <SlashMenu
                  id="ws-slash-menu"
                  typed={composerValue}
                  rows={slashRows}
                  selectedIndex={local.slashSelection()}
                />
              </box>
            )}
          </box>
        )}
        <box
          id="ws-preview"
          flexGrow={1}
          height={frameH}
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={composerFocused && !fullscreen ? SHELL_PALETTE.line : SHELL_PALETTE.amber}
        >
          {renderTabs(tabs, previewWidth)}
          {renderPreviewRegion(preview, uiFrame, descriptors.length > 0, previewWidth, frameH - 3, {
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
        mode={modeChip(turn, fullscreen, props.readOnly)}
        page={project.activePageSlug !== null ? { text: project.activePageSlug, fg: "dim" } : null}
        size={{ w, h, min: minSize }}
        ctx={ctx}
        ctxCaution={ctx !== null && ctx >= 80}
        hint={
          props.readOnly
            ? { text: "Send · Tweaks · pins disabled", fg: "faint", bg: "line" }
            : // finding §2.5 (phase-8 Task 16): design/termcraft-engine.js:1005-1006 (`wsSlashTurn`)
              // / :275-276 (`wsGenTyping`) — `hint:'⚠ turn running — send disabled'`, and
              // `wsStatus`'s own defaults (`:494`) resolve an unstyled hint to `fg:P.amberHi,
              // bg:P.line` exactly.
              turn.phase === "running"
              ? { text: "⚠ turn running — send disabled", fg: "amberHi", bg: "line" }
              : null
        }
        hintKeys={hintKeys(turn, fullscreen)}
      />
    </box>
  );
}, "ui.Workspace");
