import { reatomComponent } from "@reatom/react";

import type { PreviewFrameV1 } from "core/ports";
import { HOTKEYS, filterSlashRows } from "ui/actions";
import type { HotkeyAction } from "ui/actions";
import { AgentStatusBlock, ChatRecord, Composer } from "ui/chat";
import type { MarkdownLine } from "ui/chat";
import type { PreviewMirror, TurnMirror } from "ui/mirror";
import { EmptyState, ErrorPanel, FrameView } from "ui/preview";
import { SlashMenu } from "ui/slash-menu";
import { StatusBar } from "ui/status-bar";
import type { StatusBarHintKey, StatusBarModeChip } from "ui/status-bar";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import { deriveTabs } from "../model/tabs";
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

/** Renders the ordered tab strip (design `drawTabs`): ▸ active amber-bold, dim inactive, faint ghost. */
function renderTabs(tabs: readonly TabEntry[]) {
  return (
    <box id="ws-tabs" flexDirection="row">
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
    </box>
  );
}

/** Selects the preview region content: enlarge is handled by the App; here empty/error/frame/ready. */
function renderPreviewRegion(
  preview: PreviewMirror,
  frame: PreviewFrameV1 | null,
  hasPages: boolean,
  width: number,
  height: number,
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
  if (frame !== null) return <FrameView id="ws-preview-frame" frame={frame} />;
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
  const { mirror, terminal, previewFrame, local } = props.deps;
  const size = terminal();
  const turn = mirror.turn();
  const preview = mirror.preview();
  const descriptors = mirror.pageDescriptors();
  const project = mirror.project();
  const frame = previewFrame()?.frame ?? null;
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
          {renderTabs(tabs)}
          {renderPreviewRegion(preview, frame, descriptors.length > 0, w - chatW, frameH - 3)}
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
