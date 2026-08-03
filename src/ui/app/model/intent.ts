import { type Atom, wrap } from "@reatom/core";

import type { CommandResultV1 } from "core/protocol";
import { trace } from "infrastructure/debug-log";
import { filterSlashRows, resolveSlashAction, resolveUiAction } from "ui/actions";
import type { UiActionEntry } from "ui/actions";
import { sortChatSummariesNewestFirst } from "ui/mirror";
import { buildRepairPrompt, isDesignRenderFailure } from "ui/preview";
import { deriveTabs, neighbourTabSlug, nextFocus, resolveEsc, selectPage } from "ui/workspace";

import type { UiDeps, UiLocalState } from "./deps";
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
      // result lands in local.agentHealth, which Home re-reads reactively.
      void deps.refreshAgentHealth();
      return;
    case "home-submit": {
      const text = local.prompt();
      if (text.length === 0) return;
      // Gap D/§2.4: whichever command matches what the shell actually found on disk. NARROWED
      // (workspace-first launch, 2026-08-02): this branch used to also cover the
      // existing-but-empty project, which reached Home because the composition root then keyed
      // its startup dispatch on `ShellLaunchV1.hasContent` — a predicate nothing reads any more
      // (`entrypoint/types.ts`). `deriveScreen` now routes every existing project to the
      // Workspace, so Home is reached with a project on disk in exactly ONE scenario — ⏎ after a
      // startup open that failed — and that is the only caller left. Still required: `create`
      // would grant trust implicitly over a project whose prior grant is the authority.
      //
      // fix round 1, Finding 2: clears the prompt ONLY once the Kernel actually accepted the
      // dispatch — the identical treatment Task 11 gave `composer-submit`, applied here for the
      // identical reason. NARROWED (workspace-first launch, 2026-08-02): this branch's one
      // remaining caller is the ⏎ retry after a blocked open, and that retry races Home's own
      // recovery (`deps.ts`'s `recoverFromBlockedOpen`), which dispatches `project.close` the
      // instant `blockOpen` lands. Hitting Enter before that close resolves fires `project.open`
      // while the project machine is still `"blocked"`/`"closing"`, not yet `"closed"`, so the
      // Kernel rejects it `CAPABILITY_UNAVAILABLE`. Clearing only on `accepted` means that
      // transient rejection never discards what the user retyped, and the text stays put to be
      // resent once the recovery actually completes.
      if (deps.env.projectExists) {
        dispatchHomeSubmit(
          dispatcher.dispatch("project.open", { root: deps.env.root, text }),
          "project.open",
          local,
        );
        return;
      }
      dispatchHomeSubmit(
        dispatcher.dispatch("project.create", {
          root: deps.env.root,
          creationDefaults: { trust: "trusted", workspaceIdentity: deps.env.workspaceIdentity },
          text,
        }),
        "project.create",
        local,
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
      // DIAGNOSTIC (infrastructure/debug-log): all FOUR refusals below — a read-only screen, a
      // project still opening, a turn already running, an empty composer — return silently, so a
      // submit that dies here is indistinguishable on screen from one that was never pressed.
      // Name which one swallowed it.
      if (deps.screen() === "read-only") {
        trace("ui.composerSubmit.refused", { reason: "screen is read-only" });
        return;
      }
      // fix round 1, Finding 2 (workspace-first launch, 2026-08-03): `projectId === null` inside
      // a mounted Workspace means a pending startup open (`ui/mirror/model/screen.ts`), and the
      // design's own comment for this state says "composer stays live but ⏎ is refused"
      // (`design/termcraft-engine.js:231`) — the exact promise the status bar's `dis`-marked
      // `⏎ send` key already draws (`Workspace.tsx`'s `OPENING_HINT_KEYS`). Without this guard
      // the refusal happened by accident: Enter still dispatched `turn.start`, the Kernel
      // rejected it (no project machine exists to accept a turn), and the rejection only ever
      // reached `console.error` below — invisible while the renderer owns the terminal. Refusing
      // HERE, before `local.composer` is ever touched, keeps the draft in place exactly like the
      // read-only and running-turn guards beside it.
      if (deps.mirror.project().projectId === null) {
        trace("ui.composerSubmit.refused", { reason: "project is still opening" });
        return;
      }
      // §3.2/finding §2.5: keymap.ts's `composerActive` no longer excludes `turnRunning`, so
      // Enter keeps resolving to `composer-submit` for the whole duration of a turn — refusing
      // it HERE, before `local.composer` is ever touched, is what keeps the draft in place
      // instead of firing a second `turn.start` the Kernel would reject anyway
      // (`TURN_ALREADY_ACTIVE`), which used to be the very reason the composer had to freeze.
      // Design's own copy for this state, `⏎ send disabled — draft kept`
      // (`design/termcraft-engine.js:259-277` `wsGenTyping`, `:268`'s `attach` line — see
      // `Workspace.tsx`'s `deriveComposerAttach` call for where it renders).
      if (deps.mirror.turn().phase === "running") {
        trace("ui.composerSubmit.refused", { reason: "a turn is already running" });
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
      // §3.10, phase-8 Task 17 (finding §2.4): the slash menu is reachable from either primary
      // input — the Workspace composer OR the Home prompt (`keymap.ts`'s own two `/`-open
      // checks, one per screen). Every other screen has no primary input to open it from at all.
      const screen = deps.screen();
      if (screen !== "workspace" && screen !== "home") return;
      // §3.10's "when nothing applies the menu simply does not open" — checked BEFORE anything is
      // written, so `/` stays literal text on a screen with no matching rows. Not reachable for
      // either real screen today (`/model`+`/exit` always cover Home; every row covers Workspace),
      // but the check stays screen-generic rather than assuming that forever.
      if (filterSlashRows("/", deps.actionContext()).length === 0) return;
      primaryInput(deps).set("/");
      local.overlay.set("slash-menu");
      return;
    }
    case "slash-input": {
      if (!slashMenuActive(deps)) return closeStaleSlash(deps);
      const input = primaryInput(deps);
      input.set(input() + intent.ch);
      // TYPING PAST EVERY MATCH LEAVES SLASH MODE (defect fix, 2026-07-26).
      //
      // Nothing used to close the menu on a forward-typed miss — only `slash-backspace` at
      // length 0 did — so `/commit-x` left the overlay open with an empty row set. The renderers
      // correctly draw nothing for that (design's own rule: `slashMenu()` returns early when
      // `!rows.length`, `design/termcraft-engine.js:966`), which made the dead end INVISIBLE:
      // Enter still routed to `slash-submit`, found no row, and returned silently, so the user
      // pressed Enter on their typed text and absolutely nothing happened, with no cue at all.
      //
      // §3.10's rule is the same in both directions — "when nothing applies the menu simply does
      // not open" — so a prefix that matches nothing is just text. Dropping the overlay restores
      // exactly that: the characters stay in the input, and Enter submits them the ordinary way.
      if (filterSlashRows(input(), deps.actionContext()).length === 0) local.overlay.set(null);
      return;
    }
    case "slash-backspace": {
      if (!slashMenuActive(deps)) return closeStaleSlash(deps);
      const input = primaryInput(deps);
      const next = input().slice(0, -1);
      input.set(next);
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
      if (row === undefined || row.state.availability !== "available") return;
      const entry = resolveSlashAction(row.command);
      if (entry === null) return;
      primaryInput(deps).set("");
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

/**
 * `home-submit`'s own dispatch continuation (fix round 1, Finding 2) — the same shape
 * `composer-submit` already uses (Task 11): clears `local.prompt` ONLY once the Kernel actually
 * accepted the dispatch, never on a rejection, so a `project.open`/`project.create` attempt that
 * loses a race against the composition root's own startup open (Gap D, `run-app.ts`) never
 * silently discards what the user typed. `wrap` (RTM-A04) around the continuation — it touches
 * `local.prompt`, a Reatom atom, after the dispatch's own `.then()` boundary.
 */
function dispatchHomeSubmit(
  promise: Promise<CommandResultV1 | Error>,
  kind: "project.create" | "project.open",
  local: UiLocalState,
): void {
  void promise.then(
    wrap((result) => {
      if (result instanceof Error) {
        console.error("UI command dispatch failed:", result);
        trace("ui.dispatch.result", { kind, result });
        return;
      }
      trace("ui.dispatch.result", { kind, result });
      if (result.status === "accepted") local.prompt.set("");
    }),
  );
}

/**
 * The primary text input for the current screen (§3.10 calls them both "primary input"): the
 * Home prompt or the Workspace composer. Selects between two ALREADY-EXISTING atoms — never
 * creates one — so calling this repeatedly within one intent handler is free.
 */
function primaryInput(deps: UiDeps): Atom<string> {
  return deps.screen() === "home" ? deps.local.prompt : deps.local.composer;
}

function slashRows(deps: UiDeps) {
  return filterSlashRows(primaryInput(deps)(), deps.actionContext());
}

function slashMenuActive(deps: UiDeps): boolean {
  const screen = deps.screen();
  return (screen === "workspace" || screen === "home") && deps.local.overlay() === "slash-menu";
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
  const enabled = rows.flatMap((row, index) =>
    row.state.availability === "available" ? [index] : [],
  );
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
    if (execution.command === "preview.retry") {
      // The ONLY command here whose payload names something: the session being retried. It comes
      // from the mirror's own `preview.circuitOpened` fold — the same id the Kernel published —
      // never a fresh mint. With no circuit-open session there is nothing to retry, and the
      // capability guard would refuse it anyway, so this returns rather than dispatching a
      // request naming a session that does not exist.
      const preview = deps.mirror.preview();
      if (preview.phase !== "circuit-open") return;
      dispatchAndReport(
        deps.dispatcher.dispatch("preview.retry", { previewSessionId: preview.previewSessionId }),
        "preview.retry",
      );
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
  if (execution.effect === "page-prev" || execution.effect === "page-next") {
    // The keyboard half of tab switching (design extension — see this action's own registry
    // entry). It derives the target from the SAME tab strip the mouse clicks
    // (`deriveTabs` + `neighbourTabSlug`) and lands in the SAME `selectPage`, so the two routes
    // cannot drift apart in what they consider "the next page" or in what a switch does.
    const tabs = deriveTabs(deps.mirror.pageDescriptors(), deps.activePageSlug());
    const target = neighbourTabSlug(tabs, execution.effect === "page-next" ? 1 : -1);
    if (target === null) {
      trace("ui.page.step.refused", { effect: execution.effect });
      return;
    }
    selectPage(deps, target);
    return;
  }
  if (execution.effect === "compose-repair") {
    // The composer is the destination, so the same refusal `composer-submit` applies here:
    // filling an input that cannot send would promise an action the screen does not offer.
    if (deps.screen() === "read-only") {
      trace("ui.composeRepair.refused", { reason: "screen is read-only" });
      return;
    }
    // `circuit-open` ONLY, deliberately — not the sibling `failed` phase. `failed` renders the
    // Gate panel (`wsBrokenSource`), whose design offers exactly one route out, the open
    // composer, and names no key at all. Accepting F6 there would give the user a working key
    // that nothing on screen mentions — the mirror image of the defect `preview.retry`'s own
    // registry entry records, where a panel named a key that did not exist. Every affordance is
    // named by something drawn, or it is not offered.
    const preview = deps.mirror.preview();
    if (preview.phase !== "circuit-open") {
      trace("ui.composeRepair.refused", { reason: `preview phase is ${preview.phase}` });
      return;
    }
    // And only when the PAGE is what failed (spec §3.2.1). A host that died before it ever ran
    // the page is not the page's fault, and a message asking the agent to fix `page.tsx` would
    // promise a repair that cannot land.
    if (!isDesignRenderFailure(preview.finalFailure)) {
      trace("ui.composeRepair.refused", {
        reason: "the host failed before it ran the page",
        hostFailureCode: String(preview.finalFailure.details.hostFailureCode ?? "none"),
      });
      return;
    }
    const text = buildRepairPrompt({
      pageSlug: preview.pageSlug,
      safeMessage: preview.finalFailure.safeMessage,
      attempts: preview.attempts,
    });
    // NEVER overwrite a draft: this codebase already carries two defect fixes built on that
    // principle (`home-submit` and `composer-submit` both clear their input only once the Kernel
    // accepted). An empty composer is filled; a non-empty one keeps every character.
    const draft = deps.local.composer();
    deps.local.composer.set(draft.length === 0 ? text : `${draft}\n\n${text}`);
    deps.local.focus.set("composer");
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
