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
      void dispatcher.dispatch("project.create", {
        root: deps.env.root,
        creationDefaults: { trust: "trusted", workspaceIdentity: deps.env.workspaceIdentity },
        text,
      });
      return;
    }
    case "composer-input":
      local.composer.set(local.composer() + intent.ch);
      return;
    case "composer-backspace":
      local.composer.set(local.composer().slice(0, -1));
      return;
    case "composer-submit": {
      const text = local.composer();
      if (text.length === 0) return;
      void dispatcher.dispatch("turn.start", { text });
      local.composer.set("");
      return;
    }
    case "tab":
      local.focus.set(nextFocus(local.focus()));
      return;
    case "fullscreen":
      local.fullscreen.set(!local.fullscreen());
      return;
    case "export":
      void dispatcher.dispatch("export.start", {});
      return;
    case "esc":
      applyEsc(deps);
      return;
    case "none":
      return;
  }
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
        void deps.dispatcher.dispatch("turn.cancel", { turnId: turn.turnId });
      return;
    case "deselect":
      void deps.dispatcher.dispatch("selection.clear", {});
      return;
    case "leave-history":
    case "none":
      return;
  }
}
