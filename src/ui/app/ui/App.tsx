import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { reatomComponent, useWrap } from "@reatom/react";

import { Home } from "ui/home";
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
import { resolveKey } from "../model/keymap";

const HOME_COMBO = { agent: "codex", model: "gpt-5.5", effort: "high" } as const;

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

/** Maps the open-overlay atom / export state to the popup to render over the workspace, or null. */
function renderOverlay(deps: UiDeps) {
  const overlay = deps.local.overlay();
  if (overlay === "chat-list") {
    const chats = deps.mirror.chats();
    // Design 24-chats.dc.html (wsChats): rows list newest-first. `chat-move`/`chat-switch`
    // (intent.ts) sort the very same summaries through the same helper, so the rendered row
    // order and the selection index they resolve always agree.
    const rows = sortChatSummariesNewestFirst(chats.summaries.values()).map((summary) => ({
      chatId: summary.chatId,
      label: summary.chatId.slice(0, 8),
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
  if (!exportPopupShowing(deps)) return null;
  const exportState = deps.mirror.export();
  if (exportState.phase === "done") {
    return (
      <ExportPopup
        id="overlay-export"
        projectName="design"
        paths={[".termcraft/export/design-prompt.md", ".termcraft/export/pages/*.tsx"]}
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
  // Unreachable: exportPopupShowing above narrowed the phase to "done" | "failed".
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
        overlay: deps.local.overlay(),
        composerValue: deps.local.composer(),
        exportPopupOpen: exportPopupShowing(deps),
        homeHealthPresent: deps.local.homeHealth().present,
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
    return (
      <Home
        id="app-home"
        width={size.w}
        height={size.h}
        health={deps.local.homeHealth()}
        prompt={deps.local.prompt()}
        combo={HOME_COMBO}
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
