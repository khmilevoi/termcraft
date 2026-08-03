import type { Atom, Computed } from "@reatom/core";

import type { ChatOlderPageState } from "ui/chat";
import type { Dispatcher, UiPreviewFrame } from "ui/kernel";
import type { Mirror, ScreenKind } from "ui/mirror";
import type { PreviewInteractionState } from "ui/preview";

import type { FocusTarget, OverlayKind } from "./model/focus";

/**
 * The chat stream's scroll surface, as the keyboard layer sees it (chat-scroll spec §5.5).
 *
 * Scrolling is imperative and `applyIntent` is pure, so the two meet here rather than in a
 * component: `Workspace.tsx` publishes an adapter over the live `ScrollBoxRenderable` into
 * {@link WorkspaceLocalState.chatViewport}, and `applyIntent` reads that atom and calls a
 * method — exactly as it already calls `dispatcher`. Tests substitute a fake and need no
 * renderer.
 *
 * Deliberately five methods, not a handle to the renderable: everything the keyboard layer
 * needs is expressible without exposing `scrollTop`/`scrollHeight`, and the spec's own §5.4
 * turns on the UI never reading a continuous scroll metric to keep a label truthful.
 */
export interface ChatViewport {
  /** One viewport-height step; `-1` is up (toward older), `1` is down. */
  scrollByPage(direction: -1 | 1): void;
  scrollToBottom(): void;
  atBottom(): boolean;
  /** Rows between the bottom of the content and the bottom of the viewport, right now. */
  anchorFromBottom(): number;
  /** Puts that same distance back after content changed above the viewport. */
  restoreAnchor(distanceFromBottom: number): void;
}

/**
 * Exactly what the `Workspace` component reads/writes. Declared here (not in `ui/app`) so
 * `ui/workspace` never imports `ui/app` — the App's `UiDeps` structurally satisfies this,
 * breaking the App<->Workspace import cycle. The composition root passes its full `UiDeps`
 * where a `WorkspaceDeps` is expected.
 */
export interface WorkspaceLocalState {
  readonly composer: Atom<string>;
  readonly focus: Atom<FocusTarget>;
  readonly fullscreen: Atom<boolean>;
  readonly overlay: Atom<OverlayKind | null>;
  readonly slashSelection: Atom<number>;
  readonly chatSelection: Atom<number>;
  readonly pinDraft: Atom<string>;
  /**
   * The page the user picked from the tab strip, or `null` while the Kernel's own active slug
   * is the whole truth. UI-local view state, exactly like {@link WorkspaceLocalState.focus} —
   * see `model/page-selection.ts` for why a tab click cannot travel through Kernel state.
   */
  readonly pageOverride: Atom<string | null>;
  /**
   * The live chat scroll surface, or `null` before the first render publishes one (and
   * whenever the Workspace is unmounted). Written only by `Workspace.tsx`'s ref callback.
   */
  readonly chatViewport: Atom<ChatViewport | null>;
  /** The older-page load latch — see `ui/chat`'s {@link ChatOlderPageState}. */
  readonly olderPage: Atom<ChatOlderPageState>;
}

export interface WorkspaceDeps {
  readonly mirror: Mirror;
  readonly dispatcher: Dispatcher;
  readonly terminal: Atom<Readonly<{ w: number; h: number }>>;
  readonly screen: Computed<ScreenKind>;
  readonly previewFrame: Atom<UiPreviewFrame | null>;
  readonly runtimeError: Atom<Error | null>;
  readonly interaction: PreviewInteractionState;
  readonly local: WorkspaceLocalState;
  /**
   * The page the Workspace is actually showing: the tab-strip override when the user has picked
   * one, else the Kernel's own `activePageSlug`. Every consumer — tab strip, status bar, pin
   * list, composer attach line, and the preview-session request in `ui/app/model/deps.ts` —
   * reads THIS, never `mirror.project().activePageSlug` directly, so they cannot disagree.
   */
  readonly activePageSlug: Computed<string | null>;
}
