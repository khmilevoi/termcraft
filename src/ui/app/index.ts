/**
 * `ui/app` — the composition of the shell: the `UiDeps` factory, the root `App` component,
 * and the pure keyboard/intent layer. The phase-8 composition root builds `UiDeps` around the
 * real Kernel and mounts `<App deps={...} />` through OpenTUI's `createRoot`.
 */
export type { UiDeps, UiEnv, UiLocalState } from "./model/deps";
export { createUiDeps, UiPreviewStreamError } from "./model/deps";
export type { UiRootAdapters, UiRootHandle, UiRootOptions } from "./model/root";
export { createUiRoot, UiRootError } from "./model/root";
/**
 * The extracted mount `createUiRoot` calls (Task 8) — re-exported here so a second surface with
 * no `KernelPort` (`ui/setup`'s pre-Kernel migration root) can reuse it through this module's own
 * public entry point, rather than reaching into `./model/render-root` directly.
 */
export { defaultAdapters, mountRenderRoot } from "./model/render-root";
export type { KeyContext, KeyIntent, KeyLike } from "./model/keymap";
export { isClaimedKey, resolveActiveOverlay, resolveKey } from "./model/keymap";
export { applyIntent } from "./model/intent";
export { App } from "./ui/App";
