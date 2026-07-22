import { bind, type Atom, type Computed, atom, sleep, withConnectHook, wrap } from "@reatom/core";
import * as errore from "errore";

import {
  type AnyEventEnvelope,
  type Dispatcher,
  type EventEnvelopeV1,
  type KernelPort,
  type UiPreviewFrame,
  createDispatcher,
} from "ui/kernel";
import { type Mirror, type ScreenKind, createMirror, createScreenAtom } from "ui/mirror";
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
  readonly local: UiLocalState;
}

export class UiPreviewStreamError extends errore.createTaggedError({
  name: "UiPreviewStreamError",
  message: "UI preview stream failed",
}) {}

/** Builds a fresh, self-consistent `UiDeps` around a `KernelPort` and an initial terminal size. */
export function createUiDeps(
  port: KernelPort,
  initialSize: Readonly<{ w: number; h: number }>,
  env: UiEnv = { root: ".", workspaceIdentity: "local" },
): UiDeps {
  const mirror = createMirror();
  const terminal = atom(initialSize, "ui.app.terminal");
  const dispatcher = createDispatcher({ port, revision: () => mirror.stateRevision() });
  const screen = createScreenAtom({ project: () => mirror.project(), terminal: () => terminal() });
  const previewFrame = atom<UiPreviewFrame | null>(null, "ui.app.previewFrame");
  const runtimeError = atom<Error | null>(null, "ui.app.runtimeError");

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
      const applyEnvelope = bind((envelope: EventEnvelopeV1) =>
        mirror.apply(envelope as AnyEventEnvelope),
      );
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

  const local: UiLocalState = {
    prompt: atom("", "ui.local.prompt"),
    composer: atom("", "ui.local.composer"),
    focus: atom<FocusTarget>("composer", "ui.local.focus"),
    fullscreen: atom(false, "ui.local.fullscreen"),
    overlay: atom<OverlayKind | null>(null, "ui.local.overlay"),
  };
  return {
    port,
    env,
    mirror,
    dispatcher,
    terminal,
    screen,
    previewFrame,
    runtimeError,
    runtime,
    local,
  };
}
