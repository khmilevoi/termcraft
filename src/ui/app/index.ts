/**
 * `ui/app` — the composition of the shell: the `UiDeps` factory, the root `App` component,
 * and the pure keyboard/intent layer. The phase-8 composition root builds `UiDeps` around the
 * real Kernel and mounts `<App deps={...} />` through OpenTUI's `createRoot`.
 */
export type { UiDeps, UiEnv, UiLocalState } from "./model/deps";
export { createUiDeps, UiPreviewStreamError } from "./model/deps";
export type { UiRootAdapters, UiRootHandle, UiRootOptions } from "./model/root";
export { createUiRoot, UiRootError } from "./model/root";
export type { KeyContext, KeyIntent, KeyLike } from "./model/keymap";
export { isClaimedKey, resolveActiveOverlay, resolveKey } from "./model/keymap";
export { applyIntent } from "./model/intent";
export { App } from "./ui/App";
