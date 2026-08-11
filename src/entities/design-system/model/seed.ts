import { CORE_TOKEN_ROLES, DESIGN_SYSTEM_SCHEMA_VERSION } from "../types";
import type { DesignSystemManifestV1 } from "../types";

/**
 * The seed theme's id (design-systems §9). Identical to `runtime`'s `DEFAULT_THEME_ID`, pinned by
 * `seed.test.ts` rather than imported: `entities/` is what `store` may import, and `store` is where
 * both writers of this seed live (project create, and the mechanical migration). See plan P4's
 * decision D3 for the full argument, and `runtime/model/tokens.ts`'s own note, which points here.
 */
export const SEED_THEME_ID = "dark-default";

/** The seed theme's display label — the shell's picker shows it beside the swatches (§8.1). */
export const SEED_THEME_LABEL = "Dark";

/** The seed design system's identity (§3.3). A new project owns it outright; nothing addresses it remotely. */
export const SEED_DESIGN_SYSTEM_ID = "default";
export const SEED_DESIGN_SYSTEM_NAME = "Default";
export const SEED_DESIGN_SYSTEM_VERSION = "1.0.0";

/**
 * The seed palette (design-systems §9: "the same seventeen values, taken 1:1 from
 * `design/termcraft-engine.js`, nothing invented"). A warm amber-on-near-black terminal theme.
 *
 * COPIED, NOT IMPORTED — and the copy is exact by TEST, not by promise: `seed.test.ts` asserts
 * `expect(SEED_TOKENS).toEqual({ ...DARK_DEFAULT })`, so a divergence from `runtime/model/tokens.ts`
 * (and therefore from the design engine) is a failing test rather than a silent drift.
 */
export const SEED_TOKENS: Readonly<Record<string, string>> = {
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

/**
 * The manifest a brand-new (or freshly migrated) project starts with (§4.4, §9). It declares the
 * seventeen core roles and NOTHING beyond them: a project-specific token is something the project
 * adds, and inventing one here would put a name in front of the agent that means nothing yet.
 *
 * `components` is empty for the same reason `createProject` seeds `pages: []` — a scaffolded
 * component the user never asked for is a design decision this code is not entitled to make.
 *
 * `kitApiVersion` is the CALLER's, never a literal: the writers hold the binary's own
 * `CURRENT_KIT_API_VERSION` and a second reading of it here could disagree with the handshake.
 */
export function createSeedManifest(input: {
  readonly kitApiVersion: number;
}): DesignSystemManifestV1 {
  // Declared in CORE_TOKEN_ROLES order so the rendered JSON's key order is the roles' own
  // documented order, not an object-literal accident.
  const tokens: Record<string, string> = {};
  for (const role of CORE_TOKEN_ROLES) {
    const value = SEED_TOKENS[role];
    // Unreachable: `seed.test.ts` asserts SEED_TOKENS' key set IS CORE_TOKEN_ROLES. Kept explicit
    // rather than asserted away, per this repository's "never silently assume success" rule.
    if (value === undefined) continue;
    tokens[role] = value;
  }
  return {
    schemaVersion: DESIGN_SYSTEM_SCHEMA_VERSION,
    id: SEED_DESIGN_SYSTEM_ID,
    name: SEED_DESIGN_SYSTEM_NAME,
    version: SEED_DESIGN_SYSTEM_VERSION,
    kitApiVersion: input.kitApiVersion,
    defaultTheme: SEED_THEME_ID,
    themes: { [SEED_THEME_ID]: { label: SEED_THEME_LABEL, tokens } },
    components: [],
  };
}
