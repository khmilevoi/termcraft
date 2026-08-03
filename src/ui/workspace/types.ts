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
   * The agent-health reading, shown as the lowest-precedence badge in the status bar's `hint`
   * slot (workspace-first launch, 2026-08-02). Read-only from this module's point of view: there
   * is no WORKSPACE re-check, and the reading is never refreshed from here — only Home's own `r`
   * re-check (`ui/app/model/intent.ts:45`) replaces it, and Home is off the launch path (reached
   * only when a startup open fails, `App.tsx:246`). That is a deliberate trade, recorded in the
   * spec — a `/recheck` action was considered and declined.
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
