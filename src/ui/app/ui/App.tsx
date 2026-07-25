import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { reatomComponent, useWrap } from "@reatom/react";

import { Home } from "ui/home";
import type { HomeAgentHealth, HomeCombo } from "ui/home";
import { MIN_FRAME, sortChatSummariesNewestFirst } from "ui/mirror";
import {
  ChatListPopup,
  ExportFailurePopup,
  ExportPopup,
  PinInputPopup,
  TrustPrompt,
} from "ui/popups";
import { EnlargePlaceholder } from "ui/preview";
import { SHELL_PALETTE } from "ui/theme";
import { Workspace } from "ui/workspace";

import type { UiDeps } from "../model/deps";
import { applyIntent } from "../model/intent";
import { resolveActiveOverlay, resolveKey } from "../model/keymap";

/**
 * Home's `agent ‹…› model ‹…› effort ‹…›` combo (design/01-home.dc.html's `home()`). DIVERGENCE
 * (design sample data, not layout): the design hardcodes `agent ‹codex› model ‹gpt-5.5›` as
 * sample identity strings (user decision 2026-07-23). Home is shown before any project/kernel
 * snapshot exists, so `agent`/`model`/`effort` all come from the SAME M15 health probe the
 * health line below the combo already reads — never a hardcoded fallback.
 *
 * `effort` — WP-4 (`BackendCapabilities.defaultSelection`, `core/ports/agent-backend.ts`) gives
 * the backend a real declared default (`claudeCapabilities()`: `claude-sonnet-5` at `high`).
 * Phase-8 Task 9 (WP-5) is what finishes routing it: `entrypoint/model/agent-health.ts`'s
 * `createAgentHealthProbe` folds `capabilities().defaultSelection` into the SAME
 * `HomeAgentHealth` reading `healthCheck()` produces — a SELECTION fact riding along the one
 * probe injection point Home actually has, not a fact `healthCheck()` itself reports.
 * `HomeAgentHealth.effort` (`ui/home/types.ts`) now exists to carry it, so this is a genuine
 * live read, not a literal kept in sync by hand.
 */
function homeCombo(health: HomeAgentHealth): HomeCombo {
  return { agent: health.agent ?? "", model: health.model ?? "", effort: health.effort ?? "" };
}

/**
 * True while an undismissed `export.completed`/`export.failed` result is showing (M14): the
 * popup shows once per `operationId` and hides once `local.exportDismissed` matches it. There
 * is no kernel export-ack command (`core/protocol`'s `CommandKindV1` has no such member), so
 * dismissal lives entirely in this UI-local flag — both `renderOverlay` and the key-context
 * builder below read it, so the rendered popup and the keys that can dismiss it always agree.
 */
function exportPopupShowing(deps: UiDeps): boolean {
  const exportState = deps.mirror.export();
  if (exportState.phase !== "done" && exportState.phase !== "failed") return false;
  return exportState.operationId !== deps.local.exportDismissed();
}

/**
 * Maps the open-overlay atom / export state to the popup to render over the workspace, or null.
 *
 * Precedence is resolved by {@link resolveActiveOverlay} — the SAME function the `onKey` handler
 * below calls to build `resolveKey`'s context — so a stored overlay (chat-list/pin-input/
 * slash-menu) always outranks an undismissed export result for BOTH what is drawn here and which
 * surface receives Enter/Esc. `"slash-menu"` is rendered inline by `Workspace` (the non-modal
 * slash anchor), so it resolves to no modal layer here — it still outranks the export popup.
 */
function renderOverlay(deps: UiDeps) {
  const overlay = resolveActiveOverlay(deps.local.overlay(), exportPopupShowing(deps));
  if (overlay === "chat-list") {
    const chats = deps.mirror.chats();
    // Design 24-chats.dc.html (wsChats): rows list newest-first. `chat-move`/`chat-switch`
    // (intent.ts) sort the very same summaries through the same helper, so the rendered row
    // order and the selection index they resolve always agree.
    const rows = sortChatSummariesNewestFirst(chats.summaries.values()).map((summary) => ({
      chatId: summary.chatId,
      // Design §3.9: "a chat's display name is derived… the first line of its first `user`
      // record" (Kernel-derived, `ChatSummaryV1.displayName`, WP-10 Task 4). A freshly-created
      // chat carries `displayName: null` until its first `user` record lands; the pre-existing
      // `chatId.slice(0, 8)` fallback for that window is unchanged — only the label SOURCE
      // changes here, not the fallback itself (WP-10 Task 9).
      label: summary.displayName ?? summary.chatId.slice(0, 8),
      when: summary.createdAt,
      active: summary.chatId === chats.activeChatId,
    }));
    return (
      <ChatListPopup id="overlay-chats" rows={rows} selectedIndex={deps.local.chatSelection()} />
    );
  }
  if (overlay === "pin-input") {
    return <PinInputPopup id="overlay-pin" value={deps.local.pinDraft()} />;
  }
  if (overlay !== "export") return null;
  const exportState = deps.mirror.export();
  if (exportState.phase === "done") {
    return (
      <ExportPopup
        id="overlay-export"
        // DIVERGENCE: the design's sample popup names a project ("system-monitor") and lists
        // several written-file paths — but the real wire payload (`ExportTerminalPayloadV1`,
        // the mirror's `ExportMirror` "done" variant) carries no project-name field at all
        // (`ProjectMirror` only has a `projectId` UUID) and only ONE `destination` identity
        // string, no per-file manifest. `env.root` — the same folder identity `TrustPrompt`
        // already shows the user (`folder={deps.env.root}` above) — is the closest real stand-in
        // for "which project", and the single real `destination` replaces the invented glob
        // paths, rather than fabricating either.
        projectName={deps.env.root}
        paths={[exportState.destination]}
        caveat="reads current page.tsx on disk · incl uncommitted"
      />
    );
  }
  if (exportState.phase === "failed") {
    return (
      <ExportFailurePopup
        id="overlay-export"
        pageSlug={exportState.pageSlug}
        sizeBytes={exportState.sizeBytes}
        safeMessage={exportState.failure?.safeMessage ?? "export failed"}
      />
    );
  }
  // Unreachable: exportPopupShowing (via resolveActiveOverlay) above narrowed the phase to
  // "done" | "failed".
  return null;
}

/**
 * The app root (design §3.x). Owns the Kernel subscription (feeding the mirror), tracks the
 * terminal size, consumes the live `PreviewSession` frames, wires the global keyboard through
 * the pure keymap + intent layer, and mounts the screen the mirror's `screenAtom` selects.
 * A `reatomComponent`: reading `screen()`/mirror slices re-renders it as Kernel events arrive.
 *
 * DIVERGENCE: modal overlays render over the workspace without a dimmed backdrop (flexbox
 * makes re-dimming the whole tree costly); the popups themselves match the design. Overlay
 * open-triggers beyond Esc-to-close are minimal in this MVP pass — the components and logic
 * are built and unit-tested; richer open flows are follow-up wiring.
 */
export const App = reatomComponent<{ deps: UiDeps }>((props) => {
  const { deps } = props;

  // Activate the Kernel subscription + preview-frame consumer for this component's lifetime;
  // both are owned by the `runtime` atom's connect hook and stop when the App unmounts.
  deps.runtime();

  // Sync the external terminal size into the mirror-driving atom. A guarded render-time set
  // (not an effect) — the repo ships no `@types/react`, so `useEffect` is unavailable, and
  // this converges: the write only fires when the size actually changed.
  const dims = useTerminalDimensions();
  if (deps.terminal().w !== dims.width || deps.terminal().h !== dims.height) {
    deps.terminal.set({ w: dims.width, h: dims.height });
  }

  const onKey = useWrap((key: KeyEvent) => {
    applyIntent(
      resolveKey(key, {
        screen: deps.screen(),
        focus: deps.local.focus(),
        // The SAME precedence call `renderOverlay` makes above — one source of truth for which
        // surface owns the keys, not a second independently derived export-popup check (M14 fix).
        overlay: resolveActiveOverlay(deps.local.overlay(), exportPopupShowing(deps)),
        composerValue: deps.local.composer(),
        homeHealthPresent: deps.local.homeHealth().present,
        turnRunning: deps.mirror.turn().phase === "running",
      }),
      deps,
    );
  }, "ui.App.onKey");
  useKeyboard(onKey);

  // --- render ---
  const screen = deps.screen();
  const size = deps.terminal();

  if (screen === "enlarge") {
    return (
      <EnlargePlaceholder
        id="app-enlarge"
        width={size.w}
        height={size.h}
        now={{ w: size.w, h: size.h }}
        need={{ w: MIN_FRAME.w, h: MIN_FRAME.h }}
      />
    );
  }

  if (screen === "home") {
    const health = deps.local.homeHealth();
    return (
      <Home
        id="app-home"
        width={size.w}
        height={size.h}
        health={health}
        prompt={deps.local.prompt()}
        combo={homeCombo(health)}
      />
    );
  }

  if (screen === "trust-prompt") {
    return (
      <box
        id="app-trust"
        width={size.w}
        height={size.h}
        backgroundColor={SHELL_PALETTE.bg}
        position="absolute"
        top={0}
        left={0}
        alignItems="center"
        justifyContent="center"
      >
        <TrustPrompt id="app-trust-prompt" folder={deps.env.root} />
      </box>
    );
  }

  // Workspace owns the non-modal slash anchor; App owns only modal centered overlays.
  const overlay = renderOverlay(deps);
  return (
    <box
      id="app-root"
      width={size.w}
      height={size.h}
      backgroundColor={SHELL_PALETTE.bg}
      position="relative"
    >
      <Workspace deps={deps} readOnly={screen === "read-only"} />
      {overlay !== null && (
        <box
          id="app-modal-layer"
          position="absolute"
          top={0}
          left={0}
          width={size.w}
          height={size.h - 1}
          alignItems="center"
          justifyContent="center"
        >
          {overlay}
        </box>
      )}
    </box>
  );
}, "ui.App");
