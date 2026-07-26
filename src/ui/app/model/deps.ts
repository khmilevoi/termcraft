import {
  type Atom,
  type Computed,
  action,
  atom,
  bind,
  computed,
  isInit,
  peek,
  sleep,
  withAsync,
  withComputed,
  withConnectHook,
  wrap,
} from "@reatom/core";
import * as errore from "errore";

import type { UUIDv7 } from "core/protocol";
import { trace } from "infrastructure/debug-log";
import type { ActionContext } from "ui/actions";
import { filterSlashRows, firstEnabledIndex } from "ui/actions";
import type { HomeAgentHealth, HomeAgentSelection } from "ui/home";
import {
  type AnyEventEnvelope,
  type Dispatcher,
  type EventEnvelopeV1,
  type KernelPort,
  type UiPreviewFrame,
  createDispatcher,
} from "ui/kernel";
import { type Mirror, type ScreenKind, createMirror, createScreenAtom } from "ui/mirror";
import {
  type PreviewInteractionState,
  createPreviewInteractionState,
  handleGeometryResult,
} from "ui/preview";
import type { FocusTarget, OverlayKind } from "ui/workspace";

/** Poll interval (ms) the frame consumer waits between checks when no preview session exists. */
const FRAME_POLL_MS = 30;

/**
 * The UI-local Reatom atoms — presentation state that is NOT Kernel state and never crosses
 * the command boundary: the two text inputs, the focused widget, the fullscreen toggle, and
 * which overlay (popup / slash menu) is open. Kept separate from the mirror so it is obvious
 * that setting them issues no command (design §3.1: UI-owned availability).
 */
export interface UiLocalState {
  /** The Home prompt input text. */
  readonly prompt: Atom<string>;
  /** The Workspace composer input text. */
  readonly composer: Atom<string>;
  /** The widget that owns focus (composer <-> preview). */
  readonly focus: Atom<FocusTarget>;
  /** Whether the preview is fullscreen (F2). */
  readonly fullscreen: Atom<boolean>;
  /** The open overlay, or `null`. */
  readonly overlay: Atom<OverlayKind | null>;
  /** Selected row in the currently filtered slash menu. */
  readonly slashSelection: Atom<number>;
  /** Selected row in the chat-list popup. */
  readonly chatSelection: Atom<number>;
  /** Draft text for the new-pin popup (phase 7 local state; pin issuance lands in Task 3). */
  readonly pinDraft: Atom<string>;
  /**
   * The `operationId` of the last export result the user dismissed (M14), or `null`. There is
   * no kernel export-ack command (`core/protocol`'s `CommandKindV1` has no such member — export
   * is fire-and-forget), so dismissal is this UI-local flag: the popup shows once per
   * `operationId` and hides once it matches this atom.
   */
  readonly exportDismissed: Atom<UUIDv7 | null>;
  /**
   * The Home agent-health reading (M15) — Home's `health` prop reads this instead of a
   * hardcoded literal. There is no Kernel command that reports agent health (Home is shown
   * *before* any project opens, so there is no `kernel.snapshot` to read either), so this atom's
   * lifecycle is: seeded with {@link DEFAULT_HOME_HEALTH} as a synchronous pre-probe placeholder
   * (Home's very first paint cannot await a Promise), then `createUiDeps` fires
   * {@link UiDeps.refreshHomeHealth} once at startup to replace it with the injected probe's
   * real reading, and again on every `home-recheck` — the SAME probe path, not a duplicated one.
   */
  readonly homeHealth: Atom<HomeAgentHealth>;
  /**
   * The agent/model/effort triple Home's combo renders (finding §2.7). Seeded SYNCHRONOUSLY by the
   * composition root, because it is a synchronous fact: it must not wait behind the CLI health
   * probe it never needed. `null` only in demo/test constructions with no registry — Home renders
   * the honest empty combo for it, never an invented identity.
   */
  readonly agentSelection: Atom<HomeAgentSelection | null>;
}

/**
 * Everything a mounted `ui` tree needs, created ONCE by {@link createUiDeps} and passed by
 * reference (never re-created inside a component body — that would rebuild the atoms every
 * render, the atom-in-body anti-pattern). The phase-8 composition root builds these around
 * the real Kernel; tests build them around a `FakeKernel`.
 */
/** Environment facts the App needs to construct a `project.create` — the composition root supplies real values (phase 8). */
export interface UiEnv {
  readonly root: string;
  readonly workspaceIdentity: string;
  /**
   * Whether `root` was ALREADY a project when this process started (Gap D). Home's Enter picks
   * `project.open` over `project.create` for it: `create` grants trust implicitly, `open` honours
   * a prior grant, and dispatching `create` against an existing project would silently run the
   * wrong semantics. Defaults to `false` — a fresh directory — for every test/demo construction.
   */
  readonly projectExists: boolean;
}

export interface UiDeps {
  readonly port: KernelPort;
  readonly env: UiEnv;
  readonly mirror: Mirror;
  readonly dispatcher: Dispatcher;
  /** The current terminal size (a UI-local value, not Kernel state). */
  readonly terminal: Atom<Readonly<{ w: number; h: number }>>;
  /** The derived screen the App root mounts. */
  readonly screen: Computed<ScreenKind>;
  /**
   * The action registry's view of the world (capabilities, turn lock, screen) — one named
   * computed so the slash-menu selection, the key-intent layer, and any future action
   * consumer all score rows against the same context.
   */
  readonly actionContext: Computed<ActionContext>;
  /**
   * The latest preview frame to display, or `null`. Fed by the App's `PreviewSession` frame
   * consumer (frames flow through the session facade, not the event stream — §7.6); kept out
   * of the mirror because it is high-frequency, latest-wins display state, not Kernel state.
   */
  readonly previewFrame: Atom<UiPreviewFrame | null>;
  /** A non-command runtime failure which cannot be returned from a connect hook. */
  readonly runtimeError: Atom<Error | null>;
  /**
   * The App reads this to activate the Kernel subscription + preview-frame consumer for its
   * mounted lifetime. Both are owned by this atom's connect hook (RTM-L01/L02) — the
   * subscription and the frame loop stop automatically when the App unmounts (its cleanup),
   * rather than leaking as a bare module-level effect.
   */
  readonly runtime: Atom<undefined>;
  readonly interaction: PreviewInteractionState;
  readonly local: UiLocalState;
  /**
   * Re-runs the agent-health probe and updates {@link UiLocalState.homeHealth} (M15's
   * `home-recheck` intent calls this). Named and `withAsync`-extended per RTM-A02/A03; a fresh
   * probe result always replaces the previous one, matching a manual user-triggered re-check
   * rather than a cached/derived read.
   */
  readonly refreshHomeHealth: () => Promise<void>;
  /**
   * The one shutdown trigger (phase-8 Task 11 / WP-10): `applyIntent`'s `exit` intent (the `q`
   * keys on the agent-missing/too-small-terminal screens) and the `/exit` slash command both
   * call this and nothing else. The composition root (`entrypoint/model/run-app.ts`) binds it to
   * the SAME `close()` its own SIGINT/SIGTERM handlers already use — one shutdown path, not a
   * second independently-behaving one. A plain synchronous `() => void` (not
   * `() => Promise<void>`): `close()` is fire-and-forget from the UI's perspective, exactly like
   * every other command dispatch in `applyIntent` — the UI never awaits its own shutdown.
   */
  readonly requestExit: () => void;
}

export class UiPreviewStreamError extends errore.createTaggedError({
  name: "UiPreviewStreamError",
  message: "UI preview stream failed",
}) {}

/**
 * The Home agent-health reading's pre-probe placeholder (M15): `createUiDeps` fires the injected
 * probe once at startup (see `refreshHomeHealth()` below), but Home's very first render happens
 * synchronously, before that probe's Promise can resolve — a component render cannot await one.
 * This value only ever shows for that first frame; it preserves the "agent ready" idle layout
 * Home showed before this task, rather than inventing a different placeholder. The real
 * CLI-checking probe IS wired by default now (phase-8 Task 9 / WP-5,
 * `entrypoint/model/run-app.ts`'s `resolveAgentHealthProbe` supplies it through
 * `agentHealthProbe` below) — this placeholder only ever paints the one synchronous frame
 * before that real probe's first resolution overwrites it.
 */
// DIVERGENCE (design sample data, not layout): this placeholder previously read `agent: "codex"`
// — the design's sample identity, not layout (user decision 2026-07-23). MVP ships Claude only,
// so the pre-probe placeholder names the actual (only) shipped backend instead of the design
// mock's Codex sample; it is still overwritten by the injected probe's real reading the moment
// it resolves (M22).
//
// It carries only `present`/`agent`/`detail` — `HomeAgentHealth` has had no `model`/`effort`/
// `version` fields since phase-8 Task 13 split them out (finding §2.7): Home's combo now reads
// the SEPARATE, synchronous `local.agentSelection` atom below, seeded directly by the
// composition root at construction rather than riding this health probe's promise.
const DEFAULT_HOME_HEALTH: HomeAgentHealth = {
  present: true,
  agent: "claude",
  detail: "agent ready",
};

/** Builds a fresh, self-consistent `UiDeps` around a `KernelPort` and an initial terminal size. */
export function createUiDeps(
  port: KernelPort,
  initialSize: Readonly<{ w: number; h: number }>,
  env: UiEnv = { root: ".", workspaceIdentity: "local", projectExists: false },
  // The named M15 injection point: the phase-8 composition root supplies a probe that actually
  // checks the agent CLI on PATH; tests inject a fake. The default keeps today's MVP reading.
  agentHealthProbe: () => Promise<HomeAgentHealth> = () => Promise.resolve(DEFAULT_HOME_HEALTH),
  // The named Task 11 / WP-10 injection point: the phase-8 composition root binds this to
  // `RunningApp.close()`. Defaults to a no-op so every existing test/demo construction of
  // `UiDeps` keeps compiling without knowing about shutdown at all.
  requestExit: () => void = () => undefined,
  // The named Task 13 injection point (finding §2.7): the phase-8 composition root supplies the
  // agent registry's synchronous default (`entrypoint/model/agent-health.ts`'s
  // `resolveDefaultAgentSelection`), seeded here rather than fetched behind a probe. Defaults to
  // `null` — the honest "no registry" absence every existing test/demo construction had before
  // this parameter existed — never an invented identity.
  agentSelection: HomeAgentSelection | null = null,
): UiDeps {
  const mirror = createMirror();
  const terminal = atom(initialSize, "ui.app.terminal");
  const dispatcher = createDispatcher({ port, revision: () => mirror.stateRevision() });
  const screen = createScreenAtom({ project: () => mirror.project(), terminal: () => terminal() });
  const actionContext = computed<ActionContext>(
    () => ({
      capabilities: mirror.capabilities(),
      turnRunning: mirror.turn().phase === "running",
      screen: screen(),
    }),
    "ui.app.actionContext",
  );
  const previewFrame = atom<UiPreviewFrame | null>(null, "ui.app.previewFrame");
  const runtimeError = atom<Error | null>(null, "ui.app.runtimeError");
  const interaction = createPreviewInteractionState();

  const runtime = atom<undefined>(undefined, "ui.app.runtime").extend(
    withConnectHook(() => {
      // These callbacks are bound while the runtime is connected. The frame consumer runs
      // after awaits, so creating `wrap` there would instead bind writes to the default context.
      const setPreviewFrame = bind((frame: UiPreviewFrame) => previewFrame.set(frame));
      const reportRuntimeError = bind((error: Error, message: string) => {
        runtimeError.set(error);
        console.error(message, error);
      });
      const waitForFramePoll = bind(() => wrap(sleep(FRAME_POLL_MS)));
      const nextFrame = bind((iterator: AsyncIterator<UiPreviewFrame>) => wrap(iterator.next()));
      const applyEnvelope = bind((envelope: EventEnvelopeV1) => {
        const distributed = envelope as AnyEventEnvelope;
        // DIAGNOSTIC (infrastructure/debug-log): the ONE place every Kernel event enters the UI.
        // A command can be `accepted` and still produce nothing visible if its events never
        // arrive here — exactly the producer/consumer seam `mirror.test.ts` pins for
        // `turn.started`. Recording the kind is what separates "the Kernel went quiet" from
        // "the mirror ignored what it got".
        // The payload is recorded only for the kinds that CARRY a diagnosis — a rejection or a
        // failure. `turn.progress` fires dozens of times per turn and its payload would bury
        // them. Without this, a Gate rejection is visible as a bare event kind with no hint of
        // WHAT it objected to.
        trace("ui.event", {
          kind: distributed.kind,
          seq: distributed.eventSeq,
          ...(/reject|fail/i.test(distributed.kind) ? { payload: distributed.payload } : {}),
        });
        if (distributed.kind === "preview.geometryResult") {
          handleGeometryResult(deps, distributed);
        }
        mirror.apply(distributed);
      });
      const unsubscribe = port.subscribe(applyEnvelope);
      if (unsubscribe instanceof Error) {
        reportRuntimeError(unsubscribe, "UI Kernel subscription failed:");
      }
      let active = true;
      let frameIterator: AsyncIterator<UiPreviewFrame> | null = null;
      const stopFrameIterator = () => {
        const iterator = frameIterator;
        frameIterator = null;
        if (iterator?.return === undefined) return;
        void iterator.return().catch((cause) => {
          console.error("UI preview frame iterator cleanup failed:", cause);
        });
      };
      void (async () => {
        // Frames flow through the PreviewSession facade, not the event stream (§7.6). Iterate
        // the current session's frames; when none exists, poll until one appears; when a
        // session's stream ends, loop back to pick up its successor.
        while (active) {
          const handle = port.preview();
          if (handle === null) {
            const delayed = await waitForFramePoll().catch(
              (cause) => new UiPreviewStreamError({ cause }),
            );
            if (delayed instanceof Error) {
              if (errore.isAbortError(delayed)) return;
              reportRuntimeError(delayed, "UI preview frame stream failed:");
              return;
            }
            continue;
          }
          const iterator = handle.frames[Symbol.asyncIterator]();
          frameIterator = iterator;
          while (active) {
            const next = await nextFrame(iterator).catch(
              (cause) => new UiPreviewStreamError({ cause }),
            );
            if (next instanceof Error) {
              if (errore.isAbortError(next)) return;
              reportRuntimeError(next, "UI preview frame stream failed:");
              return;
            }
            if (next.done) break;
            setPreviewFrame(next.value);
          }
          if (frameIterator === iterator) frameIterator = null;
          if (active) {
            const delayed = await waitForFramePoll().catch(
              (cause) => new UiPreviewStreamError({ cause }),
            );
            if (delayed instanceof Error) {
              if (errore.isAbortError(delayed)) return;
              reportRuntimeError(delayed, "UI preview frame stream failed:");
              return;
            }
          }
        }
      })();
      return () => {
        active = false;
        stopFrameIterator();
        if (typeof unsubscribe === "function") unsubscribe();
      };
    }),
  );

  const composer = atom("", "ui.local.composer");
  // The slash selection is state DERIVED from the typed prefix: every composer edit lands it
  // back on the first enabled row. Owned by the atom (RTM-S02) rather than re-set by hand in
  // each composer-writing key handler. `slash-move` still writes it directly — that is the
  // point of `withComputed` over a plain `computed`. The action context is PEEKED, not
  // tracked, so a capability flip or a turn starting mid-navigation never moves the user's
  // cursor; only what they type does.
  const slashSelection = atom(0, "ui.local.slashSelection").extend(
    withComputed((state) => {
      // Read the dependency BEFORE the init branch, per the upstream `page`/`search` example:
      // returning early without reading `composer` would register no dependency at all and the
      // atom would never recompute again.
      const typed = composer();
      return isInit() ? state : firstEnabledIndex(filterSlashRows(typed, peek(actionContext)));
    }),
  );
  // Prime the init computation here, while the composer is still empty. The init branch keeps
  // the stored value and only REGISTERS the dependency, so whoever reads the atom first would
  // otherwise consume it — and the composer edit that opened the menu would not re-derive.
  void slashSelection();

  const local: UiLocalState = {
    prompt: atom("", "ui.local.prompt"),
    composer,
    focus: atom<FocusTarget>("composer", "ui.local.focus"),
    fullscreen: atom(false, "ui.local.fullscreen"),
    overlay: atom<OverlayKind | null>(null, "ui.local.overlay"),
    slashSelection,
    chatSelection: atom(0, "ui.local.chatSelection"),
    pinDraft: atom("", "ui.local.pinDraft"),
    exportDismissed: atom<UUIDv7 | null>(null, "ui.local.exportDismissed"),
    homeHealth: atom<HomeAgentHealth>(DEFAULT_HOME_HEALTH, "ui.local.homeHealth"),
    agentSelection: atom<HomeAgentSelection | null>(agentSelection, "ui.local.agentSelection"),
  };

  const refreshHomeHealth = action(async () => {
    const result = await wrap(agentHealthProbe());
    local.homeHealth.set(result);
  }, "ui.app.refreshHomeHealth").extend(withAsync());

  // M15 lifecycle fix: fire the SAME probe path `home-recheck` uses once here, at startup,
  // instead of only seeding `homeHealth` from the placeholder above. A real phase-8 probe
  // reporting a missing agent now surfaces as soon as it resolves — not only after a manual
  // `r` re-check. Fire-and-forget like every other dispatch in this module (`void slashSelection`
  // above primes a computed the same way): the result lands in `local.homeHealth`, which Home
  // re-reads reactively.
  void refreshHomeHealth();

  const deps: UiDeps = {
    port,
    env,
    mirror,
    dispatcher,
    terminal,
    screen,
    actionContext,
    previewFrame,
    runtimeError,
    runtime,
    interaction,
    local,
    refreshHomeHealth,
    requestExit,
  };
  return deps;
}
