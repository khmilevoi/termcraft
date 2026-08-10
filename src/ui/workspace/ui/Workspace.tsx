import { createRequire } from "node:module";

import { MouseButton, type MouseEvent, type ScrollBoxRenderable } from "@opentui/core";
import { bind, wrap } from "@reatom/core";
import { reatomComponent, useWrap } from "@reatom/react";

import type { PageDescriptorV1, PinDtoV1 } from "core/protocol";
import { log, trace } from "infrastructure/debug-log";
import { HOTKEYS, filterSlashRows } from "ui/actions";
import type { HotkeyAction } from "ui/actions";
import { agentBlockedNote, agentHealthBadge } from "ui/agent-health";
import {
  AgentStatusBlock,
  ChatRecord,
  ChatScrollback,
  Composer,
  PinList,
  SystemNotice,
  foldTurnTimeline,
} from "ui/chat";
import type { MarkdownLine } from "ui/chat";
import type { UiPreviewFrame } from "ui/kernel";
import type { PreviewMirror, TurnMirror } from "ui/mirror";
import { PIN_INPUT_POPUP_SIZE, PinInputPopup } from "ui/popups";
import {
  EmptyState,
  ErrorPanel,
  FrameView,
  HostCrashPanel,
  HostUnavailablePanel,
  PreviewOverlays,
  acknowledgeFrame,
  frameLocalPoint,
  hostFailureCodeOf,
  isDesignRenderFailure,
  pageEntryOf,
  pinInputAnchor,
  requestElementRects,
  requestGeometry,
} from "ui/preview";
import type { ElementRectIndex, HoverGeometry, PendingPin, Rect } from "ui/preview";
import { SlashMenu } from "ui/slash-menu";
import { StatusBar } from "ui/status-bar";
import type { StatusBarHintKey, StatusBarModeChip, StatusBarSegment } from "ui/status-bar";
import { editorRowCount } from "ui/text-input";
import type { EditorBridge } from "ui/text-input";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import { agentStatusMaxRows } from "../model/agent-block-budget";
import { deriveComposerAttach } from "../model/attach";
import type { OverlayKind } from "../model/focus";
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

/**
 * `useRef`, reached the way `ui/testing/model/react-renderer.ts` and
 * `host/render/model/error-capture.ts` already reach React values: this project installs no
 * `@types/react`, and `@opentui/react` re-exports exactly one React value (`createElement`,
 * `node_modules/@opentui/react/src/index.d.ts:8`) — so a plain `import { useRef } from "react"`
 * is a TS7016 implicit-any error. `createRequire` plus an explicit, minimal type for the one
 * value pulled out (matching `react-renderer.ts`'s own `ReactAct` shape) keeps `viewportRef`
 * below fully typed without adding a real dependency on `@types/react`.
 */
type UseRef = <T>(initialValue: T) => { current: T };
const { useRef } = createRequire(import.meta.url)("react") as { readonly useRef: UseRef };

const BOLD = shellAttrs({ bold: true });

/**
 * The one halted-preview fact the panel, the status bar, the composer attach line and the chat
 * notice all four read — derived once in `Workspace` so the four can never disagree about
 * whether the host halted or whose fault it was.
 */
type PreviewHalt = null | { readonly retryAvailable: boolean; readonly designAtFault: boolean };

/**
 * The five status-bar/composer facts the "filling" (opening) state overrides, bundled so a
 * future change to the opening presentation touches one function body instead of five scattered
 * `filling ? … : …` branches (review finding 4, 2026-08-03). Deliberately excludes
 * `renderPreviewRegion`'s own `filling` branch (a full JSX subtree, not a small value) and the
 * mode-chip/hint-key TABLES for the non-filling states — `modeChip`/`hintKeys` below still branch
 * on turn/fullscreen/readOnly/previewHalt independently, since `filling` and those facts are
 * mutually exclusive by construction (`readOnly` needs a non-null projectId, `filling` needs a
 * null one) and never need to be checked together.
 */
function workspaceOpeningChrome(w: number): {
  readonly modeChip: StatusBarModeChip;
  readonly hintKeys: readonly StatusBarHintKey[];
  readonly composerPlaceholder: string;
  readonly page: StatusBarSegment;
  /** Whether the status bar's `size` segment stays hidden while opening (`w < 100`). */
  readonly hidesSize: boolean;
} {
  return {
    // ` OPENING `, not ` STATIC ` (design 30): STATIC asserts a finished, unchanging design,
    // which is exactly the claim this state cannot make.
    modeChip: { text: "OPENING", fg: "bg", bg: "amber" },
    // design/termcraft-engine.js:247 — `[['⏎','send','dis']]`, nothing else. F2/F3/F4 are
    // DROPPED rather than drawn inert: none of the three has anything to act on yet (no
    // preview, no page to tweak or interact with), and Home's own `checking` state shows the
    // same restraint.
    hintKeys: [["⏎", "send", "dis"]],
    // design/termcraft-engine.js:239 (`chatSeq`'s own `placeholder`).
    composerPlaceholder: "project opening…",
    // Home's own phrase, verbatim, in the slot that is free because there is no page slug yet
    // (design 30 §"Mid-open"). `opening…` below 100 columns, matching the engine's own
    // `narrow` branch (`:243`).
    page: { text: w >= 100 ? "opening project…" : "opening…", fg: "amber", bold: true },
    // The engine drops the size segment below 100 columns in this state (`:244`). The idle
    // bar has never implemented that narrow branch — a pre-existing divergence, out of scope
    // here — but this state is new code and follows the design it was drawn for.
    hidesSize: w < 100,
  };
}

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
  // CORRECTED (review finding I5): a bare `.toUpperCase()` read `pageup`/`pagedown` as
  // `PAGEUP`/`PAGEDOWN` — two spellings of the same key on one screen, since
  // `ChatScrollback`'s own retry row already writes the design's literal `PgUp`
  // (`design/termcraft-engine.js:1505-1506`).
  if (key === "pageup") return "PgUp";
  if (key === "pagedown") return "PgDn";
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
  // `following`/`atStart`/`olderPageFailed` (review finding I5): the chat-scroll key entries
  // this row derives from `HOTKEYS` all vary with the chat viewport's own state, not merely
  // with the four facts this function already took.
  chat: Readonly<{ following: boolean; atStart: boolean; olderPageFailed: boolean }>,
): readonly StatusBarHintKey[] {
  if (fullscreen) return fullscreenHint("windowed");
  // design/termcraft-engine.js:1005-1006 (`wsSlashTurn`) / :275-276 (`wsGenTyping`).
  if (turn.phase === "running") {
    // CORRECTED (review finding I5): `wsScrollLive` (`design/termcraft-engine.js:1605`) is a
    // THIRD running-turn key row the citation above doesn't cover — scrolled away from a live
    // block that keeps growing off-screen below. Its row drops the disabled-send hint for the
    // scroll/follow trio instead: there is nothing to send toward (the turn already owns the
    // composer), but there IS somewhere to scroll back to.
    if (!chat.following) {
      return [
        ...HOTKEYS.filter(
          (action) => action.id === "chat.scroll-up" || action.id === "chat.scroll-down",
        ).map((action) => hotkeyHint(action)),
        ...HOTKEYS.filter((action) => action.id === "chat.follow-latest").map((action) =>
          hotkeyHint(action),
        ),
        ["esc", "cancel"],
      ];
    }
    return [
      ["⏎", "send", "dis"],
      ["esc", "cancel"],
    ];
  }
  // `preview.retry` and `preview.repair` are advertised ONLY where they actually act. Showing
  // them unconditionally would put a live-looking `F5 retry`/`F6 repair` in the status bar for
  // the entire session, for actions that do nothing in every other phase — the same "advertised
  // but inert" trap this file's own `dis` state and the `q`/`/exit` divergence exist to avoid.
  //
  // `F6` additionally requires the PAGE to be at fault: `wsHostUnavailable`'s own key row is
  // `F5 · F2 · F3` with no repair key at all, because no page edit could start a host.
  //
  // `chat.scroll-up`/`chat.follow-latest` are ALSO conditional (review finding I5): PgUp drops
  // at the true start of chat — `wsScrollStart`'s own key row is `PgDn`-only, there is nothing
  // above to page to — and `^D follow` draws only while `!following`, matching every mockup
  // that shows it (`wsScrollMid`/`wsScrollLive`; `wsScrollLoaded`/`wsScrollLoading`/
  // `wsScrollFailed`/`wsScrollStart` all omit it).
  return HOTKEYS.filter((action) => {
    // A key bound without being drawn (the page-step extension, `HotkeyAction.hint`) never
    // enters the row: this row is a transcription of the design's own key rows.
    if (action.hint === false) return false;
    if (action.id === "preview.retry") return previewHalt !== null;
    if (action.id === "preview.repair") return previewHalt?.designAtFault === true;
    if (action.id === "chat.scroll-up") return !chat.atStart;
    if (action.id === "chat.follow-latest") return !chat.following;
    return true;
  }).map((action): StatusBarHintKey => {
    if (action.id === "preview.retry" && previewHalt?.retryAvailable === false)
      // Both no-retry variants mark F5 `dis` in the key row.
      return [hotkeyGlyph(action.key), action.label, "dis"];
    // design/termcraft-engine.js:1505-1506 / `ChatScrollback`'s own "PgUp retries" row copy:
    // the SAME gesture that requested the failed page retries it.
    if (action.id === "chat.scroll-up" && chat.olderPageFailed)
      return [hotkeyGlyph(action.key), "retries"];
    return hotkeyHint(action);
  });
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

/** The `❯ ` caret run `Composer` draws before the editor — two cells, matching `drawChat` `:651`. */
const COMPOSER_CARET_COLUMNS = 2;

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

/** Selects the preview region content: enlarge is handled by the App; here empty/error/frame/ready. */
/**
 * The new-pin comment box, anchored beside its own badge inside the preview canvas (design
 * `wsPinInput`, `design/termcraft-engine.js:695-701`; spec §3.2 "a mini input opens at the
 * click point"). It is NOT one of the App's centred modal overlays — the click point only
 * means anything in this canvas' coordinate space, which is why the box is drawn here.
 */
function renderPinInput(
  bridge: EditorBridge,
  pending: PendingPin,
  bounds: Rect,
  readOnly: boolean,
) {
  const at = pinInputAnchor({ badge: pending.point, box: PIN_INPUT_POPUP_SIZE, bounds });
  return (
    <box id="ws-pin-input-anchor" position="absolute" left={at.x} top={at.y}>
      {/* §7.5: the field is live except on a read-only screen, where pins are refused outright. */}
      <PinInputPopup id="overlay-pin" focused={!readOnly} bridge={bridge} />
    </box>
  );
}

function renderPreviewRegion(
  preview: PreviewMirror,
  uiFrame: UiPreviewFrame | null,
  /**
   * The Kernel's page list — read here ONLY to name the crashed page's real file
   * (`pageEntryOf`). A slug cannot name a file since the design tree, so the panel is handed
   * the descriptor list rather than deriving a path (task 16).
   */
  descriptors: readonly PageDescriptorV1[],
  hasPages: boolean,
  region: CellSize,
  interaction: Readonly<{
    pins: readonly PinDtoV1[];
    /** The displayed frame's element rectangles, or `null` until its `layout` reply lands. */
    elementRects: ElementRectIndex | null;
    pendingPin: PendingPin | null;
    /**
     * The new-pin comment field's wiring, non-null exactly while the `pin-input` overlay is the
     * active one. The box is anchored beside the pending pin's badge rather than centred in the
     * App's modal layer (spec §3.2: it "opens at the click point"), so it is drawn here, inside
     * the preview canvas that owns those coordinates.
     */
    pinInputBridge: EditorBridge | null;
    selectionRect: Rect | null;
    hover: HoverGeometry | null;
    onRendered: (frame: UiPreviewFrame) => void;
    onMouseMove: (event: MouseEvent) => void;
    onMouseDown: (event: MouseEvent) => void;
  }>,
  filling: boolean,
  agentBlocked: ReturnType<typeof agentBlockedNote>,
  readOnly: boolean,
) {
  if (filling) {
    // design/termcraft-engine.js:237-238. Distinct from §20's `No pages yet` (a finished project
    // that genuinely has none) and §14's `⠹ generating first page…` (a running, cancellable
    // turn). Neither is true here, so this is a plain amber line with no glyph in front of it —
    // NOTHING SPINS. Drawing a spinner over a state with no cancel and nothing measurable would
    // borrow a promise this state cannot keep.
    return (
      <box
        id="ws-preview-opening"
        flexGrow={1}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
      >
        <text id="ws-preview-opening-headline" fg={SHELL_PALETTE.amber} attributes={BOLD}>
          opening project…
        </text>
        {/* The engine leaves one blank row between the two lines (`dh/2-1` and `dh/2+1`). */}
        <text id="ws-preview-opening-spacer"> </text>
        <text id="ws-preview-opening-detail" fg={SHELL_PALETTE.faint}>
          reading .termcraft — preview arrives when it&apos;s ready
        </text>
      </box>
    );
  }
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
          entryRelPath={pageEntryOf(descriptors, preview.pageSlug)}
          hostMessage={preview.finalFailure.safeMessage}
          attempts={preview.attempts}
          retryAvailable={preview.retryAvailable}
          agentBlocked={agentBlocked}
        />
      );
    }
    // The host never got as far as the page (spec §3.2.1) — a spawn failure, a handshake
    // timeout, a broken pipe, a runtime-integrity mismatch. A mount/first-frame timeout is
    // NOT one of these (design §9.4): the handshake already proved the child alive, so that
    // hang is the page's, routed to `HostCrashPanel` above instead. Design `wsHostUnavailable`
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
    // What the canvas actually SHOWS of that frame. The pin-input box is placed against this,
    // not against `frameRect`: a box anchored past the clip would simply vanish.
    const visibleRect = {
      x: 0,
      y: 0,
      width: Math.min(uiFrame.frame.width, region.w),
      height: Math.min(uiFrame.frame.height, region.h),
    };
    return (
      <box
        id="ws-preview-canvas"
        position="relative"
        // Clamped to the region, not sized by the frame: a frame the host has not yet
        // re-rendered at the current pane size (see `previewTargetSize` in
        // `ui/app/model/deps.ts`) is a transient the pane clips, never an overdraw that
        // eats the pane's own border and the rows below it. `overflow="hidden"` is what
        // makes the clamp actually cut the content rather than merely mis-measure the box.
        width={visibleRect.width}
        height={visibleRect.height}
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
          elementRects={interaction.elementRects}
          pendingPin={interaction.pendingPin}
          selectionRect={interaction.selectionRect}
          hover={interaction.hover}
        />
        {interaction.pinInputBridge !== null &&
          interaction.pendingPin !== null &&
          renderPinInput(interaction.pinInputBridge, interaction.pendingPin, visibleRect, readOnly)}
      </box>
    );
  }
  if (readOnly) {
    // A never-before-trusted project that declined the trust prompt (spec §3.1) keeps preview
    // execution disabled for the rest of this run (`ui/app/model/deps.ts`'s
    // `createScreenAtom`/`ScreenInput.trustPromptDismissed`) — this replaces the generic
    // "preparing preview…" fallback below, which never resolves for a project the Kernel will
    // never render. DIVERGENCE (no `design/*.dc.html` mock covers this exact copy, matching the
    // precedent `TrustPrompt.tsx` already set for undesigned trust-related states): colors and
    // layout are reused from the already-approved `filling` branch above — amber headline, one
    // blank spacer row, faint detail line, no spinner, since nothing here is pending.
    return (
      <box
        id="ws-preview-read-only"
        flexGrow={1}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
      >
        <text id="ws-preview-read-only-headline" fg={SHELL_PALETTE.amber} attributes={BOLD}>
          preview disabled
        </text>
        <text id="ws-preview-read-only-spacer"> </text>
        <text id="ws-preview-read-only-detail" fg={SHELL_PALETTE.faint}>
          project is read-only — relaunch to be asked again
        </text>
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
export const Workspace = reatomComponent<{
  deps: WorkspaceDeps;
  readOnly: boolean;
  /**
   * Which surface owns the keys, ALREADY precedence-resolved by the App's own
   * `resolveActiveOverlay` — the same call `renderOverlay` and the key-context builder make. Read
   * here rather than re-derived from `local.overlay()` so the composer's focus, the popup that is
   * drawn, and the keys `resolveKey` routes can never disagree about who owns the keyboard.
   */
  activeOverlay: OverlayKind | null;
}>((props) => {
  const { mirror, terminal, previewFrame, local, interaction, dispatcher } = props.deps;
  const size = terminal();
  const turn = mirror.turn();
  const preview = mirror.preview();
  // The Workspace mounted before its project opened (spec 2026-08-02, design
  // `design/30-workspace-first-launch.dc.html`). NOT a new screen: `deriveScreen` returns
  // "workspace" for it, so filling in is a re-render rather than a remount.
  const filling = mirror.project().projectId === null;
  const descriptors = mirror.pageDescriptors();
  // The page the Workspace is showing — the tab-strip pick when there is one, else the Kernel's
  // own active slug (`../model/page-selection.ts`). Read ONCE here so the tab strip, the pin
  // list, the composer attach line and the status bar all name the same page.
  const activePageSlug = props.deps.activePageSlug();
  const uiFrame = previewFrame();
  const composerFocused = local.focus() === "composer";
  const fullscreen = local.fullscreen();
  const composerValue = local.composer();
  const slashOpen = !props.readOnly && props.activeOverlay === "slash-menu";
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
  // The bundled opening-state overrides (see `workspaceOpeningChrome`'s own doc comment).
  // Computed unconditionally, right after `w` becomes available — it's cheap and pure, and
  // every call site below just picks it with its own `filling ? opening.X : …` ternary.
  const opening = workspaceOpeningChrome(w);
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
  // Only the DISPLAYED frame's rectangles count. The atom is already cleared on every
  // acknowledgement, so this guard is belt-and-braces against reading a reply that landed for
  // a frame the shell has since replaced.
  const resolvedRects = interaction.elementRects();
  const elementRects =
    resolvedRects !== null && resolvedRects.frameToken === interaction.displayedFrameToken()
      ? resolvedRects.rects
      : null;
  const pinRows = derivePinListRows(pins, elementRects);
  const history = mirror.history();
  const records = history.records;
  // Read once, like `history` above — the status-bar key row's "retries" label (review finding
  // I5) and `ChatScrollback`'s own indicator row must read the identical latch.
  const olderPage = local.olderPage();
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
  // The `hint` slot holds ONE badge. Precedence, highest first (design 30 §"The badge
  // vocabulary"): read-only → turn running → preview halt → agent health → none. `turn running`
  // must outrank health by rule — a live turn demonstrates the agent is alive, so a stale
  // `✗ not signed in` under it would contradict what is happening on screen in the same second.
  // Health sits last among the real tiers: it is a permanent, ambient fact, not an urgent one.
  //
  // DIVERGENCE (narrow-bar layout, pre-existing): the engine's
  // `workspace()` drops its whole left cluster — hint included — below 100 columns (`:274`). This
  // component has never implemented that narrow branch, which is why its `⚠ turn running` hint
  // also survives at 80 columns; health follows the slot's existing behaviour in the short form
  // the design itself defines (`agentBadge`'s `opt.short`, and `wsOpen80` which keeps the badge at
  // 80), rather than introducing a narrow rule for one badge alone.
  //
  // INHERITED DIVERGENCE (already documented at `Home.tsx:56`): `StatusBarHintBadge` is plain
  // text and cannot host a live component, so the `⠹` this renders is static, not animated.
  const healthBadge = agentHealthBadge(local.agentHealth(), { short: w < 100 });
  // Only the crash panel takes it: `HostUnavailablePanel` names no repair key at all (the host
  // never got as far as the page), so there is no F6 promise there to correct.
  const agentBlocked = agentBlockedNote(local.agentHealth());
  // Read once here, like `activePageSlug`/`previewHalt` above: the composer attach line
  // (design iteration 10 answers 2/6) and the status-bar key row below both branch on it, and
  // reading it twice would risk the two disagreeing about whether the pane is following.
  const following = local.chatFollowing();
  const composerAttach = deriveComposerAttach({
    readOnly: props.readOnly,
    following,
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
  // — not bare `frameH`, which ignores `ws-chat`'s own border. The `<scrollbox>` mounted below
  // (chat-scroll spec §5.2/§5.3) now clips every OTHER sibling this block used to budget around
  // (the persisted scrollback, the pin list, the composer), so this only measures what physically
  // cannot hold a timeline row inside the block's own frame — see `agentStatusMaxRows`'s own doc
  // comment (`../model/agent-block-budget.ts`).
  const agentBlockMaxRows = agentStatusMaxRows({ frameH, chromeRows: AGENT_BLOCK_CHROME_ROWS });
  // `ws-chat`'s own inner content width: the panel's width less its left/right border. This is
  // what every `<text>` inside `ws-chat-stream` wraps against, and — less the caret run — what
  // the composer's editor wraps against too.
  const chatContentWidth = Math.max(1, chatW - 2);
  const composerEditorWidth = Math.max(1, chatContentWidth - COMPOSER_CARET_COLUMNS);
  const composerEditorRows = editorRowCount({
    text: composerValue,
    width: composerEditorWidth,
    frameH,
  });
  const terminalLines = turn.phase === "terminal" ? terminalRecordLines(turn) : [];
  const selectionRect = interaction.selectionRect();
  const hover = interaction.hover();
  const pendingPin = interaction.pendingPin();
  const acknowledgeRenderedFrame = useWrap((rendered: UiPreviewFrame) => {
    acknowledgeFrame(props.deps, rendered);
    // Every pin on the page is placed against this frame's own element rectangles, so they are
    // asked for the moment the frame becomes query-authorising. `requestElementRects` is a
    // no-op while one is in flight or already answered, and OpenTUI calls this back on every
    // repaint — which is exactly the retry path for a query the Kernel refused.
    requestElementRects(props.deps);
  }, "ui.Workspace.acknowledgeRenderedFrame");
  // The live chat scroll surface, published for the keyboard layer (`ChatViewport`,
  // `../types.ts`) — see that interface's own doc comment for why an imperative ref, not a
  // Reatom-derived value, is what bridges the renderable to `applyIntent`.
  const viewportRef = useRef<ScrollBoxRenderable | null>(null);
  // Both set by `maybeLoadOlder` right before it dispatches, read (and cleared) by the
  // position-retention check below once the load actually lands — see that check's own doc
  // comment for why the widget needs this at all (chat-scroll spec §6.6/§9, Task 2 probe
  // finding 5, `docs/spikes/2026-08-03-scrollbox-findings.md`: `<scrollbox>` does NOT hold
  // scroll position across a prepend on its own).
  const pendingAnchor = useRef<number | null>(null);
  // The renderable's own `scrollHeight` at the moment `pendingAnchor` was captured — read
  // alongside `recordCountBeforeLoad` below by the position-retention check to know the
  // prepended content has actually been laid out, not merely that the Kernel event carrying it
  // has arrived.
  const heightBeforeLoad = useRef<number | null>(null);
  // The active chat's loaded record count at the same moment — the position-retention check's
  // real gate (see that function's own doc comment for why `scrollHeight` differing ALONE is
  // not enough).
  const recordCountBeforeLoad = useRef<number | null>(null);
  // A monotonically-increasing token, bumped on every `maybeRestorePosition` call while a
  // restore is pending — see that function's own doc comment for what it debounces.
  const restoreToken = useRef(0);

  /**
   * POSITION RETENTION (chat-scroll spec §9, Task 2 probe finding 5,
   * `docs/spikes/2026-08-03-scrollbox-findings.md`): `<scrollbox>` does NOT hold scroll position
   * across a prepend on its own. Restores the distance-from-bottom `maybeLoadOlder` captured
   * just before dispatching, so a page that grows the window above the reader's position doesn't
   * yank them somewhere else in the stream.
   *
   * Called from `box.content.onSizeChange` (wired in `publishChatViewport` below), NOT checked
   * from `Workspace`'s own render body. A render-body check (matching the task brief's own
   * prescribed shape) WAS tried first and is the simpler of the two — but confirmed during this
   * task's TDD pass, it only gets ONE chance to see `scrollHeight` catch up: `Workspace` (a
   * `reatomComponent`) re-renders exactly once when `records`/`olderPage` settle together in one
   * Reatom transaction, and nothing forces it to render again afterward, while `scrollHeight`'s
   * own update comes from `<scrollbox>`'s INTERNAL `content.onSizeChange` -> `recalculateBarProps()`
   * — an OpenTUI-internal callback backed by no Reatom atom, so nothing guarantees it has
   * finished by that one render. `content.onSizeChange` IS the authoritative "this renderable's
   * own layout just changed" signal, so hooking it directly needs no race with React re-renders
   * at all — but see the two safeguards below, both found necessary by this same TDD pass.
   *
   * GATED ON RECORD COUNT, not merely on `scrollHeight` differing from the snapshot: also
   * confirmed during this task's TDD pass, `content.onSizeChange` fires for ANY layout change on
   * the content renderable, including the indicator row's own one-line ("loading") to two-line
   * ("failed") growth — a load that never actually grows the record window at all. Reading
   * `mirror.history()` here (a Reatom atom call, always current, unlike a plain closed-over
   * variable) tells apart "the window actually grew" from "the indicator merely got taller."
   *
   * DEBOUNCED, not applied on the first differing reading: also confirmed during this task's TDD
   * pass, laying out a large prepended batch fires `content.onSizeChange` multiple times with
   * intermediate, not-yet-final heights — a single React commit does not lay out every affected
   * Yoga node in one synchronous step. Applying the restore on every qualifying firing (not just
   * the first) keeps it correct at each intermediate step; `restoreToken` defers CLEARING
   * `pendingAnchor` to a microtask, so a later firing in the same burst still finds it set and
   * can correct the earlier, now-stale restore. Only the LAST firing's microtask survives
   * uninvalidated — any newer firing bumps the token first, turning the stale one into a no-op.
   */
  const maybeRestorePosition = () => {
    const anchor = pendingAnchor.current;
    const box = viewportRef.current;
    if (anchor === null || box === null) return;
    if (mirror.history().records.length === recordCountBeforeLoad.current) return;
    if (box.scrollHeight === heightBeforeLoad.current) return;
    box.scrollTop = Math.max(0, box.scrollHeight - box.viewport.height - anchor);
    const token = ++restoreToken.current;
    queueMicrotask(() => {
      // A newer firing already invalidated this one — its OWN microtask is the one that gets
      // to finalize.
      if (token !== restoreToken.current) return;
      pendingAnchor.current = null;
      heightBeforeLoad.current = null;
      recordCountBeforeLoad.current = null;
    });
  };

  /** Whether `box`'s own scroll position currently shows the tail — the one expression
   *  {@link ChatViewport.atBottom} and the `chatFollowing` tracking below both need; kept in one
   *  place so the two can never drift apart on what "at the bottom" means. */
  const isAtBottom = (box: ScrollBoxRenderable) =>
    box.scrollTop + box.viewport.height >= box.scrollHeight;

  /**
   * Publishes the live `ScrollBoxRenderable` as a {@link ChatViewport} (chat-scroll spec §5.5).
   * `useWrap` because the callback writes a Reatom atom from React's commit phase — outside any
   * Reatom frame otherwise (RTM-C02).
   */
  const publishChatViewport = useWrap((box: ScrollBoxRenderable | null) => {
    viewportRef.current = box;
    if (box === null) {
      local.chatViewport.set(null);
      return;
    }
    // Wraps, rather than replaces, `<scrollbox>`'s OWN `content.onSizeChange` handler (set
    // inside its constructor to call its own `recalculateBarProps()`, `node_modules/@opentui/
    // core`) — overwriting it outright would silently break the widget's own scrollbar/sticky-
    // scroll bookkeeping. `bind` (RTM-A04), not `useWrap`: this handler is invoked LATER by
    // OpenTUI, from outside any Reatom frame, the same shape `deps.ts`'s own
    // `bind((frame) => previewFrame.set(frame))` and `bind(() => pageOverride.set(null))` are
    // already used for — `maybeRestorePosition` reads `mirror.history()`, a Reatom atom read,
    // which needs the frame `bind` restores just as much as a write would.
    const scrollboxOwnOnSizeChange = box.content.onSizeChange;
    box.content.onSizeChange = bind(() => {
      scrollboxOwnOnSizeChange?.call(box.content);
      maybeRestorePosition();
    });
    local.chatViewport.set({
      scrollByPage(direction) {
        box.scrollBy({ x: 0, y: direction }, "viewport");
        maybeLoadOlder();
      },
      scrollToBottom() {
        box.scrollTo({ x: 0, y: box.scrollHeight });
        // `^D` (design iteration 10 answers 2/6, review finding I2/I3) always lands exactly at
        // the tail, so this is unconditionally the follow state — no read-back needed.
        local.chatFollowing.set(true);
      },
      atBottom() {
        return isAtBottom(box);
      },
      anchorFromBottom() {
        return box.scrollHeight - box.scrollTop - box.viewport.height;
      },
      restoreAnchor(distanceFromBottom) {
        box.scrollTop = Math.max(0, box.scrollHeight - box.viewport.height - distanceFromBottom);
      },
    });
  }, "ui.Workspace.publishChatViewport");

  /** How close to the top edge counts as "at the top" — one row of slack, so a wheel step that
   *  lands at 1 rather than 0 still pages. */
  const TOP_TRIGGER_ROWS = 1;

  /**
   * The ONE paging trigger (chat-scroll spec §6.6), reached from all three routes: the wheel
   * (`onMouseScroll` below), the keyboard (through the adapter's own `scrollByPage` above, which
   * `applyIntent`'s `chat-scroll-up`/`chat-scroll-down` cases call), and a click on the
   * indicator row (`ChatScrollback`'s `onLoadOlder` below). Four guards, in the order they can
   * refuse most cheaply.
   *
   * ALSO the one place `chatFollowing` (design iteration 10 answers 2/6, review finding I2)
   * refreshes: every route above is a route through here, so recomputing it first, before any of
   * this function's OWN gates, covers the wheel and the keyboard in one spot rather than three.
   * The indicator-row click is along for the ride too — harmless, since that row is reachable
   * only near the top, where `isAtBottom` already reads `false`.
   *
   * `withAsync` is deliberately NOT used here even though it is this project's default
   * (RTM-A02/A03), and the reason is worth stating: the operation does not complete when the
   * dispatch promise resolves — it completes when `chat.records.older` arrives. The dispatch
   * promise reports only whether the dispatcher itself refused, which is handled in the
   * established `.then(wrap(...))` form.
   */
  const maybeLoadOlder = useWrap(() => {
    const box = viewportRef.current;
    if (box === null) return;
    local.chatFollowing.set(isAtBottom(box));
    if (box.scrollTop > TOP_TRIGGER_ROWS) return;

    const held = mirror.history();
    if (held.prevCursor === null) return;
    if (local.olderPage().kind === "loading") return;

    const chatId = mirror.chats().activeChatId;
    if (chatId === null) return;
    // No affordance for an unavailable action: §7.1 fixes the untrusted-read-only exemption
    // list at three commands by name, so paging is genuinely unavailable there. Checking the
    // mirrored capability keeps the stream from showing a failure the user cannot act on.
    if (mirror.capabilities().get("chat.load-older")?.available !== true) return;

    pendingAnchor.current = box.scrollHeight - box.scrollTop - box.viewport.height;
    heightBeforeLoad.current = box.scrollHeight;
    recordCountBeforeLoad.current = mirror.history().records.length;
    local.olderPage.set({ kind: "loading" });
    void dispatcher.dispatch("chat.load-older", { chatId, cursor: held.prevCursor }).then(
      wrap((result) => {
        if (result instanceof Error) {
          log.error("UI command dispatch failed:", result);
          // CORRECTED (review round 2): a dispatcher-level refusal — a transport failure here,
          // `CAPABILITY_UNAVAILABLE` or similar below — happens BEFORE any Kernel round trip
          // ever touches the chat file, so it is not a `chat.records.older` load failure.
          // §11 answer 4's own literal (`design/termcraft-engine.js:1505`,
          // `'chat file could not be read'`) illustrates THAT failure — `wsScrollFailed`'s own
          // sample data is a genuine disk-read problem — and would misstate the cause here. The
          // real load-failure path stays exactly as designed: `mirror.lastOlderPageFailure()`
          // feeds `olderPage`'s own `withComputed` (`ui/app/model/deps.ts`) with the Kernel's
          // actual `safeMessage`, untouched by this branch. This generic, bounded message —
          // this task's own original placeholder, restored — describes only what is actually
          // known: the dispatch itself was not accepted.
          local.olderPage.set({ kind: "failed", safeMessage: "the page could not be requested" });
          return;
        }
        if (result.status !== "accepted")
          local.olderPage.set({ kind: "failed", safeMessage: "the page could not be requested" });
      }),
    );
  }, "ui.Workspace.maybeLoadOlder");

  // DIAGNOSTIC (infrastructure/debug-log): added while investigating "pins don't work" — traces
  // the "select"/"pin" leg only (never "hover", which fires on every mouse-move) so a right-click
  // that never reaches `requestGeometry` at all — no live frame yet — is visible too, not just
  // the requests that got that far.
  const requestAtMouse = (purpose: "hover" | "select" | "pin", event: MouseEvent) => {
    const current = previewFrame();
    if (current === null) {
      if (purpose !== "hover") {
        trace("ui.Workspace.requestAtMouse", {
          purpose,
          step: "refused",
          reason: "no previewFrame",
          absolute: { x: event.x, y: event.y },
        });
      }
      return;
    }
    const origin = previewFrameOrigin(size, fullscreen);
    const frameRect = {
      x: origin.x,
      y: origin.y,
      width: current.frame.width,
      height: current.frame.height,
    };
    const point = frameLocalPoint({ absolute: { x: event.x, y: event.y }, frameRect });
    if (purpose !== "hover") {
      trace("ui.Workspace.requestAtMouse", {
        purpose,
        step: "dispatching",
        absolute: { x: event.x, y: event.y },
        frameRect,
        point,
      });
    }
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
  const composerPlaceholder = props.readOnly
    ? "read-only — Send disabled"
    : filling
      ? opening.composerPlaceholder
      : turn.phase === "running"
        ? "generating… esc to cancel"
        : composerFocused
          ? "Ask for changes…"
          : "tab → focus composer";
  // §7.5's focus table. The composer keeps the keys while the slash menu is open — the filter IS
  // this buffer — and loses them to any modal overlay, to a preview-focused Tab, and on a
  // read-only screen. Exactly one editor is focused at any moment, which is a requirement rather
  // than a coincidence: the terminal has one hardware cursor.
  const composerEditorFocused =
    !props.readOnly &&
    composerFocused &&
    (props.activeOverlay === null || props.activeOverlay === "slash-menu");

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
               * THE SCROLL VIEWPORT (chat-scroll spec §5.1). It owns everything between the
               * `● agent` presence line and the pin list: the persisted scrollback, the
               * preview notice, and whichever ephemeral block is on screen. Pinned OUTSIDE
               * it, deliberately: the `● agent` line (panel header, not a message), `PinList`
               * (attached composer context, not a message), the composer, the panel border.
               *
               * Follow-the-tail and its disengagement on manual scroll are the renderable's
               * OWN behavior (`stickyScroll` + `stickyStart`); this project implements
               * neither. `publishChatViewport` below is the {@link ChatViewport} adapter over
               * this live renderable; `onMouseScroll` is one of the paging trigger's three
               * routes (chat-scroll spec §6.6 — the other two are the keyboard, through the
               * adapter's own `scrollByPage`, and a click on `ChatScrollback`'s indicator row
               * below).
               */}
              <scrollbox
                id="ws-chat-scroll"
                ref={publishChatViewport}
                onMouseScroll={maybeLoadOlder}
                flexGrow={1}
                // `flexBasis={0}` is load-bearing, not decoration (verified with a standalone
                // Yoga repro during this task): `<scrollbox>` is a composite renderable whose
                // OWN internal tree includes an always-present horizontal scrollbar row, so its
                // "auto" flex-basis (the default that `flexGrow` alone leaves in place) is a
                // small NON-zero intrinsic size rather than 0. Left at "auto", that intrinsic
                // size gets added on top of this item's grown share, quietly stealing exactly
                // one row from `PinList` below it. `flex-basis: 0` (the standard `flex: 1 1 0`
                // idiom) removes the intrinsic-content contribution entirely, so `flexGrow`
                // purely distributes `ws-chat-stream`'s free space instead.
                flexBasis={0}
                scrollY
                scrollX={false}
                stickyScroll
                stickyStart="bottom"
                // DIVERGENCE (design vs. `@opentui/core`'s `SliderRenderable`, chat-scroll spec
                // §11 answer 3): the design's `scrollbar()` (`design/termcraft-engine.js:1478-
                // 1484`) draws a `│` line character for the track in `P.line`, but the widget's
                // track ("non-thumb") cells are always a blank, color-filled space — there is no
                // per-glyph override in `ScrollBarOptions`/`SliderOptions`
                // (`node_modules/@opentui/core/renderables/ScrollBar.d.ts`,`Slider.d.ts`). A
                // solid dim rail (`backgroundColor: SHELL_PALETTE.line`) is the closest faithful
                // mapping for the track. The thumb needs no such compromise: the widget's own
                // default thumb glyphs are already exactly `█`/`▀`/`▄`, matching the design's
                // thumb characters, so only its colour (`SHELL_PALETTE.amberDim`) is set.
                scrollbarOptions={{
                  showArrows: false,
                  trackOptions: {
                    foregroundColor: SHELL_PALETTE.amberDim,
                    backgroundColor: SHELL_PALETTE.line,
                  },
                }}
              >
                {/*
                 * The persisted chat scrollback (design §3.2: "the block collapses into the
                 * persisted agent record… above" — spec:149-160). Fed by the mirror's `records`
                 * slice (WP-10 Task 7, the active chat's tail) and painted ABOVE the ephemeral
                 * block below — never mixed with it, matching `design/03-workspace-generating.
                 * dc.html`'s `chatSeq`/`drawChat` layering (persisted seq entries, then the live
                 * `⠹ generating design…` block). The row budget it used to enforce is gone
                 * (WP-10 Task 10) — this `<scrollbox>` clips instead (chat-scroll spec §5.2).
                 */}
                <ChatScrollback
                  id="ws-scrollback"
                  records={records}
                  agentLabel={agentLabel}
                  width={chatContentWidth}
                  unloadedCount={Math.max(0, history.totalRecordCount - records.length)}
                  atStart={history.prevCursor === null}
                  olderPage={olderPage}
                  onLoadOlder={maybeLoadOlder}
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
              </scrollbox>
              {/*
               * Anchor resolution is a host-render concern (`rectOf`, spec §4.2) and the
               * mirror still carries no per-pin signal — but it does not need to: the frame's
               * own `layout` reply names every element the render contains, so a pin whose
               * element is missing from `elementRects` IS the §3.2 orphan, and `PinList`'s
               * "not visible in the current render" row finally has a real source. Both
               * surfaces read the same map, so the preview and this list can never disagree
               * about which pins are on screen — and `derivePinListRows` numbers each open
               * pin among open pins only, matching `PreviewOverlays`' own numbering.
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
              attach={composerAttach}
              focused={composerEditorFocused}
              rows={composerEditorRows}
              width={composerEditorWidth}
              bridge={props.deps.editors.composer}
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
          {renderPreviewRegion(
            preview,
            uiFrame,
            descriptors,
            descriptors.length > 0,
            previewRegion,
            {
              pins,
              elementRects,
              pendingPin,
              pinInputBridge: props.activeOverlay === "pin-input" ? props.deps.editors.pin : null,
              selectionRect,
              hover,
              onRendered: acknowledgeRenderedFrame,
              onMouseMove: onPreviewMouseMove,
              onMouseDown: onPreviewMouseDown,
            },
            filling,
            agentBlocked,
            props.readOnly,
          )}
        </box>
      </box>
      <StatusBar
        id="ws-status"
        width={w}
        mode={filling ? opening.modeChip : modeChip(turn, fullscreen, props.readOnly, previewHalt)}
        // Known divergence: the engine's wide `wsOpening` bar also carries a leading
        // ` codex · gpt5.5 · high ` combo chip (`:242`). `StatusBarProps` has no combo slot at
        // all — `StatusBar.tsx`'s own comment records that every workspace screen after §07
        // passes `combo:false` — so this bar drops it exactly as every other Workspace bar
        // already does. Not a new divergence; inherited.
        page={
          filling
            ? opening.page
            : activePageSlug !== null
              ? { text: activePageSlug, fg: "dim" }
              : null
        }
        size={filling && opening.hidesSize ? null : { w, h, min: minSize }}
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
          filling
            ? opening.hintKeys
            : hintKeys(turn, fullscreen, previewHalt, {
                following,
                atStart: history.prevCursor === null,
                olderPageFailed: olderPage.kind === "failed",
              })
        }
      />
    </box>
  );
}, "ui.Workspace");
