import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { reatomComponent, useWrap } from "@reatom/react";

import { trace } from "infrastructure/debug-log";
import { filterSlashRows } from "ui/actions";
import { Home } from "ui/home";
import type { HomeAgentSelection, HomeCombo } from "ui/home";
import { MIN_FRAME, sortChatSummariesNewestFirst } from "ui/mirror";
import {
  ChatListPopup,
  ExportFailurePopup,
  ExportPopup,
  FRESH_CHAT_LABEL,
  PinInputPopup,
  TrustPrompt,
  formatChatWhen,
} from "ui/popups";
import { EnlargePlaceholder } from "ui/preview";
import { SHELL_PALETTE } from "ui/theme";
import { Workspace } from "ui/workspace";
import type { OverlayKind } from "ui/workspace";

import type { UiDeps } from "../model/deps";
import { applyIntent } from "../model/intent";
import { isClaimedKey, resolveActiveOverlay, resolveKey } from "../model/keymap";

/**
 * Home's `agent ‹…› model ‹…› effort ‹…›` combo (design `home()`,
 * `design/termcraft-engine.js:150-152`). DIVERGENCE (design sample data, not layout): the design
 * hardcodes `‹codex› ‹gpt-5.5›` as sample identity (user decision 2026-07-23).
 *
 * Read from the SYNCHRONOUS selection the composition root seeds, never from the health probe:
 * `capabilities().defaultSelection` needs no I/O, and folding it into `healthCheck()`'s promise is
 * exactly what left this row empty for up to 20 seconds (finding §2.7).
 *
 * `selection === null` — no registry (demo mode) or an empty catalog — is the one case the
 * design does not cover: `home()` always draws a populated combo, never an empty one. The
 * closest faithful mapping renders the honest empty combo (`‹›` in every slot) rather than an
 * invented identity; see `UiLocalState.agentSelection` (`ui/app/model/deps.ts`) for the same
 * gap documented at the source.
 */
function homeCombo(selection: HomeAgentSelection | null): HomeCombo {
  if (selection === null) return { agent: "", model: "", effort: "" };
  return { agent: selection.agent, model: selection.model, effort: selection.effort };
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
 *
 * `nowMs` is the App's injected clock reading (see {@link App}'s own `clock` prop) — threaded in
 * rather than read via `Date.now()` here so the WHEN column ({@link formatChatWhen}) stays
 * deterministic under test.
 *
 * `overlay` is the ALREADY precedence-resolved value — the App's own `resolveActiveOverlay` call,
 * hoisted so this and the `<Workspace>` mount below (and the `onKey` context builder) all read
 * the SAME resolution rather than three independently-computed ones that could drift apart.
 */
function renderOverlay(deps: UiDeps, nowMs: number, overlay: OverlayKind | null) {
  if (overlay === "chat-list") {
    const chats = deps.mirror.chats();
    // Design 24-chats.dc.html (wsChats): rows list newest-first. `chat-move`/`chat-switch`
    // (intent.ts) sort the very same summaries through the same helper, so the rendered row
    // order and the selection index they resolve always agree.
    const rows = sortChatSummariesNewestFirst(chats.summaries.values()).map((summary) => ({
      chatId: summary.chatId,
      // Design §3.9: "a chat's display name is derived… the first line of its first `user`
      // record" (Kernel-derived, `ChatSummaryV1.displayName`, WP-10 Task 4). A freshly-created
      // chat carries `displayName: null` until its first `user` record lands. CORRECTED
      // (defect 3): this used to fall back to `chatId.slice(0, 8)`, citing "the design's
      // `chatId.slice(0, 8)` fallback" — false. `wsChats`'s fourteen sample rows
      // (design/termcraft-engine.js:1026-1039) are all descriptive names; the design has no
      // hex-fallback row anywhere. {@link FRESH_CHAT_LABEL} is `wsChatFresh`'s OWN wording for
      // this exact case (`design/termcraft-engine.js:1078`), the honest design-anchored label.
      label: summary.displayName ?? FRESH_CHAT_LABEL,
      // Defect 2 fix: the design's WHEN column (`wsChats`, engine:1026-1039) shows relative
      // time — `now`, `8m ago`, `1h ago`, `yesterday`, … — never the raw RFC-3339 `createdAt`.
      when: formatChatWhen(summary.createdAt, nowMs),
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
  // Unreachable: exportPopupShowing (via resolveActiveOverlay, in the caller) narrowed the phase
  // to "done" | "failed".
  return null;
}

/** {@link App}'s default clock — real wall-clock time, used whenever no `clock` prop is passed. */
const DEFAULT_CLOCK = () => Date.now();

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
 *
 * `clock` (defect 2 fix) is the injectable "now" the chat-list popup's WHEN column formats
 * relative time against ({@link formatChatWhen}). It defaults to {@link DEFAULT_CLOCK} — real
 * `Date.now()` — for every production mount; tests inject a fixed reading for determinism.
 * `UiDeps` (`ui/app/model/deps.ts`) carries no clock of its own, so this is threaded as its own
 * component prop rather than through `deps`. CORRECTED (review): it does NOT keep `Date.now()`
 * out of the render body — `DEFAULT_CLOCK` is called from it on every render, below. What the
 * prop buys is that the reading is INJECTABLE, which is what makes the WHEN column testable at
 * all; it is the smallest change achieving that while staying inside this module's own files.
 *
 * KNOWN, ACCEPTED (MVP): the reading is a plain non-reactive read, so relative labels are
 * correct when the popup opens and then hold until something else re-renders the tree — a row
 * that said `2m ago` keeps saying it while the popup stays open. Making them advance needs a
 * ticking source the UI does not have; recorded here rather than left as a silent surprise in a
 * column whose whole point is that time passes.
 */
export const App = reatomComponent<{ deps: UiDeps; clock?: () => number }>((props) => {
  const { deps } = props;
  const clock = props.clock ?? DEFAULT_CLOCK;

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
    const context = {
      screen: deps.screen(),
      focus: deps.local.focus(),
      // The SAME precedence call `renderOverlay` makes above — one source of truth for which
      // surface owns the keys, not a second independently derived export-popup check (M14 fix).
      overlay: resolveActiveOverlay(deps.local.overlay(), exportPopupShowing(deps)),
      composerValue: deps.local.composer(),
      homeHealth: deps.local.homeHealth(),
      homePrompt: deps.local.prompt(),
      turnRunning: deps.mirror.turn().phase === "running",
      projectOpening: deps.mirror.project().opening,
    };
    const intent = resolveKey(key, context);
    // DIAGNOSTIC (infrastructure/debug-log): the single choke point where a keystroke becomes an
    // intent. A key that resolves to `none` here is the difference between "the app ignored me"
    // and "the command was rejected downstream" — invisible otherwise, since the shell owns the
    // terminal and no key path reports anything on screen.
    trace("ui.onKey", {
      // EVERY modifier the terminal reported, not just `ctrl` (HANDOFF Finding 3). Recording one
      // modifier made "the terminal swallowed the chord" and "no chord was pressed" the same
      // line in the log, and a whole finding was drawn from that ambiguity. `raw` is the bytes
      // as received, which is the only way to tell a CSI-encoded chord from a bare arrow.
      key: {
        name: key.name,
        sequence: key.sequence,
        raw: key.raw,
        ctrl: key.ctrl,
        shift: key.shift,
        meta: key.meta,
        option: key.option,
        eventType: key.eventType,
      },
      context,
      intent,
      // The two mirror fields `deriveScreen` actually branches on. Logged here rather than
      // inside `createScreenAtom`'s `computed`, where a side effect would violate the Reatom
      // rules and fire on every unrelated recompute.
      project: {
        projectId: deps.mirror.project().projectId,
        trust: deps.mirror.project().trust,
      },
    });
    // THE CLAIM (§4.6, §6.4). Global listeners run before renderable handlers, and
    // `Renderable.focus()`'s own keypress handler skips `handleKeyPress` when
    // `key.defaultPrevented` — so this is a COMPLETE gate, and the single point where the App and
    // the focused editor divide the keyboard. Derived from the resolved intent rather than a
    // second key list, which would drift.
    if (isClaimedKey(intent)) key.preventDefault();
    applyIntent(intent, deps);
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
    // §3.10, phase-8 Task 17: the SAME `slashOpen ? filterSlashRows(...) : []` convention
    // `Workspace.tsx` already uses for its own non-modal anchor — `rows` stays empty (so Home
    // renders nothing extra) whenever the menu is not open, rather than filtering unconditionally
    // on whatever the prompt currently holds.
    const homeSlashOpen = deps.local.overlay() === "slash-menu";
    return (
      <Home
        id="app-home"
        width={size.w}
        height={size.h}
        health={deps.local.homeHealth()}
        prompt={deps.local.prompt()}
        combo={homeCombo(deps.local.agentSelection())}
        rows={homeSlashOpen ? filterSlashRows(deps.local.prompt(), deps.actionContext()) : []}
        selectedIndex={deps.local.slashSelection()}
        openFailure={deps.mirror.project().openFailure}
        opening={deps.mirror.project().opening}
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
  //
  // Hoisted so `<Workspace>`'s `activeOverlay` prop, `renderOverlay`'s own render, and `onKey`'s
  // context builder above all read the SAME resolved value — `resolveActiveOverlay` is still the
  // ONE precedence function, just called once per render instead of once per consumer.
  const activeOverlay = resolveActiveOverlay(deps.local.overlay(), exportPopupShowing(deps));
  const overlay = renderOverlay(deps, clock(), activeOverlay);
  return (
    <box
      id="app-root"
      width={size.w}
      height={size.h}
      backgroundColor={SHELL_PALETTE.bg}
      position="relative"
    >
      <Workspace deps={deps} readOnly={screen === "read-only"} activeOverlay={activeOverlay} />
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
