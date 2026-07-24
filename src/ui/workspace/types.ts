import type { Atom, Computed } from "@reatom/core";

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
}
