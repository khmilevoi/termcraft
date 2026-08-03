import type { Atom, Computed } from "@reatom/core";

import type { AgentHealth } from "ui/agent-health";
import type { Dispatcher, UiPreviewFrame } from "ui/kernel";
import type { Mirror, ScreenKind } from "ui/mirror";
import type { PreviewInteractionState } from "ui/preview";

import type { FocusTarget, OverlayKind } from "./model/focus";

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
   * The agent-health reading (spec 2026-08-02). Home used to be this atom's only consumer; the
   * Workspace now renders it in the status bar's `hint` slot, because routing an existing project
   * straight here would otherwise leave a dead agent CLI with no on-screen signal at all.
   *
   * KNOWN, DELIBERATE (design 30 §"The long-lived badge"): the probe runs once at startup and is
   * never refreshed. Signing in to the agent CLI in another terminal leaves this badge red until
   * termcraft restarts. A `/recheck` action (~30 lines, reusing `refreshAgentHealth`) was
   * considered and declined; the design only ever mandated `r` on HOME's error state.
   */
  readonly agentHealth: Atom<AgentHealth>;
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
