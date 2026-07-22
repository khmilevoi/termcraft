/**
 * `ui/workspace` — the workspace shell composition and its pure logic: the layered `Esc`
 * stack + focus model and the tab-strip derivation. The `Workspace` component itself is
 * added by the shell-assembly step.
 */
export type { EscOutcome, EscState, FocusTarget, OverlayKind } from "./model/focus";
export { nextFocus, resolveEsc, singleCharKeysActive } from "./model/focus";
export type { TabEntry } from "./model/tabs";
export { deriveTabs, tabWidth, tabsOverflow } from "./model/tabs";
