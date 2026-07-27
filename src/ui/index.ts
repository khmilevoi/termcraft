/**
 * `ui` — the OpenTUI app shell (phase 7). A leaf presentation module: it imports only
 * `core`'s boundary DTOs and the `PreviewSession` facade, declares the `KernelPort` the
 * phase-8 composition root satisfies, and keeps its own Reatom read-model ("mirror") fed by
 * the Kernel event stream. This barrel is the module's public surface; it grows per slice.
 */
export type { KernelPort, PreviewSessionHandle, UiPreviewFrame } from "./kernel";

// Kernel boundary
export type {
  AnyEventEnvelope,
  Dispatcher,
  DispatcherDeps,
  EventCorrelationV1,
  EventEnvelopeV1,
  EventOf,
} from "./kernel";
export { KernelDispatchError, createDispatcher } from "./kernel";

// Mirror read-model
export type {
  ChatsMirror,
  ExportMirror,
  Mirror,
  PreviewMirror,
  ProjectMirror,
  ProjectOpenFailure,
  ScreenInput,
  ScreenKind,
  SelectionMirror,
  TurnMirror,
} from "./mirror";
export { MIN_FRAME, createMirror, createScreenAtom, deriveScreen } from "./mirror";

// Theme
export type { ShellPalette, ShellTextStyle, ShellToken } from "./theme";
export { LIGHT_SHELL_PALETTE, SHELL_PALETTE, shellAttrs } from "./theme";

// Composition root surface (phase-8 mounts this)
export type { UiDeps, UiEnv, UiRootAdapters, UiRootHandle, UiRootOptions } from "./app";
export { App, createUiDeps, createUiRoot, UiPreviewStreamError, UiRootError } from "./app";
