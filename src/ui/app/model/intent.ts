import { wrap } from "@reatom/core";

import type { CommandResultV1 } from "core/protocol";
import { trace } from "infrastructure/debug-log";
import { filterSlashRows, resolveSlashAction, resolveUiAction } from "ui/actions";
import type { UiActionEntry } from "ui/actions";
import { sortChatSummariesNewestFirst } from "ui/mirror";
import { nextFocus, resolveEsc } from "ui/workspace";

import type { UiDeps } from "./deps";
import type { KeyIntent } from "./keymap";

/**
 * Applies one resolved {@link KeyIntent} — the effectful half of the keyboard layer. It
 * touches UI-local atoms and issues commands through the dispatcher; the App calls it from a
 * single `wrap`-ed `useKeyboard` handler (so every atom read/write and dispatch stays inside
 * one Reatom async frame, per the react-adapter rules). Kept out of the component so the
 * whole key→effect table is testable against a `FakeKernel` with no renderer.
 *
 * Command dispatches are deliberately fire-and-forget (`void`): the result of a UI-issued
 * command surfaces through the event stream (mirror), never through the dispatch return.
 *
 * RTM-S04 standing exception (audit 2026-07-24): the case arms of this switch ARE the named
 * grouped transitions — each arm is a single-call-site state change already named by its
 * intent kind, so its inline `.set()` groups are not re-extracted into one-off model actions.
 * Helpers exist in this file only for REUSE across call sites (`applyEsc`,
 * `closeStaleSlash`), not to rename an arm's own body.
 */
export function applyIntent(intent: KeyIntent, deps: UiDeps): void {
  const { local, dispatcher } = deps;

  switch (intent.kind) {
    case "home-input":
      local.prompt.set(local.prompt() + intent.ch);
      return;
    case "home-backspace":
      local.prompt.set(local.prompt().slice(0, -1));
      return;
    case "home-recheck":
      // No Kernel command reports agent health, and Home precedes any project/kernel.snapshot
      // (App.tsx's comment at HOME_HEALTH's former definition states this) — re-run the
      // injected probe instead (M15). Fire-and-forget, like every other dispatch here: the
      // result lands in local.homeHealth, which Home re-reads reactively.
      void deps.refreshHomeHealth();
      return;
    case "home-submit": {
      const text = local.prompt();
      if (text.length === 0) return;
      dispatchAndReport(
        dispatcher.dispatch("project.create", {
          root: deps.env.root,
          creationDefaults: { trust: "trusted", workspaceIdentity: deps.env.workspaceIdentity },
          text,
        }),
        "project.create",
      );
      return;
    }
    case "composer-input":
      local.composer.set(local.composer() + intent.ch);
      return;
    case "composer-backspace":
      local.composer.set(local.composer().slice(0, -1));
      return;
    case "composer-submit": {
      // DIAGNOSTIC (infrastructure/debug-log): both guards below return silently, so a submit
      // that dies here is indistinguishable on screen from one that was never pressed. Name
      // which guard swallowed it.
      if (deps.screen() === "read-only") {
        trace("ui.composerSubmit.refused", { reason: "screen is read-only" });
        return;
      }
      const text = local.composer();
      if (text.length === 0) {
        trace("ui.composerSubmit.refused", { reason: "composer is empty" });
        return;
      }
      trace("ui.composerSubmit.dispatching", { textLength: text.length });
      // Clears the composer ONLY once the Kernel actually accepted the turn (fix-bundle
      // Task 11 fix round 1, Finding 2) — a rejection (e.g. `TURN_ALREADY_ACTIVE`, reachable
      // in the brief window while Gap C's own auto-started first turn is still admitting)
      // must not discard what the user typed. Every other intent below keeps the ordinary
      // fire-and-forget `dispatchAndReport` shape; this is the one handler whose own local
      // state must survive a rejection, so it inlines the SAME tracing that helper does
      // rather than widening it for one caller. `wrap` (RTM-A04) around the continuation —
      // it touches `local.composer`, a Reatom atom, after the `await`/`.then()` boundary, the
      // SAME shape `ui/preview/model/interaction.ts`'s `dispatchGeometryRequest` already uses
      // for its own post-dispatch atom write.
      void dispatcher.dispatch("turn.start", { text }).then(
        wrap((result) => {
          if (result instanceof Error) {
            console.error("UI command dispatch failed:", result);
            trace("ui.dispatch.result", { kind: "turn.start", result });
            return;
          }
          trace("ui.dispatch.result", { kind: "turn.start", result });
          if (result.status === "accepted") local.composer.set("");
        }),
      );
      return;
    }
    case "action-execute": {
      const entry = resolveUiAction(intent.actionId);
      if (entry === null) return;
      executeAction(entry, deps);
      return;
    }
    case "slash-open": {
      if (deps.screen() !== "workspace") return;
      local.composer.set("/");
      local.overlay.set("slash-menu");
      return;
    }
    case "slash-input":
      if (!slashMenuActive(deps)) return closeStaleSlash(deps);
      local.composer.set(local.composer() + intent.ch);
      return;
    case "slash-backspace": {
      if (!slashMenuActive(deps)) return closeStaleSlash(deps);
      const next = local.composer().slice(0, -1);
      local.composer.set(next);
      if (next.length === 0) {
        local.overlay.set(null);
        return;
      }
      return;
    }
    case "slash-move":
      if (!slashMenuActive(deps)) return closeStaleSlash(deps);
      local.slashSelection.set(
        moveEnabledSelection(slashRows(deps), local.slashSelection(), intent.delta),
      );
      return;
    case "slash-submit": {
      if (!slashMenuActive(deps)) return closeStaleSlash(deps);
      const row = slashRows(deps)[local.slashSelection()];
      if (row === undefined || !row.state.enabled) return;
      const entry = resolveSlashAction(row.command);
      if (entry === null) return;
      local.composer.set("");
      local.overlay.set(null);
      executeAction(entry, deps);
      return;
    }
    case "chat-move": {
      const count = deps.mirror.chats().summaries.size;
      if (count === 0) return;
      local.chatSelection.set(wrapIndex(local.chatSelection() + intent.delta, count));
      return;
    }
    case "chat-switch": {
      // Sort through the same helper the popup's rendered rows use (App.tsx renderOverlay) so
      // the index `chatSelection` holds always targets the row the user sees selected.
      const selected = sortChatSummariesNewestFirst(deps.mirror.chats().summaries.values())[
        local.chatSelection()
      ];
      if (selected === undefined) return;
      dispatchAndReport(
        dispatcher.dispatch("chat.switch", { chatId: selected.chatId }),
        "chat.switch",
      );
      local.overlay.set(null);
      return;
    }
    case "pin-input":
      if (deps.screen() === "read-only") return;
      local.pinDraft.set(local.pinDraft() + intent.ch);
      return;
    case "pin-backspace":
      if (deps.screen() === "read-only") return;
      local.pinDraft.set(local.pinDraft().slice(0, -1));
      return;
    case "pin-save": {
      if (deps.screen() === "read-only") return;
      const pendingPin = deps.interaction.pendingPin();
      if (pendingPin === null) return;
      dispatchAndReport(
        dispatcher.dispatch("pin.create", {
          geometryToken: pendingPin.geometryToken,
          text: local.pinDraft(),
        }),
        "pin.create",
      );
      deps.interaction.pendingPin.set(null);
      local.pinDraft.set("");
      local.overlay.set(null);
      return;
    }
    case "trust-accept":
      dispatchAndReport(
        dispatcher.dispatch("project.setTrust", {
          trust: "trusted",
          workspaceIdentity: deps.env.workspaceIdentity,
        }),
        "project.setTrust:trusted",
      );
      return;
    case "trust-decline":
      dispatchAndReport(
        dispatcher.dispatch("project.setTrust", {
          trust: "untrusted-read-only",
          workspaceIdentity: deps.env.workspaceIdentity,
        }),
        "project.setTrust:untrusted-read-only",
      );
      return;
    case "overlay-dismiss":
      if (local.overlay() === "pin-input") {
        deps.interaction.pendingPin.set(null);
        local.pinDraft.set("");
      }
      local.overlay.set(null);
      return;
    case "export-dismiss": {
      // No kernel export-ack command exists (core/protocol's CommandKindV1 has no such
      // member) — record the dismissal UI-locally, keyed by operationId, so the popup shows
      // once per export and a later export.started re-shows it (M14).
      const exportState = deps.mirror.export();
      if (exportState.phase === "done" || exportState.phase === "failed") {
        local.exportDismissed.set(exportState.operationId);
      }
      return;
    }
    case "tab":
      local.focus.set(nextFocus(local.focus()));
      return;
    case "esc":
      applyEsc(deps);
      return;
    case "exit":
      // The `q` keys on the agent-missing/too-small-terminal screens (keymap.ts) resolve
      // directly to this intent; `/exit` reaches the SAME `requestExit` call through
      // `executeAction`'s `effect === "exit"` branch below (phase-8 Task 11 / WP-10) — one
      // shutdown trigger, two ways to reach it.
      deps.requestExit();
      return;
    case "none":
      return;
  }
}

function dispatchAndReport(promise: Promise<CommandResultV1 | Error>, kind: string): void {
  void promise.then((result) => {
    if (result instanceof Error) console.error("UI command dispatch failed:", result);
    // DIAGNOSTIC (infrastructure/debug-log): this function's ONLY visible reaction is the
    // `console.error` above, which fires just for a thrown/returned Error. A command the Kernel
    // REJECTS comes back as a perfectly ordinary `CommandResultV1` and is discarded right here
    // without a trace — by design ("the result surfaces through the event stream, never through
    // the dispatch return"), which means a guard refusal is invisible to the operator. Record
    // every outcome, accepted or refused.
    trace("ui.dispatch.result", { kind, result });
  });
}

function slashRows(deps: UiDeps) {
  return filterSlashRows(deps.local.composer(), deps.actionContext());
}

function slashMenuActive(deps: UiDeps): boolean {
  return deps.screen() === "workspace" && deps.local.overlay() === "slash-menu";
}

function closeStaleSlash(deps: UiDeps): void {
  if (deps.local.overlay() === "slash-menu") deps.local.overlay.set(null);
}

function wrapIndex(index: number, count: number): number {
  return ((index % count) + count) % count;
}

function moveEnabledSelection(
  rows: ReturnType<typeof slashRows>,
  selected: number,
  delta: -1 | 1,
): number {
  const enabled = rows.flatMap((row, index) => (row.state.enabled ? [index] : []));
  if (enabled.length === 0) return -1;
  const position = enabled.indexOf(selected);
  if (position === -1) return enabled[0] ?? -1;
  return enabled[wrapIndex(position + delta, enabled.length)] ?? -1;
}

function executeAction(entry: UiActionEntry, deps: UiDeps): void {
  const { execution } = entry;
  if (execution.kind === "inert") return;
  if (execution.kind === "command") {
    if (execution.command === "chat.create") {
      dispatchAndReport(deps.dispatcher.dispatch("chat.create", {}), "chat.create");
      return;
    }
    dispatchAndReport(deps.dispatcher.dispatch("export.start", {}), "export.start");
    return;
  }
  if (execution.effect === "fullscreen") {
    deps.local.fullscreen.set(!deps.local.fullscreen());
    return;
  }
  if (execution.effect === "exit") {
    // `/exit`, dispatched via the slash menu's `slash-submit` -> `action-execute` path.
    deps.requestExit();
    return;
  }
  const chats = deps.mirror.chats();
  const activeIndex = sortChatSummariesNewestFirst(chats.summaries.values()).findIndex(
    (summary) => summary.chatId === chats.activeChatId,
  );
  deps.local.chatSelection.set(activeIndex < 0 ? 0 : activeIndex);
  deps.local.overlay.set("chat-list");
}

/** Resolves and applies one `Esc` press against the layered stack (design §3.8). */
function applyEsc(deps: UiDeps): void {
  const turn = deps.mirror.turn();
  // Page-scoped exactly like `deriveComposerAttach` (`workspace/model/attach.ts`): the mirror
  // only clears `selection` on a fresh `kernel.snapshot`, never on a page switch, so an
  // unscoped read would still report a selection made on a page the user has since navigated
  // away from — deselecting it here would be a no-op the user never sees (the composer chip is
  // already hidden for it), silently eating the Esc press that should fall through instead
  // (TRIAGE #35).
  const selection = deps.mirror.selection();
  const hasSelection =
    selection !== null && selection.pageSlug === deps.mirror.project().activePageSlug;
  const outcome = resolveEsc({
    overlayOpen: deps.local.overlay(),
    focusAwayFromComposer: deps.local.focus() !== "composer",
    historicalBrowse: false,
    generationRunning: turn.phase === "running",
    hasSelection,
  });

  switch (outcome.kind) {
    case "close-overlay":
      deps.local.overlay.set(null);
      return;
    case "unfocus-to-composer":
      deps.local.focus.set("composer");
      return;
    case "cancel-generation":
      if (turn.phase === "running")
        dispatchAndReport(
          deps.dispatcher.dispatch("turn.cancel", { turnId: turn.turnId }),
          "turn.cancel",
        );
      return;
    case "deselect":
      dispatchAndReport(deps.dispatcher.dispatch("selection.clear", {}), "selection.clear");
      return;
    case "leave-history":
    case "none":
      return;
  }
}
