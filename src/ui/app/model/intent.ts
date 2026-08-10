import { wrap } from "@reatom/core";

import type { CommandResultV1 } from "core/protocol";
import { log, trace } from "infrastructure/debug-log";
import { filterSlashRows, resolveSlashAction, resolveUiAction } from "ui/actions";
import type { UiActionEntry } from "ui/actions";
import { sortChatSummariesNewestFirst } from "ui/mirror";
import { buildRepairPrompt, isDesignRenderFailure, pageEntryOf } from "ui/preview";
import { deriveTabs, neighbourTabSlug, nextFocus, resolveEsc, selectPage } from "ui/workspace";

import type { UiDeps, UiLocalState } from "./deps";
import type { KeyIntent } from "./keymap";
import {
  deletePrimaryInputChar,
  primaryInputAtom,
  setPinInput,
  setPrimaryInput,
} from "./primary-input";

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
    case "home-backspace":
      // Only reachable while `agentHealth.kind === "blocked"`, where the editor is blurred and
      // receives no keys of its own (keymap.ts's fix-round-3 escape route). It mutates the buffer
      // through the handle; the buffer's own content-change listener projects the result into the
      // mirror, exactly as a typed key would — so there is no paired atom write here.
      deletePrimaryInputChar(deps);
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
      // Gap D/§2.4: whichever command matches what the shell actually found on disk — `create`
      // grants trust implicitly, so it must never run against a project a prior grant already
      // covers.
      //
      // This branch used to be written for the exists-but-empty project landing on Home (rare:
      // project creation always mints the first chat header) — that case no longer reaches Home
      // at all (spec 2026-08-02): `deriveScreen` now mounts the Workspace directly off
      // `UiEnv.projectExists` (the SAME `existing` fact `ShellLaunchV1` carries), and the
      // composition root's own startup `project.open` (`run-app.ts`) opens it there. What still
      // reaches this branch is the RETRY, and the three ways to land here differ in WHERE the
      // reason on screen comes from, never in whether there is one (see
      // `docs/architecture/flows/launch.md` for the full account): when that startup dispatch was
      // LATER BLOCKED — the Kernel admitted it and only then failed (`kernel.project.blockOpen`)
      // — `deriveScreen` drops back to Home and `HomeOpenFailurePanel` renders the Kernel's own
      // `safeMessage`. When it instead FAILED TO REACH the Kernel or WAS REJECTED outright,
      // `root.abandonStartupOpen(failure)` (`run-app.ts`) is what drops `deriveScreen` back to
      // Home, and `ProjectMirror.openFailure` stays `null` for both of those — correctly, since
      // no `blockOpen` ever happened — but the failure those branches build lands in
      // `UiLocalState.startupOpenFailure`, which `App.tsx` composes into the SAME `openFailure`
      // prop, so the panel fires for them too (branch review finding 2, 2026-08-03). Either way
      // `deps.env.projectExists` stays true, so the user's own Enter here must still dispatch
      // `project.open`, never `project.create`.
      //
      // fix round 1, Finding 2: clears the prompt ONLY once the Kernel actually accepted the
      // dispatch — the identical treatment Task 11 gave `composer-submit` — so a rejected retry
      // never discards what the user typed while trying again.
      if (deps.env.projectExists) {
        dispatchHomeSubmit(
          dispatcher.dispatch("project.open", { root: deps.env.root, text }),
          "project.open",
          deps,
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
        deps,
      );
      return;
    }
    case "composer-submit": {
      // DIAGNOSTIC (infrastructure/debug-log): both guards below return silently, so a submit
      // that dies here is indistinguishable on screen from one that was never pressed. Name
      // which guard swallowed it.
      //
      // INVARIANT (trust-prompt-on-open fix, 2026-08-03): "read-only" here specifically means
      // untrusted AND the trust prompt has already been answered — an untrusted project still on
      // the `"trust-prompt"` screen never reaches this guard (nor `pin-input`/`pin-backspace`/
      // `pin-save`'s identical checks below), because `keymap.ts`'s `resolveKey` only ever
      // resolves `trust-accept`/`trust-decline`/`none` while `screen === "trust-prompt"`.
      if (deps.screen() === "read-only") {
        trace("ui.composerSubmit.refused", { reason: "screen is read-only" });
        return;
      }
      // §3.2/finding §2.5: keymap.ts's chat-zone inline-key branch (`resolveKey`'s
      // `zone === "chat" && context.screen === "workspace"` check) no longer excludes
      // `turnRunning`, so Enter keeps resolving to `composer-submit` for the whole duration of a
      // turn — refusing it HERE, before `local.composer` is ever touched, is what keeps the
      // draft in place instead of firing a second `turn.start` the Kernel would reject anyway
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
            log.error("UI command dispatch failed:", result);
            trace("ui.dispatch.result", { kind: "turn.start", result });
            return;
          }
          trace("ui.dispatch.result", { kind: "turn.start", result });
          if (result.status === "accepted") {
            setPrimaryInput(deps, "");
            // WP-9 (design-agent-feedback-loop repair, Task 11): remembers what was just SENT,
            // the instant it is cleared from the composer — the one place this text could
            // otherwise be lost before `deps.ts`'s `applyTurnTerminal` might need to restore it
            // on a later `turn.failed`. See `UiLocalState.pendingTurnText`'s own doc comment.
            local.pendingTurnText.set(text);
          }
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
      setPrimaryInput(deps, "/");
      local.overlay.set("slash-menu");
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
      setPrimaryInput(deps, "");
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
      setPinInput(deps, "");
      local.overlay.set(null);
      return;
    }
    case "trust-accept":
      // Marks the prompt answered ONLY once the Kernel actually accepted `project.setTrust`
      // (fix round 2, Finding 2 — the identical treatment `dispatchHomeSubmit` and
      // `composer-submit` above already give their own local state): a rejection (e.g. a
      // `STALE_REVISION` race during the ready sequence) must not move the screen to
      // `"read-only"` irreversibly when trust was never actually granted — `trustPromptDismissed`
      // only ever goes `false -> true` for the rest of this run.
      dispatchTrustSetTrust(
        dispatcher.dispatch("project.setTrust", {
          trust: "trusted",
          workspaceIdentity: deps.env.workspaceIdentity,
        }),
        "project.setTrust:trusted",
        local,
      );
      return;
    case "trust-decline":
      // Same shape as `trust-accept` immediately above — see its comment.
      dispatchTrustSetTrust(
        dispatcher.dispatch("project.setTrust", {
          trust: "untrusted-read-only",
          workspaceIdentity: deps.env.workspaceIdentity,
        }),
        "project.setTrust:untrusted-read-only",
        local,
      );
      return;
    case "overlay-dismiss":
      if (local.overlay() === "pin-input") {
        deps.interaction.pendingPin.set(null);
        setPinInput(deps, "");
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
    if (result instanceof Error) log.error("UI command dispatch failed:", result);
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
  deps: UiDeps,
): void {
  void promise.then(
    wrap((result) => {
      if (result instanceof Error) {
        log.error("UI command dispatch failed:", result);
        trace("ui.dispatch.result", { kind, result });
        return;
      }
      trace("ui.dispatch.result", { kind, result });
      if (result.status === "accepted") setPrimaryInput(deps, "");
    }),
  );
}

/**
 * `trust-accept`/`trust-decline`'s own dispatch continuation (fix round 2, Finding 2) — the same
 * shape {@link dispatchHomeSubmit} already uses: marks {@link UiLocalState.trustPromptDismissed}
 * ONLY once the Kernel actually accepted `project.setTrust`, never on a rejection or a dispatch
 * that never reached the Kernel. Before this fix the flag was set synchronously with the dispatch
 * call, so a Kernel refusal (e.g. `STALE_REVISION` during the ready sequence) still moved the
 * screen to `"read-only"` irreversibly, even though trust was never actually granted or
 * declined — and since the flag only ever goes `false -> true` for the rest of the run, the user
 * could never be re-asked this session. `wrap` (RTM-A04) around the continuation — it touches
 * `local.trustPromptDismissed`, a Reatom atom, after the dispatch's own `.then()` boundary.
 */
function dispatchTrustSetTrust(
  promise: Promise<CommandResultV1 | Error>,
  kind: string,
  local: UiLocalState,
): void {
  void promise.then(
    wrap((result) => {
      if (result instanceof Error) {
        log.error("UI command dispatch failed:", result);
        trace("ui.dispatch.result", { kind, result });
        return;
      }
      trace("ui.dispatch.result", { kind, result });
      if (result.status === "accepted") local.trustPromptDismissed.set(true);
    }),
  );
}

function slashRows(deps: UiDeps) {
  return filterSlashRows(primaryInputAtom(deps)(), deps.actionContext());
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
  if (execution.effect === "chat-scroll-up" || execution.effect === "chat-scroll-down") {
    // The keyboard half of chat scrolling (chat-scroll spec §5.5). `applyIntent` stays pure of
    // the renderer: it calls a port `Workspace.tsx` published, exactly as it calls `dispatcher`.
    const viewport = deps.local.chatViewport();
    if (viewport === null) {
      // Reachable for one frame at mount, and on every non-Workspace screen — the keys are
      // global tier, so they resolve there too and must be inert rather than throw.
      trace("ui.chat.scroll.refused", { effect: execution.effect, reason: "no viewport" });
      return;
    }
    viewport.scrollByPage(execution.effect === "chat-scroll-down" ? 1 : -1);
    return;
  }
  if (execution.effect === "chat-follow-latest") {
    // `^D` (design iteration 10 answers 2/6, review finding I2/I3) — the same viewport port
    // above, the same "reachable but inert with no viewport" reasoning.
    const viewport = deps.local.chatViewport();
    if (viewport === null) {
      trace("ui.chat.followLatest.refused", { reason: "no viewport" });
      return;
    }
    viewport.scrollToBottom();
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
      // The page's real file, off the descriptor list — never derived from the slug, which is
      // what made this message name a path that could not exist (task 16).
      entryRelPath: pageEntryOf(deps.mirror.pageDescriptors(), preview.pageSlug),
      safeMessage: preview.finalFailure.safeMessage,
      attempts: preview.attempts,
    });
    // NEVER overwrite a draft: this codebase already carries two defect fixes built on that
    // principle. An empty composer is filled; a non-empty one keeps every character. This has
    // been writing `\n\n` since 2026-07-27 with nothing able to render it — the existing proof
    // that multi-line composer content is normal (§7.4).
    const draft = deps.local.composer();
    setPrimaryInput(deps, draft.length === 0 ? text : `${draft}\n\n${text}`);
    deps.local.focus.set("chat");
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
    focusAwayFromComposer: deps.local.focus() !== "chat",
    historicalBrowse: false,
    generationRunning: turn.phase === "running",
    hasSelection,
  });

  switch (outcome.kind) {
    case "close-overlay":
      deps.local.overlay.set(null);
      return;
    case "unfocus-to-composer":
      deps.local.focus.set("chat");
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
