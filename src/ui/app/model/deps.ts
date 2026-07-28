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

import type { Sha256Hex, UUIDv7 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import { trace } from "infrastructure/debug-log";
import type { ActionContext } from "ui/actions";
import { filterSlashRows, firstEnabledIndex } from "ui/actions";
import type { HomeAgentHealth, HomeAgentSelection } from "ui/home";
import {
  type AnyEventEnvelope,
  type Dispatcher,
  type EventEnvelopeV1,
  type KernelPort,
  type PreviewSessionHandle,
  type UiPreviewFrame,
  createDispatcher,
} from "ui/kernel";
import {
  type Mirror,
  type ProjectOpenFailure,
  type ScreenKind,
  createMirror,
  createScreenAtom,
} from "ui/mirror";
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
   * The page picked from the tab strip, or `null` while the Kernel's own active slug is the whole
   * truth. Written by `selectPage` (`ui/workspace/model/page-selection.ts`), cleared whenever the
   * Kernel publishes a new active slug of its own.
   */
  readonly pageOverride: Atom<string | null>;
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
   * The page the Workspace is showing: {@link UiLocalState.pageOverride} when the user picked a
   * tab, else the Kernel's own `activePageSlug`. The single slug every consumer reads — see
   * `ui/workspace/model/page-selection.ts` for why the choice lives here rather than in a
   * Kernel field the UI could not learn back.
   */
  readonly activePageSlug: Computed<string | null>;
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
 * This value only ever shows for that first frame. The real CLI-checking probe IS wired by
 * default now (phase-8 Task 9 / WP-5, `entrypoint/model/run-app.ts`'s `resolveAgentHealthProbe`
 * supplies it through `agentHealthProbe` below) — this placeholder only ever paints the one
 * synchronous frame before that real probe's first resolution overwrites it.
 *
 * CORRECTED (finding §2.7, phase-8 Task 15): this used to read `{ present: true, detail: "agent
 * ready" }` — claiming a PASSED health check before anything had been probed, indistinguishable
 * on screen from a verified-ready agent for the whole time the real probe ran (up to
 * `DEFAULT_PROBE_DEADLINE_MS`, 20 s). `"checking"` is the honest pre-probe state — Home renders
 * its own faint `⏎ create` / spinner treatment for it and refuses submit ({@link
 * homeSubmitAllowed}) until the real probe's first resolution overwrites this value.
 */
// DIVERGENCE (design sample data, not layout): this placeholder previously read `agent: "codex"`
// — the design's sample identity, not layout (user decision 2026-07-23). MVP ships Claude only,
// so the pre-probe placeholder names the actual (only) shipped backend instead of the design
// mock's Codex sample; it is still overwritten by the injected probe's real reading the moment
// it resolves (M22).
//
// `HomeAgentHealth` has had no `model`/`effort`/`version` fields since phase-8 Task 13 split
// them out (finding §2.7): Home's combo reads the SEPARATE, synchronous `local.agentSelection`
// atom below, seeded directly by the composition root at construction rather than riding this
// health probe's promise.
const DEFAULT_HOME_HEALTH: HomeAgentHealth = {
  kind: "checking",
  agent: "claude",
};

/**
 * The DEFAULT test/demo probe's resolution — deliberately NOT {@link DEFAULT_HOME_HEALTH}
 * (finding §2.7, phase-8 Task 15), and CORRECTED to never be `ready` (fix round 1, Finding 1 —
 * CRITICAL). This constant is the value {@link createUiDeps}'s own default `agentHealthProbe`
 * parameter resolves to whenever NO probe is injected — and that default is REACHABLE IN
 * PRODUCTION: `entrypoint/model/run-app.ts`'s `resolveAgentHealthProbe` returns `undefined` for
 * demo mode (`registry === null`) and for an empty catalog, and `ui/app/model/root.tsx` passes
 * `options.agentHealthProbe` straight through to this default. A `ready` resolution here — this
 * constant's first version — meant demo mode landed on "a real, passing probe" with NO probe
 * ever having run, the exact fabrication finding §2.7 exists to remove, just moved down one line
 * instead of removed.
 *
 * `advisory` is the honest fix: a REAL member of the union that PERMITS submit (matching demo
 * mode's pre-Task-15 behaviour of always being usable) without asserting anything was verified —
 * the design's own "health unconfirmed" bucket (`homeHealth('shutdown')`) is the literal truth
 * for "no probe ran at all", the most extreme case of "not confirmed". Never `ready` — that
 * specific claim is reserved for an actual passing `AgentBackend.healthCheck()` reading
 * (`entrypoint/model/agent-health.ts`'s `homeHealthFromAgentInfo`, `case "ready"`).
 */
const DEFAULT_PROBE_RESOLUTION: HomeAgentHealth = {
  kind: "advisory",
  agent: "claude",
  panel: "shutdown",
  detail: "no health probe ran for this session",
};

/** Builds a fresh, self-consistent `UiDeps` around a `KernelPort` and an initial terminal size. */
export function createUiDeps(
  port: KernelPort,
  initialSize: Readonly<{ w: number; h: number }>,
  env: UiEnv = { root: ".", workspaceIdentity: "local", projectExists: false },
  // The named M15 injection point: the phase-8 composition root supplies a probe that actually
  // checks the agent CLI on PATH; tests inject a fake. The default resolves to an honest
  // `advisory` reading — NEVER `ready` (fix round 1, Finding 1) — see
  // {@link DEFAULT_PROBE_RESOLUTION}'s own doc comment for why it must differ from both `ready`
  // and {@link DEFAULT_HOME_HEALTH}.
  agentHealthProbe: () => Promise<HomeAgentHealth> = () =>
    Promise.resolve(DEFAULT_PROBE_RESOLUTION),
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
  // The tab-strip override and the one effective slug derived from it — see
  // `ui/workspace/model/page-selection.ts` for why the user's page choice is UI-local state.
  // Declared here, above `runtime`, because that atom's connect hook drives the preview session
  // off `activePageSlug` below.
  const pageOverride = atom<string | null>(null, "ui.local.pageOverride");
  const activePageSlug = computed<string | null>(
    () => pageOverride() ?? mirror.project().activePageSlug,
    "ui.app.activePageSlug",
  );
  // What the preview session is asked for: the effective page AND the bytes it should be
  // rendering. The `sourceHash` half is why this is not just `activePageSlug` — a turn that
  // rewrites the page already on screen changes no slug at all, and a slug-keyed request would
  // leave the host rendering the pre-turn source (the 2026-07-26 defect `requestPreviewForActive
  // Page`'s own memo was rebuilt to fix). A page with no descriptor yet reports a `null` hash
  // rather than inventing one.
  const activePageRequest = computed<Readonly<{
    slug: string;
    sourceHash: Sha256Hex | null;
  }> | null>(() => {
    const slug = activePageSlug();
    if (slug === null) return null;
    const descriptor = mirror.pageDescriptors().find((entry) => entry.pageSlug === slug);
    return { slug, sourceHash: descriptor?.sourceHash ?? null };
  }, "ui.app.activePageRequest");

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
      // The frame loop's attachment point. Declared HERE, above `applyEnvelope` — which reads
      // it through `resyncPreviewSession` — because `port.subscribe` below may deliver an
      // envelope synchronously, and a `let` declared further down would still be in its
      // temporal dead zone when that first event lands.
      let active = true;
      let frameIterator: AsyncIterator<UiPreviewFrame> | null = null;
      let frameHandle: PreviewSessionHandle | null = null;
      const stopFrameIterator = () => {
        const iterator = frameIterator;
        frameIterator = null;
        frameHandle = null;
        if (iterator?.return === undefined) return;
        void iterator.return().catch((cause) => {
          console.error("UI preview frame iterator cleanup failed:", cause);
        });
      };
      /**
       * REGRESSION FIX (2026-07-27) — leave a session the Kernel has already replaced.
       *
       * The loop below re-reads `port.preview()` only when the CURRENT frame stream ends, so a
       * replacement session is picked up only if the predecessor's stream closes. Every page
       * edit produces one: `HostSupervisor.preview` keys by page + source hash, so a new hash
       * is a new key, a new relay, and a new `PreviewSession` object. `kernel.ts`'s
       * `setActivePreviewSession` now closes the predecessor, which ends its stream — this is
       * the UI's own half of that guarantee, so a producer that ever abandons a session
       * silently again costs one stale frame instead of freezing the preview on
       * `preparing preview…` for the rest of the run.
       *
       * Returning the iterator is deliberately the SAME exit the loop already handles: it
       * resolves the parked `next()` with `done`, the inner loop breaks, and the outer loop
       * re-reads `port.preview()`. No second code path, no second way to be wrong.
       */
      const resyncPreviewSession = () => {
        if (frameHandle === null) return;
        if (port.preview() === frameHandle) return;
        stopFrameIterator();
      };
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
        // AFTER the mirror fold, not before: `preview.sessionReady`/`preview.sourceChanged` are
        // what make `port.preview()` report the successor, and the fold is what the rest of the
        // UI reads. Cheap — a reference comparison per event.
        resyncPreviewSession();
      });
      const unsubscribe = port.subscribe(applyEnvelope);
      if (unsubscribe instanceof Error) {
        reportRuntimeError(unsubscribe, "UI Kernel subscription failed:");
      }
      // Gap A's last wiring (phase-8 Task 21, spec §4.7). Tasks 8 and 10 brought the preview
      // machine to `idle` and pointed the session commands at the canonical page source, but
      // NOTHING under `src/ui` ever asked for a session — so the Workspace sat on
      // `preparing preview…` forever. This subscriber is that ask.
      //
      // Owned by THIS connect hook (RTM-L01) and torn down by the cleanup below: a bare
      // module-level `effect` would outlive the mirror it subscribes to. `bind(...)` is created
      // here, in the hook body, before anything async — the dispatch resolves in a promise
      // continuation, where an unbound write would land on the default context (RTM-A04).
      // THE MEMO IS KEYED ON CONTENT, NOT JUST IDENTITY (defect fix, 2026-07-26).
      //
      // It used to be `lastRequestedPageSlug`, a bare slug. Asking the agent to change the page
      // already on screen — the single most common thing a user does here — does not change that
      // slug, so this returned early and the live session went on rendering the pre-turn source
      // forever. The user's own change was invisible unless they switched pages and back, which
      // a one-page project (the state every project starts in) cannot even do.
      //
      // The page's `sourceHash` is the honest key: it is what actually decides whether the host
      // is rendering the right bytes, and the Kernel now republishes it after every commit
      // (`core/kernel/model/handlers/page-descriptors.ts`). A page with no descriptor yet falls
      // back to the slug alone rather than inventing a hash — one redundant re-select is
      // cheaper than a preview stuck on stale content.
      let lastRequestedPageKey: string | null = null;
      // TWO WAYS TO RETIRE THE TAB STRIP'S OPTIMISTIC PICK, and they are not interchangeable.
      // Both are declared HERE, above their first use, for the same reason `active` is:
      // `bind(...)` must be created in this hook body, before anything async, so the
      // `pageOverride.set` each performs from a promise continuation or a subscriber lands in the
      // runtime's own Reatom context rather than the default one (RTM-A04).
      //
      // UNCONDITIONAL — one caller, the Kernel-truth subscriber further down. When the Kernel
      // publishes an active slug of its own it is authoritative whatever the pick was, so there
      // is nothing to compare against.
      const retirePageOverride = bind(() => pageOverride.set(null));
      // SCOPED TO ITS OWN DISPATCH — the two terminal-refusal branches below. The memo is keyed
      // `slug@hash`, so two quick clicks leave two `preview.selectPage` dispatches in flight at
      // once. An unconditional clear would let the FIRST one's refusal wipe the SECOND,
      // still-pending pick — the effective slug would snap back to the Kernel's page and the strip
      // would again mark a page the user did not choose, which is precisely the defect this branch
      // exists to fix. A refusal may only retire the pick it was actually dispatched for.
      //
      // Slug equality is the comparison, so it still cannot tell two in-flight dispatches for the
      // SAME slug apart (click B, click C, click B again). Narrower than the case above and not
      // closed here; a per-dispatch token would be the real fix — recorded as follow-up.
      const retirePageOverrideIfCurrent = bind((rawPageSlug: string) => {
        if (pageOverride() !== rawPageSlug) return;
        pageOverride.set(null);
      });
      const requestPreviewForActivePage = bind((rawPageSlug: string, sourceHash: string | null) => {
        const pageKey = `${rawPageSlug}@${sourceHash ?? ""}`;
        if (pageKey === lastRequestedPageKey) return;
        // `ProjectMirror.activePageSlug` is a plain `string` (the mirror folds whatever the Kernel
        // published), while `preview.selectPage`'s payload wants the branded `PageSlug`. Validated
        // through the existing guard rather than cast — and a slug that does not parse is refused
        // and logged, never sent on (errore rule 21; "never fabricate a fact").
        const pageSlug = parsePageSlug(rawPageSlug);
        if (pageSlug instanceof Error) {
          lastRequestedPageKey = pageKey;
          console.warn(
            `UI preview.selectPage skipped — active page slug "${rawPageSlug}" is not a valid PageSlug:`,
            pageSlug.message,
          );
          return;
        }
        lastRequestedPageKey = pageKey;
        // DIAGNOSTIC (HANDOFF Finding 2): the ONE place a page choice becomes a Kernel command.
        // Without this the log could not distinguish "the memo swallowed the click", "the
        // dispatch was made and refused", and "the dispatch was accepted and the handler never
        // ran" — three different bugs that all look identical as silence.
        trace("ui.preview.request", { pageSlug, sourceHash, pageKey });
        void dispatcher.dispatch("preview.selectPage", { pageSlug }).then((result) => {
          // A PAGE SWITCH THAT DID NOT HAPPEN MUST NOT STAY ON THE TAB STRIP (defect fix,
          // 2026-07-28). `ui/workspace/model/page-selection.ts` sets `pageOverride` optimistically
          // BEFORE dispatching, and the only thing that used to retire it was the KERNEL's own
          // active slug CHANGING — which a refusal, by definition, does not do. So every terminal
          // refusal left the strip marking a page the preview was not showing, permanently:
          // `activePageSlug` is `override ?? Kernel`, so the whole Workspace agreed on a page that
          // was never established. Retiring it here drops the effective slug back to the Kernel's
          // own page, which is what is actually on screen. Both branches below are terminal, so
          // both must clear it — a rejected dispatch and a failed one are equally unbacked.
          if (result instanceof Error) {
            // Logged rather than swallowed (errore rule 21); `runtimeError` is reserved for
            // failures that make the UI unusable, and a preview that did not start is not one.
            console.warn(`UI preview.selectPage dispatch failed for "${pageSlug}":`, result);
            lastRequestedPageKey = null;
            retirePageOverrideIfCurrent(rawPageSlug);
            return;
          }
          if (result.status === "rejected") {
            // Not fatal — an untrusted project keeps preview `disabled` by design (spec §2.2),
            // and the refusal is the honest outcome there. Clearing the memo lets a later
            // descriptor change retry once the guard's precondition actually holds.
            console.warn(`UI preview.selectPage was rejected for "${pageSlug}" (${result.code})`);
            lastRequestedPageKey = null;
            retirePageOverrideIfCurrent(rawPageSlug);
            return;
          }
          // The accepted path used to be silent, which is what made Finding 2 unreadable: an
          // accepted dispatch and a never-attempted one left the same (empty) evidence. Same
          // channel and shape `page-selection.ts` already uses for `selection.clear`.
          trace("ui.dispatch.result", { kind: "preview.selectPage", pageSlug, result });
        });
      });
      // THE ESCAPE FROM A BLOCKED OPEN (defect fix, 2026-07-26).
      //
      // `handlers/project.ts` funnels nine startup failures through `blockOpen`, which leaves the
      // project machine in `blocked`. That state has exactly two legal exits (`core/machines/
      // model/project-machine.ts`'s table): `retryOpen`, which needs a recovery domain and action
      // id no UI path has, and `beginClose`. Without one of them the app was permanently stuck —
      // `deriveScreen` held Home (projectId still null), and Home's Enter dispatches
      // `project.open`/`project.create`, both illegal from `blocked`, so every press was rejected
      // `CAPABILITY_UNAVAILABLE` and did nothing, with no message, forever.
      //
      // Closing is the honest recovery, not a workaround: the project never became ready, so
      // there is no state to lose, and `project.close` releases the store lease the failed open
      // took. It lands the machine back in `closed`, where Home's own Enter is legal again — so
      // "⏎ retries the open" (what `HomeOpenFailurePanel` tells the user) is true. The panel
      // itself survives the close on purpose: `ProjectMirror.openFailure` is the one field
      // `finishClose` does not reset, so the reason stays on screen after the recovery.
      // Latched by REFERENCE, not by value: every `blockOpen` fold builds a fresh
      // `openFailure` object, so a second block — even one with the identical reason — is a
      // different reference and is recovered again, while the many project writes that merely
      // carry the same object forward (`page.descriptorsChanged`, `chat.changed`, and
      // `finishClose`, which deliberately preserves it) are all skipped. Without this the
      // recovery's own `finishClose` would re-satisfy the condition below and dispatch
      // `project.close` in a loop, illegally, from `closed`.
      let recoveredFailure: ProjectOpenFailure | null = null;
      const recoverFromBlockedOpen = bind((failure: ProjectOpenFailure) => {
        if (recoveredFailure === failure) return;
        recoveredFailure = failure;
        void dispatcher.dispatch("project.close", {}).then((result) => {
          if (result instanceof Error) {
            // Logged, never swallowed (errore rule 21). `runtimeError` stays reserved for
            // failures that make the UI unusable; the user can still read the panel and quit.
            console.warn("UI project.close (blocked-open recovery) dispatch failed:", result);
            return;
          }
          if (result.status === "rejected") {
            console.warn(
              `UI project.close (blocked-open recovery) was rejected (${result.code}) — Home's Enter may stay refused`,
            );
          }
        });
      });
      // KERNEL TRUTH RETIRES THE USER'S TAB PICK (page switching, 2026-07-27). `pageOverride`
      // only ever covers the window between a tab click and the Kernel publishing an active slug
      // of its own. When that slug arrives it either MATCHES the pick (`preview.selectPage`
      // persisted it into `workspace.local.toml`, so `resolveActivePageSlug` hands it back) —
      // clearing changes nothing on screen — or it DIFFERS, which per §6.2 means `pages.json`
      // requested the move on apply, and the Kernel's choice must win. Both cases are the same
      // rule: a changed Kernel slug retires the override. Starts `null` rather than reading
      // `mirror.project()` here, which would make this connect hook depend on the project slice:
      // no override can exist before the first tab click anyway, so the first notification's
      // clear is a no-op. This is the ONLY caller of the unconditional `retirePageOverride`
      // (declared above): Kernel truth outranks the pick whatever it was, so unlike the refusal
      // branches — which use the slug-scoped `retirePageOverrideIfCurrent`, since a refusal only
      // speaks for the dispatch it belongs to — there is nothing here worth comparing against.
      let lastKernelPageSlug: string | null = null;
      const unsubscribeProject = mirror.project.subscribe((project) => {
        if (project.activePageSlug !== lastKernelPageSlug) {
          lastKernelPageSlug = project.activePageSlug;
          retirePageOverride();
        }
        // `projectId === null` is what says the open never finished: `finishOpen` clears
        // `openFailure` anyway, so this pair only ever holds for a genuinely blocked open — never
        // for the panel lingering after a successful recovery, which has already been closed.
        if (project.openFailure !== null && project.projectId === null) {
          recoverFromBlockedOpen(project.openFailure);
        }
      });
      // Driven by the EFFECTIVE slug, not by `mirror.project` directly, so a tab click reaches
      // the host through the same memoized path a Kernel-published page change does — one
      // producer of `preview.selectPage`, so a click can never race the echo into establishing
      // the same session twice.
      const unsubscribeActivePage = activePageRequest.subscribe((request) => {
        if (request === null) return;
        requestPreviewForActivePage(request.slug, request.sourceHash);
      });
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
          frameHandle = handle;
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
          if (frameIterator === iterator) {
            frameIterator = null;
            frameHandle = null;
          }
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
        unsubscribeActivePage();
        unsubscribeProject();
        if (typeof unsubscribe === "function") unsubscribe();
      };
    }),
  );

  const composer = atom("", "ui.local.composer");
  // Hoisted above `slashSelection` (like `composer`) so its own `withComputed` can read it
  // directly — phase-8 Task 17 (§3.10): the Home prompt is the OTHER primary input the slash
  // selection must re-derive from, exactly as `composer` already does for Workspace.
  const prompt = atom("", "ui.local.prompt");
  // The slash selection is state DERIVED from the typed prefix of whichever screen's primary
  // input is active: every edit to it lands the selection back on the first enabled row. Owned
  // by the atom (RTM-S02) rather than re-set by hand in each input-writing key handler.
  // `slash-move` still writes it directly — that is the point of `withComputed` over a plain
  // `computed`. Both `screen` and the action context are PEEKED, not tracked (review fix round 1,
  // phase-8 Task 17 — `screen` was briefly tracked here, see below for why that was wrong): a
  // capability flip, a turn starting, or a screen transition mid-navigation must never move the
  // user's cursor on their own; only what they actually TYPE does. The menu is only ever opened
  // by `intent.ts`'s `slash-open` writing `"/"` into whichever input is primary AT THAT MOMENT —
  // that write is what recomputes this atom, and `peek(screen)` inside the SAME recompute still
  // reads the CURRENT screen correctly, so tracking it bought nothing but an extra reactivity: a
  // terminal resize below `MIN_FRAME` with the menu open flips `screen()` to `"enlarge"` on its
  // own (no input write at all), which used to recompute this atom against neither primary input
  // — `filterSlashRows` then finds no row scoped to `"enlarge"` and resets the selection to `-1`,
  // discarding an arrow-key choice the user made before the resize, for a screen the menu was
  // never even open on.
  const slashSelection = atom(0, "ui.local.slashSelection").extend(
    withComputed((state) => {
      // Read every dependency BEFORE the init branch, per the upstream `page`/`search` example:
      // returning early without reading one would register no dependency for it at all, and the
      // atom would never recompute again once THAT input started changing.
      const composerTyped = composer();
      const promptTyped = prompt();
      const typed = peek(screen) === "home" ? promptTyped : composerTyped;
      return isInit() ? state : firstEnabledIndex(filterSlashRows(typed, peek(actionContext)));
    }),
  );
  // Prime the init computation here, while both inputs are still empty. The init branch keeps
  // the stored value and only REGISTERS the dependencies, so whoever reads the atom first would
  // otherwise consume it — and an edit to whichever input is primary would not re-derive.
  void slashSelection();

  const local: UiLocalState = {
    prompt,
    composer,
    focus: atom<FocusTarget>("composer", "ui.local.focus"),
    fullscreen: atom(false, "ui.local.fullscreen"),
    overlay: atom<OverlayKind | null>(null, "ui.local.overlay"),
    slashSelection,
    chatSelection: atom(0, "ui.local.chatSelection"),
    pinDraft: atom("", "ui.local.pinDraft"),
    pageOverride,
    exportDismissed: atom<UUIDv7 | null>(null, "ui.local.exportDismissed"),
    homeHealth: atom<HomeAgentHealth>(DEFAULT_HOME_HEALTH, "ui.local.homeHealth"),
    agentSelection: atom<HomeAgentSelection | null>(agentSelection, "ui.local.agentSelection"),
  };

  const refreshHomeHealth = action(async () => {
    // SHOW THAT THE PROBE IS RUNNING (defect fix, 2026-07-26). Startup already looked right,
    // because `homeHealth` is SEEDED `checking` — but a manual `r` re-check only ever wrote the
    // RESULT, so the previous verdict (`✗ claude not signed in`, say) sat unchanged on screen
    // for the probe's whole run, up to the 20s timeout. A user who fixed the cause and pressed
    // `r` had no way to tell whether anything was happening. Re-entering `checking` first reuses
    // the state the design already draws for exactly this — spinner, `⏎ disabled` badge
    // (`design/termcraft-engine.js:139-161`, `home('checking')`) — rather than adding a new one.
    //
    // The agent name is carried over from the reading being replaced: it is the same agent being
    // re-probed, and every member of the union carries it, so nothing is invented here.
    local.homeHealth.set({ kind: "checking", agent: local.homeHealth().agent });
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
    activePageSlug,
    refreshHomeHealth,
    requestExit,
  };
  return deps;
}
