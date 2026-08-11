import type { ThemeId, TokenMap } from "../types";
import { action, atom } from "./reatom";

/**
 * The one theme id the COMPILED SEED carries. Deliberately NOT {@link ThemeId}, which spec §4.6
 * widened to `string` because a project's theme names live in its own manifest: a
 * `Record<ThemeId, …>` would become an index signature and, under this repository's
 * `noUncheckedIndexedAccess: true`, make {@link themeTokens} return `TokenMap | undefined` —
 * breaking three call sites outside this module for no gain. The seed registry is a closed,
 * one-member thing and says so in its own type.
 */
export type SeedThemeId = "dark-default";

/**
 * The `dark-default` seed palette. These are the design system's REAL hues, taken 1:1 from
 * `design/termcraft-engine.js`'s `pal` object (a warm amber-on-near-black terminal theme) — not
 * a placeholder, and not invented here.
 *
 * WHAT IT IS NOW (spec §4.6, §9). It is no longer "the palette a page renders against": that is
 * the project's own `design/system/design-system.json`, delivered through
 * {@link themeTokensAtom}. Two jobs survive:
 *   1. the SEED the project-create scaffold and the mechanical migration copy into a new
 *      project's manifest (plan P4 imports it from this module by path);
 *   2. {@link themeTokensAtom}'s pre-mount default — see that atom's own note.
 */
export const DARK_DEFAULT: TokenMap = {
  background: "#14110d",
  surface: "#231d12",
  foreground: "#d7d0c2",
  foregroundMuted: "#8f877a",
  foregroundFaint: "#5b544a",
  border: "#403a2f",
  line: "#2c2820",
  accent: "#e6a23c",
  accentHi: "#f6c163",
  accentDim: "#8a6d33",
  selection: "#392c11",
  selectionFg: "#f6c163",
  success: "#8fb96b",
  warning: "#f6c163",
  danger: "#dd7b60",
  dangerDim: "#4d2a20",
  statusBg: "#231d12",
};

const THEMES: Record<SeedThemeId, TokenMap> = {
  "dark-default": DARK_DEFAULT,
};

/** Resolve the SEED theme id to its palette. Closed to {@link SeedThemeId} — see its note. */
export function themeTokens(id: SeedThemeId): TokenMap {
  return THEMES[id];
}

/** The seed theme's id — the scaffold's starting point, not a project's active theme. */
export const DEFAULT_THEME_ID: SeedThemeId = "dark-default";

/**
 * The active theme's id (spec §4.6). A HOST INPUT, exactly like `hostModeAtom` in
 * `./capabilities`: the host child writes it once per mount from `HostSessionSpec.theme` through
 * {@link seedThemeCapability}, and a page READS it (via `themeCapability()`) and must not write
 * it.
 */
export const themeIdAtom = atom<ThemeId>(DEFAULT_THEME_ID, "runtime.capability.themeId");

/**
 * The active theme's token map (spec §4.6) — the single source every colour default in the
 * component catalog resolves against. A HOST INPUT, written once per mount through
 * {@link seedThemeCapability}; the values come from the project's
 * `design/system/design-system.json`, which is inside `treeRoot` and covered by `expectedFiles`,
 * so no protocol change carries them.
 *
 * WHY THE DEFAULT IS THE COMPILED SEED AND NOT AN EMPTY MAP. Every catalog default reads a core
 * role off this atom, so an empty map would render a page with no colours at all — §4.1's own
 * argument ("a half-specified page reads as a broken render rather than an authored one"). The
 * mount seeds before the first render, so in a real child this default is never what a frame is
 * drawn from; it is what makes a runtime unit test and an un-seeded process coherent.
 */
export const themeTokensAtom = atom<TokenMap>(DARK_DEFAULT, "runtime.capability.themeTokens");

/**
 * THE SEAM the host wires (spec §4.6; plan P4). One named transition that moves BOTH theme
 * atoms together, so a mount can never leave the id and the values describing different themes.
 *
 * It is an action rather than two `atom.set` calls at the call site because this is a grouped
 * transition (Reatom RTM-S04), not an identity setter (RTM-S01) — it writes two atoms from one
 * input and names the transition for tracing.
 *
 * P4 calls it from the host child's mount handler
 * (`src/host/session/model/host-state-machine.ts`'s `handleMount`), BEFORE `handle.mount(...)`,
 * importing it as `runtime/model/tokens` — the same deep-import shape
 * `src/entrypoint/model/create-shell.ts` already uses for `runtime/generated/runtime-dts`. It is
 * deliberately NOT on the `@termcraft/runtime` facade: an authored page must not be able to
 * repaint its own theme.
 *
 * IT VALIDATES NOTHING. The manifest's `#rrggbb` form, its core-role completeness and its
 * cross-theme parity are the Gate's checks (§7, plan P2), asserted once against the manifest
 * before anything is mounted. A second, weaker check here would be a check that promises more
 * than it can see.
 */
export const seedThemeCapability = action(
  (input: { readonly themeId: ThemeId; readonly tokens: TokenMap }) => {
    themeIdAtom.set(input.themeId);
    themeTokensAtom.set(input.tokens);
  },
  "runtime.capability.seedTheme",
);

/**
 * A page's reactive read of the active theme's token map (spec §4.6).
 *
 * REACTIVE BECAUSE THE CALLER IS. A page is a `reatomComponent` (§4.3), so this call is a
 * TRACKED read of {@link themeTokensAtom} inside the component's render body: seeding a new
 * theme re-renders the page. §4.5 turns the corollary into a Gate warning — read at module
 * scope it captures one theme's values forever, which is exactly the shape a token scan can see.
 *
 * GENERIC so a project's own `design/system/tokens.ts` binds its manifest-derived `Tokens` type
 * with NO CAST AT THE CALL SITE (§4.3's scaffold: `useRuntimeTokens<Tokens>()`). The single
 * assertion that costs is here, once, and it is a last resort rather than a shortcut: the
 * runtime cannot know a project's token names, and the type that does know them is derived from
 * the project's own manifest through `resolveJsonModule` inside the Gate's one whole-tree
 * program. The Gate is what makes the assertion honest — a `Tokens` naming a token the manifest
 * does not declare is a fatal type error there, before any of this runs.
 */
export function useTokens<T = TokenMap>(): T {
  return themeTokensAtom() as T;
}

/**
 * The active theme's tokens for a CATALOG COMPONENT to resolve its own defaults against
 * (`Panel`'s `border`, `Text`'s `foreground`, `Gauge`'s `accent`, …).
 *
 * STAGE-1 REACTIVITY, STATED RATHER THAN ASSUMED (spec §4.2 — no theme switcher ships in stage
 * 1). The fourteen catalog components are plain function components, so this read is a
 * current-value read, not a tracked one: a mid-session theme change would not re-render them on
 * its own. That is correct by construction today, because {@link seedThemeCapability} runs
 * before the first render of a mount and nothing writes the atom again. THE TRIGGER TO REVISIT:
 * a shell-side theme switcher (§4.2's `runtime-api` §6 preview override). At that point the
 * catalog components — not this function — become `reatomComponent`s, which is the change that
 * makes their reads tracked.
 *
 * A PAGE's own read is already reactive and needs nothing here: a page is a `reatomComponent`
 * (§4.3), so its `useTokens()` call is a tracked read of the same atom.
 */
export function activeTokens(): TokenMap {
  return themeTokensAtom();
}
