import type { CommandResultV1 } from "core/protocol";
import {
  filterSlashRows,
  firstEnabledIndex,
  resolveSlashAction,
  resolveUiAction,
} from "ui/actions";
import type { ActionContext, UiActionEntry } from "ui/actions";
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
    case "home-submit": {
      const text = local.prompt();
      if (text.length === 0) return;
      dispatchAndReport(
        dispatcher.dispatch("project.create", {
          root: deps.env.root,
          creationDefaults: { trust: "trusted", workspaceIdentity: deps.env.workspaceIdentity },
          text,
        }),
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
      if (deps.screen() === "read-only") return;
      const text = local.composer();
      if (text.length === 0) return;
      dispatchAndReport(dispatcher.dispatch("turn.start", { text }));
      local.composer.set("");
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
      local.slashSelection.set(firstEnabledIndex(slashRows(deps)));
      return;
    }
    case "slash-input":
      if (!slashMenuActive(deps)) return closeStaleSlash(deps);
      local.composer.set(local.composer() + intent.ch);
      local.slashSelection.set(firstEnabledIndex(slashRows(deps)));
      return;
    case "slash-backspace": {
      if (!slashMenuActive(deps)) return closeStaleSlash(deps);
      const next = local.composer().slice(0, -1);
      local.composer.set(next);
      if (next.length === 0) {
        local.overlay.set(null);
        local.slashSelection.set(0);
        return;
      }
      local.slashSelection.set(firstEnabledIndex(slashRows(deps)));
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
      local.slashSelection.set(0);
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
      const selected = [...deps.mirror.chats().summaries.values()][local.chatSelection()];
      if (selected === undefined) return;
      dispatchAndReport(dispatcher.dispatch("chat.switch", { chatId: selected.chatId }));
      local.overlay.set(null);
      return;
    }
    case "trust-accept":
      dispatchAndReport(
        dispatcher.dispatch("project.setTrust", {
          trust: "trusted",
          workspaceIdentity: deps.env.workspaceIdentity,
        }),
      );
      return;
    case "trust-decline":
      dispatchAndReport(
        dispatcher.dispatch("project.setTrust", {
          trust: "untrusted-read-only",
          workspaceIdentity: deps.env.workspaceIdentity,
        }),
      );
      return;
    case "overlay-dismiss":
      local.overlay.set(null);
      return;
    case "tab":
      local.focus.set(nextFocus(local.focus()));
      return;
    case "esc":
      applyEsc(deps);
      return;
    case "none":
      return;
  }
}

function dispatchAndReport(promise: Promise<CommandResultV1 | Error>): void {
  void promise.then((result) => {
    if (result instanceof Error) console.error("UI command dispatch failed:", result);
  });
}

function actionContext(deps: UiDeps): ActionContext {
  return {
    capabilities: deps.mirror.capabilities(),
    turnRunning: deps.mirror.turn().phase === "running",
    screen: deps.screen(),
  };
}

function slashRows(deps: UiDeps) {
  return filterSlashRows(deps.local.composer(), actionContext(deps));
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
      dispatchAndReport(deps.dispatcher.dispatch("chat.create", {}));
      return;
    }
    dispatchAndReport(deps.dispatcher.dispatch("export.start", {}));
    return;
  }
  if (execution.effect === "fullscreen") {
    deps.local.fullscreen.set(!deps.local.fullscreen());
    return;
  }
  const chats = deps.mirror.chats();
  const activeIndex = [...chats.summaries.values()].findIndex(
    (summary) => summary.chatId === chats.activeChatId,
  );
  deps.local.chatSelection.set(activeIndex < 0 ? 0 : activeIndex);
  deps.local.overlay.set("chat-list");
}

/** Resolves and applies one `Esc` press against the layered stack (design §3.8). */
function applyEsc(deps: UiDeps): void {
  const turn = deps.mirror.turn();
  const outcome = resolveEsc({
    overlayOpen: deps.local.overlay(),
    focusAwayFromComposer: deps.local.focus() !== "composer",
    historicalBrowse: false,
    generationRunning: turn.phase === "running",
    hasSelection: deps.mirror.selection() !== null,
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
        dispatchAndReport(deps.dispatcher.dispatch("turn.cancel", { turnId: turn.turnId }));
      return;
    case "deselect":
      dispatchAndReport(deps.dispatcher.dispatch("selection.clear", {}));
      return;
    case "leave-history":
    case "none":
      return;
  }
}
