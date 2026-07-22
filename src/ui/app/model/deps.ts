import { type Atom, type Computed, atom, sleep, withConnectHook } from "@reatom/core";

import type { PreviewFrameV1 } from "core/ports";
import {
  type AnyEventEnvelope,
  type Dispatcher,
  type KernelPort,
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
  readonly previewFrame: Atom<PreviewFrameV1 | null>;
  /**
   * The App reads this to activate the Kernel subscription + preview-frame consumer for its
   * mounted lifetime. Both are owned by this atom's connect hook (RTM-L01/L02) — the
   * subscription and the frame loop stop automatically when the App unmounts (its cleanup),
   * rather than leaking as a bare module-level effect.
   */
  readonly runtime: Atom<undefined>;
  readonly local: UiLocalState;
}

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
  const previewFrame = atom<PreviewFrameV1 | null>(null, "ui.app.previewFrame");

  const runtime = atom<undefined>(undefined, "ui.app.runtime").extend(
    withConnectHook(() => {
      const unsubscribe = port.subscribe((envelope) => mirror.apply(envelope as AnyEventEnvelope));
      let active = true;
      void (async () => {
        // Frames flow through the PreviewSession facade, not the event stream (§7.6). Iterate
        // the current session's frames; when none exists, poll until one appears; when a
        // session's stream ends, loop back to pick up its successor.
        while (active) {
          const handle = port.preview();
          if (handle === null) {
            await sleep(FRAME_POLL_MS);
            continue;
          }
          for await (const frame of handle.session.frames) {
            if (!active) break;
            previewFrame.set(frame);
          }
          if (active) await sleep(FRAME_POLL_MS);
        }
      })();
      return () => {
        active = false;
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
  return { port, env, mirror, dispatcher, terminal, screen, previewFrame, runtime, local };
}
