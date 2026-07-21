import type { ThemeId, ThemeTokens } from "../types";
import { atom, computed } from "./reatom";
import { DEFAULT_THEME_ID, themeTokens } from "./tokens";

/**
 * Declares a page's tweak controls (runtime-api §6). DORMANT in the MVP: like
 * `definePage`, it only records the declaration shape; the scoped reactive
 * toggle/select/text values and the Tweaks panel that drives them land with the
 * phase-7 UI (`defineTweaks` is exported but inert until then).
 */
export function defineTweaks<T extends Record<string, unknown>>(declaration: T): T {
  return declaration;
}

/**
 * The host-scoped mode capability (§6). These named atoms are HOST INPUTS: the
 * Kernel initializes `hostMode`/`interactionMode` only from an accepted `ready`
 * response and updates `interactionMode` only from an accepted correlated
 * `set-mode` response (phase-6 wiring) — a page reads them so deterministic
 * export behavior never depends on a private global. MVP defaults are
 * `preview` + `static`; a page must not write them.
 */
export const hostModeAtom = atom<"preview" | "export">("preview", "runtime.capability.hostMode");
export const interactionModeAtom = atom<"static" | "interactive">(
  "static",
  "runtime.capability.interactionMode",
);

/** True while the host renders this page for deterministic export (§6, §11.4). */
export const isExportAtom = computed(
  () => hostModeAtom() === "export",
  "runtime.capability.isExport",
);

/** A page-readable helper for the export flag (reads {@link isExportAtom}). */
export function isExport(): boolean {
  return isExportAtom();
}

/** The theme capability (§6): the active theme id and its resolved token palette. */
export interface ThemeCapability {
  readonly themeId: ThemeId;
  readonly tokens: ThemeTokens;
}

/**
 * Resolve the current theme capability (§6). MVP returns the single `dark-default`
 * theme; the preview-override path (a theme atom the shell writes without rewriting
 * `meta.theme`) rides with the phase-7 theme capability wiring.
 */
export function themeCapability(): ThemeCapability {
  return { themeId: DEFAULT_THEME_ID, tokens: themeTokens(DEFAULT_THEME_ID) };
}
