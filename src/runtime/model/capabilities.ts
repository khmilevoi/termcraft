import type { Size, ThemeId, ThemeTokens } from "../types";
import { action, atom, computed } from "./reatom";
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

/**
 * The navigation capability's named action (§6; design §5.5: `usePages().goTo(slug)`
 * "emits a page-navigation event through the host protocol; the shell switches tabs.
 * A target missing from the project manifest is a no-op with a quiet notice.").
 * DORMANT in the MVP, like `defineTweaks` above: the host-protocol emission and the
 * shell's tab switch land in phase 7 (out of WP-8 scope), so calling this action
 * records/emits nothing observable yet — it is a named no-op the future wiring
 * replaces in place, never a component-hook side effect (§5.1).
 */
const goToPage = action((_slug: string) => {}, "runtime.capability.goTo");

/** The navigation capability (§6): `usePages().goTo(slug)`. */
export interface PagesCapability {
  readonly goTo: (slug: string) => void;
}

/**
 * Retrieves the navigation capability (design §5.5). A minimal context lookup
 * (§6) — DORMANT in MVP, see {@link goToPage}.
 */
export function usePages(): PagesCapability {
  return { goTo: goToPage };
}

/**
 * The host-scoped viewport/terminal capability (§6): "reactive size and
 * color-capability values supplied by the host." Modeled like `hostModeAtom`/
 * `interactionModeAtom` above — named HOST-INPUT atoms a page reads and must not
 * write; a future host handshake seeds them from the negotiated terminal
 * capabilities (`host/types.ts`'s `TerminalCapabilities`, whose own comment names
 * this exact model as its target). DORMANT in MVP: the host doesn't wire real
 * viewport/color negotiation yet, so both atoms carry fixed defaults.
 *
 * `viewportSizeAtom` defaults to 80x24 (columns x rows): the classic terminal size,
 * the first entry in the design's own preview-size preset list (design §8.1 item
 * 10: "80×24, 120×40, custom..., auto"), and the size used by every `minSize`
 * example in the runtime-api spec itself. Neither spec fixes this as the
 * *capability*'s default value, though — this MVP default is this task's own
 * choice, documented here rather than silently invented.
 */
export const viewportSizeAtom = atom<Size>({ w: 80, h: 24 }, "runtime.capability.viewportSize");

/**
 * `colorDepthAtom` mirrors `host/types.ts`'s own `colorDepth: number` vocabulary
 * ("MVP carries the color depth only (4/8/24-bit)"). 24 (truecolor) is this
 * task's own MVP default: the design's palette tokens are full `#rrggbb` values
 * (§5.4) and OpenTUI targets truecolor terminals, but no spec section fixes a
 * default numeric value for this capability — flagged here rather than assumed.
 */
export const colorDepthAtom = atom<number>(24, "runtime.capability.colorDepth");
