import { MouseButton, type MouseEvent } from "@opentui/core";
import { reatomComponent, useWrap } from "@reatom/react";

import type { PinDtoV1 } from "core/protocol";
import { HOTKEYS, filterSlashRows } from "ui/actions";
import type { HotkeyAction } from "ui/actions";
import { AgentStatusBlock, ChatRecord, Composer } from "ui/chat";
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
  return [hotkeyGlyph(action.key), label, action.inert === true];
}

function fullscreenHint(label: string): readonly StatusBarHintKey[] {
  return HOTKEYS.filter((action) => action.id === "preview.fullscreen").map((action) =>
    hotkeyHint(action, label),
  );
}

/** The right-aligned hint keys for the current state (design `hintKeys` defaults). */
function hintKeys(turn: TurnMirror, fullscreen: boolean): readonly StatusBarHintKey[] {
  if (fullscreen) return fullscreenHint("windowed");
  if (turn.phase === "running") return [["esc", "cancel"], ...fullscreenHint("full")];
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

  const w = size.w;
  const h = size.h;
  const chatW = Math.round(w * 0.37);
  const frameH = h - 1;
  const ghostSlug =
    turn.phase === "running" && descriptors.length === 0 ? project.activePageSlug : null;
  const tabs = deriveTabs(descriptors, project.activePageSlug, ghostSlug);
  const active = descriptors.find((descriptor) => descriptor.pageSlug === project.activePageSlug);
  const minSize = active !== undefined && active.status === "ready" ? active.minSize : null;
  const ctx = turn.phase === "running" ? (turn.usage?.contextPercent ?? null) : null;
  const pins =
    project.activePageSlug === null ? [] : (mirror.pinsByPage().get(project.activePageSlug) ?? []);
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
            borderColor={composerFocused ? SHELL_PALETTE.amber : SHELL_PALETTE.line}
            title={composerFocused ? "❯ chat · codex" : "chat · codex"}
            titleColor={composerFocused ? SHELL_PALETTE.amberHi : SHELL_PALETTE.faint}
            position="relative"
          >
            <box id="ws-chat-stream" flexGrow={1} flexDirection="column">
              <text id="ws-chat-agent" fg={SHELL_PALETTE.green} attributes={BOLD}>
                ● codex
              </text>
              {turn.phase === "running" && (
                <AgentStatusBlock
                  id="ws-agent"
                  agentName="codex"
                  connection="working"
                  spinner="⠹"
                  steps={turn.steps.map((step, index) => ({
                    op: step.op,
                    target: step.target,
                    done: index < turn.steps.length - 1,
                  }))}
                  reasoning={turn.reasoning}
                  gateRetries={turn.gateRetries.map((retry) => ({
                    retryNumber: retry.retryNumber,
                  }))}
                />
              )}
              {turn.phase === "terminal" && (
                <ChatRecord id="ws-record" role="codex" dim lines={terminalRecordLines(turn)} />
              )}
            </box>
            <Composer
              id="ws-composer"
              modelChip="codex · gpt5.5 · high"
              ctx={ctx}
              ctxCaution={ctx !== null && ctx >= 80}
              disabled={props.readOnly || turn.phase === "running" || !composerFocused}
              placeholder={composerPlaceholder}
              value={composerValue}
              attach={props.readOnly ? { text: "read-only — Send disabled", fg: "red" } : null}
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
          {renderTabs(tabs, w - chatW)}
          {renderPreviewRegion(preview, uiFrame, descriptors.length > 0, w - chatW, frameH - 3, {
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
          props.readOnly ? { text: "Send · Tweaks · pins disabled", fg: "faint", bg: "line" } : null
        }
        hintKeys={hintKeys(turn, fullscreen)}
      />
    </box>
  );
}, "ui.Workspace");
