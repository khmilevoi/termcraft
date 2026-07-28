import { trace } from "infrastructure/debug-log";

import type { WorkspaceDeps } from "../types";

/**
 * Switching pages from the tab strip (design §3.3, "Tabs switch pages").
 *
 * WHY AN OVERRIDE AND NOT A COMMAND FIELD. The Kernel's own `activePageSlug` reaches the UI on
 * exactly one event — `page.descriptorsChanged` (`ui/mirror/model/mirror.ts`) — whose `reason`
 * is a closed eight-member union (`core/protocol/model/event-payload.ts`, KCC §9) with no member
 * for "the user picked a tab". So a tab click cannot announce itself through Kernel state
 * without widening a contract-tested closed union. It does not need to: which page the user is
 * LOOKING at is machine-local view state, the same class as focus and fullscreen. The Kernel
 * still learns the choice — `preview.selectPage` (dispatched by `ui/app/model/deps.ts` when the
 * effective slug changes) persists it into `workspace.local.toml`, which is what
 * `resolveActivePageSlug` reads back on the next open. The override exists only for the window
 * between the click and the Kernel echoing that same slug back.
 *
 * `deps.activePageSlug` is the one slug the whole Workspace reads (`override ?? Kernel`), so the
 * tab strip, the status bar, the pin list and the preview request can never disagree.
 */
export function selectPage(deps: WorkspaceDeps, pageSlug: string): void {
  if (deps.activePageSlug() === pageSlug) return;
  // Never point the UI at a page no descriptor carries: the preview request that follows would
  // be refused by the Kernel anyway, and the tab strip would mark a tab that is not drawn.
  const known = deps.mirror.pageDescriptors().some((entry) => entry.pageSlug === pageSlug);
  if (!known) {
    console.warn(`UI page switch skipped — no descriptor for page "${pageSlug}"`);
    return;
  }
  trace("ui.page.select", { pageSlug });
  deps.local.pageOverride.set(pageSlug);
  // §3.2: "switching page tabs clears it" — the selection is stored as (page, element id), so it
  // cannot survive the page it was made on. Only dispatched when there IS one, so an ordinary
  // tab click does not fill the command log with no-op clears.
  if (deps.mirror.selection() === null) return;
  void deps.dispatcher.dispatch("selection.clear", {}).then((result) => {
    // Logged, never swallowed (errore rule 21): a refused clear leaves a stale chip attached to
    // the composer, which is worth seeing in the log even though it cannot break the switch.
    if (result instanceof Error) {
      console.warn("UI selection.clear dispatch failed after a page switch:", result);
      return;
    }
    trace("ui.dispatch.result", { kind: "selection.clear", result });
  });
}
