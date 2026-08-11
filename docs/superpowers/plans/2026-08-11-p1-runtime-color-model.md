# P1 — Runtime colour model (Track A, Wave 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Load `/reatom` and `/errore` before any code-related
> action (CLAUDE.md mandate). Every task ends green — `bun x tsc --noEmit` silent and the named
> suites passing — and is one commit.

**Goal:** Replace the runtime's compiled-palette colour model with the project-owned one
`docs/superpowers/specs/2026-08-11-project-design-systems-design.md` §4 specifies: a `Color`
(`#rrggbb`) prop type in place of `keyof ThemeTokens`, a reactive `useTokens<T>()` backed by a
host-input atom, a `ThemeId` widened to `string`, an optional `PageMeta.theme`, and a
`themeCapability()` that returns real values instead of the compiled `dark-default`.

**Architecture:** Two host-input atoms in `src/runtime/model/tokens.ts` (`themeIdAtom`,
`themeTokensAtom`) become the single source of the active theme. They carry the compiled
`DARK_DEFAULT` seed as their pre-mount default and are written exactly once per mount through one
named seam action, `seedThemeCapability` — the seam P4 wires from the host child. `useTokens<T>()`
and the internal `activeTokens()` are plain reads of `themeTokensAtom`, so a page component
(always a `reatomComponent`, spec §4.3) tracks them and re-renders when the theme changes. Every
facade component's colour prop becomes a `Color` value; the fourteen components keep their
defaults by reading the core roles off `activeTokens()`.

**Tech Stack:** Bun 1.3, TypeScript 7 (`bun x tsc --noEmit`), Reatom v1001 (`@reatom/core@1001`,
`@reatom/react@1001`), `@opentui/react@0.4.5`, `bun:test`, errore 0.14.1, oxlint/oxfmt.

## Global Constraints

- **Scope fence.** Only `src/runtime/**`, `src/runtime/generated/**`, the two Gate *test* files
  whose fixture pages carry a colour prop, and `docs/architecture/modules{,.ru}.md`. **No** Gate
  production code, **no** manifest entity, **no** host wiring, **no** scaffold, **no** migration —
  those are P2 and P4. `examples/**` is never edited (spec §9).
- **Design is a source of truth.** Every hex value in this plan is the existing seed palette,
  taken 1:1 from `src/runtime/model/tokens.ts`, which took it 1:1 from `design/termcraft-engine.js`'s
  `pal`. No colour is invented, approximated, or renamed anywhere in this plan.
- **Module layout (CLAUDE.md).** `src/runtime/types.ts` holds the module's shared types;
  `src/runtime/index.ts` is the public entry point; `model/` and `ui/` hold implementation. Colour
  types live in `types.ts`, never in a `ui/` file.
- **Imports.** Relative inside `src/runtime` (`../types`, `./reatom`); alias (`host/...`,
  `runtime/...`) across module boundaries. `verbatimModuleSyntax: true` — every type-only import
  is `import type`.
- **errore.** No `throw` for expected failures; nothing in this plan performs I/O, so no new
  error type is introduced. The single `as` assertion this plan adds (`useTokens`) is documented
  in place as a last resort.
- **Reatom.** Every atom, computed and action is NAMED. Host-input atoms follow the existing
  `runtime.capability.*` naming of `hostModeAtom`/`viewportSizeAtom`. `atom.set` is used directly
  (RTM-S01); the one action this plan adds groups TWO atom writes into one named transition
  (RTM-S04) and is therefore not an identity setter.
- **Declaration regeneration.** Any change to `src/runtime`'s public surface invalidates
  `src/runtime/generated/runtime-dts.ts` and `runtime.generated.d.ts`, and
  `src/runtime/generated/runtime-dts.test.ts` fails on the drift. Every task below that touches
  the surface regenerates with `bun run gen:runtime-dts` **before** it runs its tests.
- **Test-command split.** `src/ui` and `src/entrypoint` render tests must run as SEPARATE
  `bun test` commands — a combined run produces random failures under load (spec §11). This plan
  touches neither, but the final verification honours the split.
- **Commits.** One commit per task, conventional-commit subject. Use `rtk git …`. If a message is
  multi-line, write it to a scratch file and pass `-F <path>` (`rtk git commit` swallows heredoc
  stdin).

---

## Decisions made here, with their reasons

These are the choices the spec leaves to the implementation. They are settled here so no task has
to re-litigate them.

**D1 — `Color` is `` `#${string}` ``, not `string`.** A `string` alias would leave
`color="foregroundMuted"` compiling, and spec §9 depends on exactly the opposite: after this
change every existing page must fail the Gate with a `TS2322` that §7's warning can attach a
rewrite to. TypeScript cannot express "exactly six lowercase hex digits", so the type checks the
`#` prefix only; the full `#rrggbb` form is enforced where the values enter the system — the
manifest's Gate schema (§7, plan P2). That divergence is recorded in the type's own doc comment,
never silently substituted.

**D2 — `TokenMap` is an interface extending `ThemeTokens` with a string index signature.** The
core seventeen roles stay mandatory (§4.1) and named, so `tokens.accent` is a checked property
read unaffected by `noUncheckedIndexedAccess`; the index signature is what lets a project-declared
name exist at all. A page never indexes it by a computed string — it reads its own project-derived
`Tokens` type (§4.3).

**D3 — the atoms' default is the compiled seed, and that is not "the palette source".** `DARK_DEFAULT`
becomes `themeTokensAtom`'s initial value. A page rendered before the host seeds (a runtime unit
test; a child whose mount has not run) must still produce a coherent frame — §4.1's own argument
against optional defaults ("a half-specified page reads as a broken render rather than an authored
one"). The mount overwrites it before the first render; §4.6's "stop being the palette source"
holds, because nothing consults `themeTokens(id)` at render time any more.

**D4 — the seeding seam is one named action, `seedThemeCapability`, exported from
`runtime/model/tokens` and NOT from the facade.** P4 calls it from the host child
(`src/host/session/model/host-state-machine.ts`'s `handleMount`, before `handle.mount(...)`),
importing `runtime/model/tokens` — the same deep-import shape `src/entrypoint/model/create-shell.ts`
already uses for `runtime/generated/runtime-dts`. Keeping it off `src/runtime/index.ts` is what
stops an authored page from reaching it: the page's `@termcraft/runtime` is the facade namespace
object (`src/host/session/model/resolver.ts`), and the ambient declaration's export list does not
name it. It performs no validation — the manifest's hex/parity rules are the Gate's (§7, P2), and
a second, weaker check in the runtime would be a lint that promises more than it can see.

**D5 — `themeTokens(id)` and `DEFAULT_THEME_ID` survive, narrowed to the SEED.** Three files
outside this plan's scope import them (`src/host/adapters/smoke-renderer.ts`,
`src/host/protocol/model/embedded-declaration.ts`,
`src/agent/prompt/model/runtime-authoring-guide.test.ts`). `ThemeId` widening to `string` would
turn `Record<ThemeId, TokenMap>` into an index signature and, under
`noUncheckedIndexedAccess: true`, make `themeTokens` return `TokenMap | undefined` — breaking all
three. They are therefore decoupled from `ThemeId` onto a new `SeedThemeId = "dark-default"`
literal, which keeps every existing call site compiling byte-for-byte while `ThemeId` widens
independently. `DARK_DEFAULT` is exported for P4's scaffold, as the task brief requires.

**D6 — the fourteen components read the atom non-reactively, and that is deliberate for stage 1.**
They are plain function components, not `reatomComponent`s, so an atom read inside them is a
current-value read rather than a tracked one. Stage 1 ships no theme switcher (§4.2), and the
mount seeds before the first render (D4), so the value is correct by construction. Wrapping
fourteen components in `reatomComponent` to buy reactivity nothing exercises would change their
render identity and their `key` handling for no behaviour. This is recorded in `activeTokens`'
own doc comment as a stage-1 decision with its trigger (a shell-side theme switcher), not left to
be rediscovered.

**D7 — the Gate's fixture pages are rewritten here, and no Gate production code is touched.**
`src/gate/model/type-check.test.ts` and `src/gate/adapters/gate-runner.test.ts` compile fixture
pages against the REAL generated declaration and assert them clean. Five of those fixtures carry
`color="accent"`, which stops type-checking the moment `TextProps.color` becomes `Color`. Their
rewrite is collateral of this plan's type change, exactly like `src/runtime`'s own tests, and it
lands in the same task so the repository is never red between tasks.

## File structure

| File | Change | Responsibility after this plan |
| --- | --- | --- |
| `src/runtime/types.ts` | modify | `Color`, `TokenMap`, widened `ThemeId`, `ThemeTokens` retyped to `Color`, optional `PageMeta.theme` |
| `src/runtime/types.test.ts` | **create** | Compile-time assertions on the four type changes (`@ts-expect-error` pairs) |
| `src/runtime/model/tokens.ts` | modify | The seed (`DARK_DEFAULT`, `SeedThemeId`, `themeTokens`, `DEFAULT_THEME_ID`), the two host-input atoms, `seedThemeCapability`, `useTokens`, `activeTokens` |
| `src/runtime/model/tokens.test.ts` | modify | Seed integrity + atom/seam/`useTokens` behaviour |
| `src/runtime/model/tokens.reactivity.test.tsx` | **create** | `useTokens` re-renders a `reatomComponent` through the headless harness |
| `src/runtime/model/capabilities.ts` | modify | `themeCapability()` reads the atoms; `ThemeCapability.tokens` is `TokenMap` |
| `src/runtime/model/capabilities.test.ts` | modify | The capability follows a seed |
| `src/runtime/ui/primitive.tsx`, `panel.tsx`, `separator.tsx` | modify | Colour props typed `Color`; defaults from `activeTokens()` |
| `src/runtime/ui/text.tsx`, `sparkline.tsx` | modify | Colour props typed `Color`; defaults from `activeTokens()` |
| `src/runtime/ui/button.tsx`, `tabs.tsx`, `list.tsx`, `table.tsx`, `gauge.tsx` | modify | Internal `<Text color=…>` call sites pass resolved hues |
| `src/runtime/ui/primitive.test.tsx`, `separator.test.tsx`, `text.test.tsx` | modify | Pass hues instead of token names |
| `src/runtime/index.ts` | modify | Adds `Color`, `TokenMap`, `useTokens` to the facade |
| `src/runtime/index.test.ts` | modify | Facade contract covers `useTokens` |
| `src/runtime/generated/runtime-dts.ts`, `runtime.generated.d.ts` | regenerate | Never hand-edited |
| `src/gate/model/type-check.test.ts`, `src/gate/adapters/gate-runner.test.ts` | modify (fixtures only) | Fixture pages use hues; one new negative fixture |
| `docs/architecture/modules.md`, `modules.ru.md` | modify | The runtime rows describe the project-owned colour model |

**The fourteen components, accounted for**, so none is assumed missed: five expose a colour PROP
that changes type (`Box`, `Panel`, `Separator`, `Text`, `Sparkline` — Tasks 5 and 6); five pass a
token NAME internally to `Text` and change their call sites only (`Button`, `Tabs`, `List`,
`Table`, `Gauge` — Task 6); one already resolves real hues and needs nothing (`Input`); and three
carry no colour at all (`Row`, `Column`, `Spacer`).

---

### Task 1: The colour types

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/index.ts:9` (the type re-export line)
- Test: `src/runtime/types.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `type Color = \`#${string}\``; `interface TokenMap extends ThemeTokens { readonly [token: string]: Color }`; `type ThemeId = string`; `ThemeTokens`'s seventeen fields retyped from `string` to `Color`; `PageMeta.theme?: ThemeId`. All exported from `src/runtime/types.ts` and re-exported from `src/runtime/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/runtime/types.test.ts`. These are compile-time assertions — `bun x tsc --noEmit` is
what checks them, and the runtime `expect`s exist so the file is a real test that runs.

```ts
import { describe, expect, test } from "bun:test";

import { definePage } from "./model/define-page";
import type { Color, PageMeta, ThemeId, ThemeTokens, TokenMap } from "./types";

describe("the runtime colour model (spec §4.5, §4.6)", () => {
  test("Color accepts a #rrggbb literal and rejects a token name", () => {
    const hue: Color = "#e6a23c";
    // @ts-expect-error — a token NAME is no longer a colour (§4.5). This is the TS2322 the
    // migration diagnostic attaches its rewrite to (§7, §9); if it ever stops firing, every
    // existing page silently keeps compiling against a type that no longer means anything.
    const name: Color = "accent";
    expect(hue).toBe("#e6a23c");
    expect(name).toBe("accent");
  });

  test("TokenMap carries the mandatory core roles as named, checked properties", () => {
    const tokens: TokenMap = {
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
      // A project-declared token beyond the core (§4.1) — the whole point of the index signature.
      brandBlue: "#4cc9f0",
    };
    // A named core role is a property, not an index access: `noUncheckedIndexedAccess` never
    // widens it to `| undefined`.
    const accent: Color = tokens.accent;
    expect(accent).toBe("#e6a23c");
    expect(tokens.brandBlue).toBe("#4cc9f0");

    // Every TokenMap is a ThemeTokens — the core contract the component defaults bind to.
    const core: ThemeTokens = tokens;
    expect(core.danger).toBe("#dd7b60");
  });

  test("ThemeId is an open string — the project's manifest owns the names now", () => {
    const id: ThemeId = "midnight";
    expect(id).toBe("midnight");
  });

  test("PageMeta.theme is optional; absent means the manifest's defaultTheme", () => {
    const withoutTheme: PageMeta = definePage({
      kitApiVersion: 1,
      title: "Dashboard",
      minSize: { w: 80, h: 24 },
    });
    expect(withoutTheme.theme).toBeUndefined();

    const pinned: PageMeta = definePage({
      kitApiVersion: 1,
      title: "Dashboard",
      minSize: { w: 80, h: 24 },
      theme: "midnight",
    });
    expect(pinned.theme).toBe("midnight");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun x tsc --noEmit`
Expected: FAIL — `Cannot find name 'Color'` / `'TokenMap'` (they do not exist yet), and the
`@ts-expect-error` on `const name: Color = "accent"` reports "Unused '@ts-expect-error' directive"
only after `Color` exists, so the first failure is the missing types.

- [ ] **Step 3: Add `Color` and `TokenMap`, widen `ThemeId`, retype `ThemeTokens`**

In `src/runtime/types.ts`, REPLACE the `ThemeId` declaration (lines 1-5) with:

```ts
/**
 * A theme id declared by the project's own design system (spec §4.6). It was a closed
 * one-member union while a single `dark-default` palette was compiled into this binary; the
 * truth now lives in the project's `design/system/design-system.json`, and the GATE — not this
 * type — validates a concrete id against that manifest. Widening it here rather than enumerating
 * project names is the whole point: a closed union in the binary would make every project's
 * theme names part of the binary's identity.
 */
export type ThemeId = string;

/**
 * A concrete terminal colour: a lowercase `#rrggbb` string (spec §4.5).
 *
 * TEMPLATE-LITERAL RATHER THAN `string`, ON PURPOSE. A `string` alias would leave
 * `color="foregroundMuted"` compiling, and §4.5 replaces two ways of naming a colour with one:
 * the checked `t.accent` path. §9's migration depends on the old spelling being a fatal
 * `TS2322` that the Gate's warning can attach an exact rewrite to.
 *
 * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED: TypeScript cannot express "exactly six
 * lowercase hex digits", so this type checks the `#` prefix and nothing else. The full
 * `#rrggbb` form is enforced where the values ENTER the system — the design-system manifest's
 * Gate schema (§7) — not at every prop site.
 */
export type Color = `#${string}`;
```

Then retype every field of `ThemeTokens` from `readonly …: string` to `readonly …: Color`,
leaving each field's doc comment exactly as it is, and update the interface header's last
sentence from "Every value is a lowercase `#rrggbb` string." to:

```
 * Every value is a {@link Color}. The NAMES are the mandatory core roles every project theme
 * must declare (spec §4.1) — the component catalog's defaults bind to them; the VALUES are the
 * project's, delivered through {@link TokenMap} at mount.
```

Immediately after `ThemeTokens`, add:

```ts
/**
 * The active theme's whole token map (spec §4.1): the mandatory core roles above, plus any
 * number of token names the project declared. The index signature is what makes a
 * project-declared name expressible at all.
 *
 * A page never indexes this type by a computed string — it reads a named field off its own
 * manifest-derived `Tokens` type (§4.3), where every key is known, so
 * `noUncheckedIndexedAccess` never widens a read to `| undefined`. The seventeen core roles
 * stay declared PROPERTIES here for the same reason: the catalog's own defaults
 * (`activeTokens().border`, `.foreground`, …) must be checked reads, not index accesses.
 */
export interface TokenMap extends ThemeTokens {
  readonly [token: string]: Color;
}
```

Finally, in `PageMeta`, replace the `theme` field with:

```ts
  /**
   * The declared theme this page pins to (spec §4.6). OPTIONAL: absent means the project
   * manifest's `defaultTheme`, which is the ordinary case; present, it pins the page to one
   * declared theme. The Gate checks the name against the project's manifest.
   *
   * KNOWN GAP until plan P4 lands: the host child's own `pageMetaSchema`
   * (`src/host/session/model/source-mount.ts`) still REQUIRES `theme`, so a page that omits it
   * type-checks here and is refused at mount with `MALFORMED_PROTOCOL`. P4 relaxes that schema
   * as part of the host wiring; nothing in the repository omits `theme` today.
   */
  readonly theme?: ThemeId;
```

- [ ] **Step 4: Re-export the new types from the facade**

`src/runtime/index.ts:9` — replace with:

```ts
export type { Color, PageMeta, Size, ThemeId, ThemeTokens, TokenMap } from "./types";
```

- [ ] **Step 5: Regenerate the ambient declaration**

Run: `bun run gen:runtime-dts`
Expected: writes both artifacts; stderr carries the usual `@standard-schema/spec` note.

- [ ] **Step 6: Run the tests**

Run: `bun test src/runtime/ && bun x tsc --noEmit`
Expected: PASS, `tsc` silent. (`src/gate` fixtures still use `color="accent"` against
`keyof ThemeTokens`, which is unchanged by this task — they stay green.)

- [ ] **Step 7: Commit**

```bash
rtk git add src/runtime/types.ts src/runtime/types.test.ts src/runtime/index.ts src/runtime/generated
rtk git commit -m "feat(runtime): add the Color/TokenMap colour types and open ThemeId"
```

---

### Task 2: The theme host-input atoms and the seeding seam

**Files:**
- Modify: `src/runtime/model/tokens.ts`
- Test: `src/runtime/model/tokens.test.ts`

**Interfaces:**
- Consumes: `Color`, `ThemeId`, `TokenMap` from Task 1; `atom`, `action` from `./reatom`.
- Produces, all from `src/runtime/model/tokens.ts`:
  - `type SeedThemeId = "dark-default"`
  - `const DARK_DEFAULT: TokenMap` (**newly exported**)
  - `function themeTokens(id: SeedThemeId): TokenMap`
  - `const DEFAULT_THEME_ID: SeedThemeId`
  - `const themeIdAtom: Atom<ThemeId>`, name `"runtime.capability.themeId"`
  - `const themeTokensAtom: Atom<TokenMap>`, name `"runtime.capability.themeTokens"`
  - `const seedThemeCapability` — action over `{ readonly themeId: ThemeId; readonly tokens: TokenMap }`, name `"runtime.capability.seedTheme"`
  - `function activeTokens(): TokenMap`

- [ ] **Step 1: Write the failing tests**

REPLACE the body of `src/runtime/model/tokens.test.ts` with:

```ts
import { afterEach, describe, expect, test } from "bun:test";

import type { ThemeTokens, TokenMap } from "../types";
import {
  activeTokens,
  DARK_DEFAULT,
  DEFAULT_THEME_ID,
  seedThemeCapability,
  themeIdAtom,
  themeTokens,
  themeTokensAtom,
} from "./tokens";

const HEX = /^#[0-9a-f]{6}$/;

/** The seventeen mandatory core roles (spec §4.1). */
const CORE_ROLES: (keyof ThemeTokens)[] = [
  "background",
  "surface",
  "foreground",
  "foregroundMuted",
  "foregroundFaint",
  "border",
  "line",
  "accent",
  "accentHi",
  "accentDim",
  "selection",
  "selectionFg",
  "success",
  "warning",
  "danger",
  "dangerDim",
  "statusBg",
];

/** A project-shaped theme: the core roles plus a name the binary has never heard of. */
const MIDNIGHT: TokenMap = {
  ...DARK_DEFAULT,
  background: "#0b0f14",
  accent: "#4cc9f0",
  brandBlue: "#4cc9f0",
};

// The atoms are HOST INPUTS with process-wide lifetime; restore the seed after every test so
// ordering never leaks a theme from one case into the next.
afterEach(() => {
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});

describe("the compiled seed (spec §4.6 — the scaffold's seed, no longer the palette source)", () => {
  test("DARK_DEFAULT carries every core role as a lowercase #rrggbb value", () => {
    for (const role of CORE_ROLES) expect(DARK_DEFAULT[role]).toMatch(HEX);
  });

  test("the seed accessor resolves the one compiled theme", () => {
    expect(DEFAULT_THEME_ID).toBe("dark-default");
    expect(themeTokens("dark-default")).toBe(DARK_DEFAULT);
    expect(themeTokens(DEFAULT_THEME_ID)).toBe(DARK_DEFAULT);
  });
});

describe("the theme host-input atoms (spec §4.6)", () => {
  test("they default to the seed, so a page renders coherently before the mount seeds", () => {
    expect(themeIdAtom()).toBe(DEFAULT_THEME_ID);
    expect(themeTokensAtom()).toBe(DARK_DEFAULT);
    expect(activeTokens()).toBe(DARK_DEFAULT);
  });

  test("seedThemeCapability moves both atoms in one named transition", () => {
    seedThemeCapability({ themeId: "midnight", tokens: MIDNIGHT });
    expect(themeIdAtom()).toBe("midnight");
    expect(themeTokensAtom()).toBe(MIDNIGHT);
    expect(activeTokens().accent).toBe("#4cc9f0");
  });

  test("a project-declared token beyond the core is readable after a seed", () => {
    seedThemeCapability({ themeId: "midnight", tokens: MIDNIGHT });
    expect(activeTokens().brandBlue).toBe("#4cc9f0");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/runtime/model/tokens.test.ts`
Expected: FAIL — `DARK_DEFAULT`, `seedThemeCapability`, `themeIdAtom`, `themeTokensAtom` are not
exported from `./tokens`.

- [ ] **Step 3: Rewrite `src/runtime/model/tokens.ts`**

Replace the whole file with:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/runtime/model/tokens.test.ts && bun x tsc --noEmit`
Expected: PASS, `tsc` silent. (`src/runtime/ui/*` still call `activeTokens()` and index it by a
token name — `tokens[props.color ?? "foreground"]` — which still compiles, because `TokenMap`
carries the core roles as named properties AND an index signature.)

- [ ] **Step 5: Regenerate and run the runtime suite**

Run: `bun run gen:runtime-dts && bun test src/runtime/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add src/runtime/model/tokens.ts src/runtime/model/tokens.test.ts src/runtime/generated
rtk git commit -m "feat(runtime): back the active theme with host-input atoms and one seeding seam"
```

---

### Task 3: `useTokens<T>()`

**Files:**
- Modify: `src/runtime/model/tokens.ts` (append)
- Modify: `src/runtime/index.ts` (the `./model/tokens` export line)
- Modify: `src/runtime/index.test.ts`
- Test: `src/runtime/model/tokens.reactivity.test.tsx` (create)

**Interfaces:**
- Consumes: `themeTokensAtom`, `seedThemeCapability`, `DARK_DEFAULT`, `DEFAULT_THEME_ID` (Task 2); `TokenMap` (Task 1).
- Produces: `function useTokens<T = TokenMap>(): T`, exported from `src/runtime/model/tokens.ts` and from `src/runtime/index.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/runtime/model/tokens.reactivity.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import type { Color, TokenMap } from "../types";
import { computed, reatomComponent } from "./reatom";
import { DARK_DEFAULT, DEFAULT_THEME_ID, seedThemeCapability, useTokens } from "./tokens";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const lineText = (frame: { rows: { text: string }[][] }, row: number) =>
  (frame.rows[row] ?? []).map((run) => run.text).join("");

/** A project-declared theme: the core roles, one overridden hue, one name the binary never had. */
const MIDNIGHT: TokenMap = { ...DARK_DEFAULT, accent: "#4cc9f0", brandBlue: "#4cc9f0" };

/** The shape a project's own `design/system/tokens.ts` binds (spec §4.3). */
interface ProjectTokens extends TokenMap {
  readonly brandBlue: Color;
}

describe("useTokens (spec §4.6)", () => {
  test("returns the active theme's map, and its generic binds a project's own shape", () => {
    expect(useTokens()).toBe(DARK_DEFAULT);
    seedThemeCapability({ themeId: "midnight", tokens: MIDNIGHT });
    // No cast at the CALL site — that is what the generic buys (§4.6).
    const t = useTokens<ProjectTokens>();
    expect(t.brandBlue).toBe("#4cc9f0");
    expect(t.accent).toBe("#4cc9f0");
  });

  test("the read is TRACKED, not a snapshot — a computed over it recomputes after a seed", () => {
    const probe = computed(() => useTokens().accent, "test.useTokens.accent");
    expect(probe()).toBe("#e6a23c");
    seedThemeCapability({ themeId: "midnight", tokens: MIDNIGHT });
    expect(probe()).toBe("#4cc9f0");
  });

  test("a page component re-renders when the theme is seeded (the §4.6 reactive read)", async () => {
    const Page = reatomComponent(() => <text>{`accent=${useTokens().accent}`}</text>, "test.Page");
    const handle = await createHeadlessRenderer({ w: 24, h: 1 });
    open = handle;
    handle.mount(<Page />);
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("accent=#e6a23c");

    seedThemeCapability({ themeId: "midnight", tokens: MIDNIGHT });
    await tick();
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("accent=#4cc9f0");
  });
});
```

In `src/runtime/index.test.ts`, add `"useTokens"` to the first `as const` name list (the one
asserting `typeof runtime[name] === "function"`), between `"themeTokens"` and `"defineTweaks"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/runtime/model/tokens.reactivity.test.tsx`
Expected: FAIL — `useTokens` is not exported from `./tokens`.

- [ ] **Step 3: Add `useTokens`**

Append to `src/runtime/model/tokens.ts`, immediately before `activeTokens`:

```ts
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
```

- [ ] **Step 4: Export it from the facade**

In `src/runtime/index.ts`, replace the tokens export line (currently
`export { themeTokens, DEFAULT_THEME_ID } from "./model/tokens";`) with:

```ts
// Theme tokens (§4.6). `useTokens()` is the page-facing reactive read of the ACTIVE theme's map;
// `themeTokens`/`DEFAULT_THEME_ID` are the compiled SEED the project-create scaffold copies —
// they are not what a page renders against any more. `seedThemeCapability`, `themeIdAtom` and
// `themeTokensAtom` stay OFF this facade on purpose: an authored page must not repaint its own
// theme (see their notes in ./model/tokens).
export { DEFAULT_THEME_ID, themeTokens, useTokens } from "./model/tokens";
```

- [ ] **Step 5: Regenerate and run the tests**

Run: `bun run gen:runtime-dts && bun test src/runtime/ && bun x tsc --noEmit`
Expected: PASS, `tsc` silent.

- [ ] **Step 6: Commit**

```bash
rtk git add src/runtime/model/tokens.ts src/runtime/model/tokens.reactivity.test.tsx src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated
rtk git commit -m "feat(runtime): add useTokens, the reactive read of the active theme's tokens"
```

---

### Task 4: `themeCapability()` returns real values

**Files:**
- Modify: `src/runtime/model/capabilities.ts:1-3`, `:40-53`
- Test: `src/runtime/model/capabilities.test.ts`

**Interfaces:**
- Consumes: `themeIdAtom`, `themeTokensAtom`, `seedThemeCapability`, `DARK_DEFAULT`, `DEFAULT_THEME_ID` (Task 2); `TokenMap` (Task 1).
- Produces: `interface ThemeCapability { readonly themeId: ThemeId; readonly tokens: TokenMap }` and `function themeCapability(): ThemeCapability` reading the atoms.

- [ ] **Step 1: Write the failing test**

In `src/runtime/model/capabilities.test.ts`, replace the import of `themeTokens` with

```ts
import { DARK_DEFAULT, DEFAULT_THEME_ID, seedThemeCapability } from "./tokens";
```

and replace the `themeCapability` test with:

```ts
  test("themeCapability resolves the ACTIVE theme id + tokens, not a compiled default", () => {
    const seeded = themeCapability();
    expect(seeded.themeId).toBe(DEFAULT_THEME_ID);
    expect(seeded.tokens).toBe(DARK_DEFAULT);

    seedThemeCapability({
      themeId: "midnight",
      tokens: { ...DARK_DEFAULT, accent: "#4cc9f0", brandBlue: "#4cc9f0" },
    });
    const active = themeCapability();
    expect(active.themeId).toBe("midnight");
    expect(active.tokens.accent).toBe("#4cc9f0");
    expect(active.tokens.brandBlue).toBe("#4cc9f0");
  });
```

Extend the file's existing `afterEach` so both host inputs are restored:

```ts
afterEach(() => {
  hostModeAtom.set("preview");
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/runtime/model/capabilities.test.ts`
Expected: FAIL — `themeCapability()` still returns the compiled `themeTokens(DEFAULT_THEME_ID)`,
so `active.themeId` is `"dark-default"` after the seed.

- [ ] **Step 3: Read the atoms**

`src/runtime/model/capabilities.ts` — replace line 1 and line 3 with:

```ts
import type { Size, ThemeId, TokenMap } from "../types";
```
```ts
import { themeIdAtom, themeTokensAtom } from "./tokens";
```

and replace the `ThemeCapability` interface + `themeCapability` function with:

```ts
/** The theme capability (§6): the active theme id and its resolved token map. */
export interface ThemeCapability {
  readonly themeId: ThemeId;
  readonly tokens: TokenMap;
}

/**
 * Resolve the current theme capability (§6, spec §4.6). It reads the two HOST-INPUT atoms the
 * mount seeds (`./tokens`'s `themeIdAtom`/`themeTokensAtom`), so it returns the PROJECT's real
 * theme — the compiled `dark-default` it used to return survives only as those atoms' pre-mount
 * default. Called from a `reatomComponent`, both reads are tracked, so a preview theme override
 * re-renders the page without rewriting `meta.theme` (`runtime-api` §6).
 */
export function themeCapability(): ThemeCapability {
  return { themeId: themeIdAtom(), tokens: themeTokensAtom() };
}
```

- [ ] **Step 4: Regenerate and run the tests**

Run: `bun run gen:runtime-dts && bun test src/runtime/ && bun x tsc --noEmit`
Expected: PASS, `tsc` silent.

- [ ] **Step 5: Commit**

```bash
rtk git add src/runtime/model/capabilities.ts src/runtime/model/capabilities.test.ts src/runtime/generated
rtk git commit -m "feat(runtime): resolve themeCapability from the active theme atoms"
```

---

### Task 5: `Box`, `Panel` and `Separator` take `Color`

**Files:**
- Modify: `src/runtime/ui/primitive.tsx`, `src/runtime/ui/panel.tsx`, `src/runtime/ui/separator.tsx`
- Test: `src/runtime/ui/primitive.test.tsx`, `src/runtime/ui/separator.test.tsx`

These three are done first because nothing else in the catalog passes a colour to them — the
change is self-contained and the repository stays green. `Panel`'s test passes no colour prop and
needs no edit.

**Interfaces:**
- Consumes: `Color` (Task 1), `activeTokens()` (Task 2).
- Produces: `BoxProps.borderColor?: Color`, `BoxProps.background?: Color`,
  `PanelProps.borderColor?: Color`, `PanelProps.titleColor?: Color`, `SeparatorProps.color?: Color`.

- [ ] **Step 1: Write the failing tests**

`src/runtime/ui/primitive.test.tsx` — replace the `themeTokens` import with

```ts
import { activeTokens } from "../model/tokens";
```

and the two mounts (lines 25 and 41) with hues read off the active theme:

```tsx
      <Box id="panel" background={activeTokens().surface} padding={0}>
```
```tsx
      <Box id="bordered" border borderColor={activeTokens().accent}>
```

Replace the two assertions that referenced `themeTokens("dark-default")` with
`activeTokens().surface` and `activeTokens().accent` respectively.

`src/runtime/ui/separator.test.tsx` — replace the `themeTokens` import with `activeTokens` the
same way, change line 48 to

```tsx
        <Separator id="rule" color={activeTokens().success} />
```

and replace the two `themeTokens("dark-default").line` assertions with `activeTokens().line`.

Add one new test to `src/runtime/ui/primitive.test.tsx`:

```tsx
  test("a token NAME is no longer a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().surface`.
    const rejected = <Box id="rejected" background="surface" />;
    expect(rejected).toBeDefined();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/runtime/ui/primitive.test.tsx && bun x tsc --noEmit`
Expected: FAIL — `tsc` reports `TS2322` for `background={activeTokens().surface}` (the prop is
still `keyof ThemeTokens`) and "Unused '@ts-expect-error' directive" on the new test.

- [ ] **Step 3: Retype `Box`**

`src/runtime/ui/primitive.tsx` — delete the `activeTokens` import and the
`import type { ThemeTokens }`, and add `import type { Color } from "../types";`. Replace the two
prop declarations:

```ts
  /** The border hue (only meaningful with `border`). Read one off `useTokens()` (spec §4.5). */
  readonly borderColor?: Color;
  /** The fill hue. Read one off `useTokens()` (spec §4.5). */
  readonly background?: Color;
```

Update the component's doc comment sentence "Colors are semantic theme-token names, never raw
hues" to "Colors are `Color` values — a page reads them off its own `useTokens()` (spec §4.5)",
delete `const tokens = activeTokens();` from the body, and pass the props straight through:

```tsx
      borderColor={props.borderColor}
      backgroundColor={props.background}
```

- [ ] **Step 4: Retype `Panel`**

`src/runtime/ui/panel.tsx` — replace `import type { ThemeTokens } from "../types";` with
`import type { Color } from "../types";`, retype both props to `Color`, keeping the design
variants in the prose but restating them as token reads:

```ts
  /** The border hue; defaults to the theme's `border`. Design variants: `t.accent` (active/popup), `t.accentHi` (hover), `t.danger` (error), `t.line` (dimmed). */
  readonly borderColor?: Color;
  /** The title hue; defaults to the theme's `foreground`. Design variants: `t.accentHi` (popup/active), `t.foregroundMuted` (welded sub-panel). */
  readonly titleColor?: Color;
```

Keep `const tokens = activeTokens();` and change the two JSX attributes to:

```tsx
      borderColor={props.borderColor ?? tokens.border}
```
```tsx
      titleColor={props.titleColor ?? tokens.foreground}
```

- [ ] **Step 5: Retype `Separator`**

`src/runtime/ui/separator.tsx` — replace `import type { ThemeTokens } from "../types";` with
`import type { Color } from "../types";`, retype the prop:

```ts
  /** The rule's hue; defaults to the theme's `line` (the design's subtle-divider hue). */
  readonly color?: Color;
```

and replace the fill resolution:

```ts
  const fill = props.color ?? activeTokens().line;
```

(`const tokens = activeTokens();` is then unused — delete it.)

- [ ] **Step 6: Regenerate and run the tests**

Run: `bun run gen:runtime-dts && bun test src/runtime/ && bun x tsc --noEmit`
Expected: PASS, `tsc` silent.

- [ ] **Step 7: Commit**

```bash
rtk git add src/runtime/ui/primitive.tsx src/runtime/ui/panel.tsx src/runtime/ui/separator.tsx src/runtime/ui/primitive.test.tsx src/runtime/ui/separator.test.tsx src/runtime/generated
rtk git commit -m "refactor(runtime): type Box/Panel/Separator colour props as Color"
```

---

### Task 6: `Text` and `Sparkline` take `Color`, and every internal call site resolves a hue

**Files:**
- Modify: `src/runtime/ui/text.tsx`, `sparkline.tsx`, `button.tsx`, `tabs.tsx`, `list.tsx`, `table.tsx`, `gauge.tsx`
- Test: `src/runtime/ui/text.test.tsx`
- Test (fixtures only, no production Gate code): `src/gate/model/type-check.test.ts`, `src/gate/adapters/gate-runner.test.ts`

This is the plan's one wide task, and it is wide because it is ATOMIC: the moment `TextProps.color`
becomes `Color`, six catalog components and six Gate fixture pages stop compiling. Splitting it
would leave the repository red between tasks.

**Interfaces:**
- Consumes: `Color` (Task 1), `activeTokens()` (Task 2).
- Produces: `TextProps.color?: Color`, `SparklineProps.color?: Color`. No other public signature changes.

**Two things that need NO edit, so they are not hunted for.** `src/runtime/ui/input.tsx` already
resolves real hues off `activeTokens()` (`textColor`, `placeholderColor`, `backgroundColor`) and
exposes no colour prop — leave it alone. And `button.test.tsx`, `tabs.test.tsx`, `list.test.tsx`,
`table.test.tsx`, `gauge.test.tsx` and `sparkline.test.tsx` keep asserting against
`themeTokens("dark-default").<role>`: those assertions stay TRUE and stay meaningful, because the
seed is `themeTokensAtom`'s default and this task changes which SPELLING the component passes, not
which hue it resolves. Only tests that pass a token NAME as a prop are edited.

- [ ] **Step 1: Write the failing tests**

`src/runtime/ui/text.test.tsx` — replace the `themeTokens` import with

```ts
import { activeTokens } from "../model/tokens";
```

change the mount at line 37 to

```tsx
      <Text id="danger" color={activeTokens().danger}>
```

and the assertion to `expect(styled && extractRgb(styled.fg)).toBe<string>(activeTokens().danger);`.
Rename that test to `"an explicit Color renders as that hue on the styled run"`. Add:

```tsx
  test("a token NAME is no longer a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().danger`.
    const rejected = <Text id="rejected" color="danger" />;
    expect(rejected).toBeDefined();
  });

  test("with no color it falls back to the active theme's foreground", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 1 });
    open = handle;
    handle.mount(<Text id="plain">y</Text>);
    await handle.render();
    const styled = lineRuns(handle.capture(), 0).find((run) => run.text.includes("y"));
    expect(styled && extractRgb(styled.fg)).toBe<string>(activeTokens().foreground);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/runtime/ui/text.test.tsx && bun x tsc --noEmit`
Expected: FAIL — `TS2322` on `color={activeTokens().danger}` and an unused `@ts-expect-error`.

- [ ] **Step 3: Retype `Text`**

`src/runtime/ui/text.tsx` — replace `import type { ThemeTokens } from "../types";` with
`import type { Color } from "../types";`, retype the prop and resolve the default:

```ts
  /** The text hue; defaults to the theme's `foreground`. Read one off `useTokens()` (spec §4.5). */
  readonly color?: Color;
```
```ts
  const fg = props.color ?? activeTokens().foreground;
```

Replace the component doc's last sentence ("Colors are semantic token names, never raw hues, so a
theme swap re-colors every page without editing sources.") with:

```
 * The hue is a `Color` the caller supplies — a page reads one off its own `useTokens()` (spec
 * §4.5), so the project's design system owns the palette and the catalog owns only the default.
```

- [ ] **Step 4: Retype `Sparkline`**

`src/runtime/ui/sparkline.tsx` — replace `import type { ThemeTokens } from "../types";` with

```ts
import { activeTokens } from "../model/tokens";
import type { Color } from "../types";
```

retype the prop and its default:

```ts
  /** The glyph hue; defaults to the theme's `success` (the design's sparkline green). */
  readonly color?: Color;
```
```ts
  const color = props.color ?? activeTokens().success;
```

- [ ] **Step 5: Resolve the five remaining internal call sites**

Each of these passes a token NAME to `Text` today. Every replacement below reads the SAME role it
named, so no rendered hue changes.

`src/runtime/ui/button.tsx` — the label already has `const tokens = activeTokens();` in scope:

```tsx
      <Text id={`${props.id}-label`} color={disabled ? tokens.foregroundFaint : tokens.foreground}>
```

`src/runtime/ui/tabs.tsx` — add the import `import { activeTokens } from "../model/tokens";`, add
`const tokens = activeTokens();` as the first statement of `Tabs`, and change the label:

```tsx
              color={active ? tokens.accent : tokens.foregroundMuted}
```

`src/runtime/ui/list.tsx` — `const tokens = activeTokens();` is already in scope:

```tsx
            <Text id={`${props.id}-${item.id}-marker`} color={tokens.accent}>
```
```tsx
              color={selected ? tokens.selectionFg : tokens.foreground}
```

`src/runtime/ui/table.tsx` — `const tokens = activeTokens();` is already in scope; four sites:

```tsx
        <Text id={`${props.id}-header-marker`} color={tokens.foregroundMuted}>
```
```tsx
            <Text id={`${props.id}-header-${column.id}`} color={tokens.foregroundMuted} bold>
```
```tsx
            <Text id={`${props.id}-${row.id}-marker`} color={tokens.accent}>
```
```tsx
                  color={selected ? tokens.selectionFg : tokens.foreground}
```

`src/runtime/ui/gauge.tsx` — add `import { activeTokens } from "../model/tokens";`, add
`const tokens = activeTokens();` as the first statement of `Gauge`, and change three sites:

```tsx
        <Text id={`${props.id}-filled`} color={tokens.accent}>
```
```tsx
        <Text id={`${props.id}-empty`} color={tokens.border}>
```
```tsx
        <Text id={`${props.id}-label`} color={tokens.foregroundMuted}>
```

- [ ] **Step 6: Regenerate and run the runtime suite**

Run: `bun run gen:runtime-dts && bun test src/runtime/`
Expected: PASS. `bun x tsc --noEmit` is still expected to be silent here — the Gate fixtures are
template STRINGS, not TypeScript the repo compiler sees, so they fail at the next step instead.

- [ ] **Step 7: Rewrite the Gate's fixture pages**

These six fixture pages are compiled against the freshly regenerated `RUNTIME_DTS` and asserted
CLEAN, so a token name in them is now a real `TS2322`. **Fixture text only — no production Gate
code is touched by this plan.** `#e6a23c` is the seed palette's `accent`
(`src/runtime/model/tokens.ts`'s `DARK_DEFAULT`), which is exactly what a migrated page carries;
it is not a colour invented here.

In `src/gate/model/type-check.test.ts`, replace `color="accent"` with `color="#e6a23c"` at lines
177, 225, 297, 357 and 385. In `src/gate/adapters/gate-runner.test.ts`, do the same at line 1408.

Then add one new case to `src/gate/model/type-check.test.ts`, immediately after the existing
`"a deliberate prop-type error on the same page still surfaces a type diagnostic"` case:

```ts
  withTsc(
    "a token NAME in a colour prop is now a fatal type diagnostic (spec §4.5, §9)",
    async () => {
      // The migration's whole premise: `color="accent"` used to be the ONLY spelling and is now
      // a TS2322 against `Color`. This fixture is what keeps that a checked fact rather than a
      // claim in a spec — if `Color` ever degraded to `string`, this is the test that notices.
      const broken = FIXTURE_PAGE.replace('color="#e6a23c"', 'color="accent"');
      expect(broken).not.toBe(FIXTURE_PAGE);

      const errors = await treeChecker({ files: new Map([["pages/fixture.tsx", broken]]) });
      expect(errors.some((e) => e.code === "TS2322")).toBe(true);
      expect(errors.some((e) => e.file === "pages/fixture.tsx")).toBe(true);
    },
    TIMEOUT_MS,
  );
```

- [ ] **Step 8: Run the Gate suite and the type check**

Run: `bun test src/gate/ && bun test src/runtime/ && bun x tsc --noEmit`
Expected: PASS, `tsc` silent.

- [ ] **Step 9: Commit**

```bash
rtk git add src/runtime/ui src/gate/model/type-check.test.ts src/gate/adapters/gate-runner.test.ts src/runtime/generated
rtk git commit -m "refactor(runtime): type every catalog colour prop as Color"
```

---

### Task 7: Facade contract and architecture docs

**Files:**
- Modify: `src/runtime/index.test.ts`
- Modify: `docs/architecture/modules.md`, `docs/architecture/modules.ru.md`

**Interfaces:**
- Consumes: the whole surface produced by Tasks 1-6.
- Produces: no code surface — a pinned facade contract and current architecture docs.

- [ ] **Step 1: Write the failing test**

Append to the first `describe` block of `src/runtime/index.test.ts`:

```ts
  test("the facade publishes the page-facing colour model and withholds the host seam", () => {
    // The scaffold's `design/system/tokens.ts` imports exactly these (spec §4.3).
    expect(typeof runtime.useTokens).toBe("function");
    const surface = Object.keys(runtime);
    // The host's seeding seam and the raw theme atoms are deliberately NOT on the facade: an
    // authored page must not be able to repaint its own theme (see ./model/tokens' notes).
    for (const withheld of ["seedThemeCapability", "themeIdAtom", "themeTokensAtom"]) {
      expect(surface).not.toContain(withheld);
    }
  });

  test("the generated prompt declaration carries the colour model, not the closed theme union", () => {
    const dts = readFileSync(
      new URL("./generated/runtime.generated.d.ts", import.meta.url),
      "utf8",
    );
    expect(dts).toContain("type Color =");
    expect(dts).toContain("function useTokens");
    // The retired closed union. Its survival here would mean the emit did not pick the change up.
    expect(dts).not.toContain('type ThemeId = "dark-default"');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/runtime/index.test.ts`
Expected: FAIL if any part of the surface drifted from Tasks 1-6; PASS on the `useTokens` line
alone is not sufficient — read the whole output.

- [ ] **Step 3: Make it pass**

No production change is expected. If a `withheld` name IS on the facade, remove it from
`src/runtime/index.ts` (it must not be there — D4). If `runtime.generated.d.ts` is stale, run
`bun run gen:runtime-dts`.

- [ ] **Step 4: Update the architecture docs**

Use the `architecture:architecture-update` skill so both the English document and its `.ru.md`
mirror move together. The four rows that are now wrong:

- `docs/architecture/modules.md:227` — the shared page-contract type list gains `Color` and
  `TokenMap` and must stop presenting `ThemeId` as a closed union.
- `:230` — `src/runtime/model/tokens.ts` is no longer "the `dark-default` palette"; it is the
  compiled SEED (`DARK_DEFAULT`, exported for the P4 scaffold), the two host-input theme atoms,
  the `seedThemeCapability` seam P4 wires, and `useTokens`/`activeTokens`. The "`light-default`
  is declared as v1.0 scope" clause is retired: themes are the project's now.
- `:231` — `themeCapability` no longer "resolves `dark-default` only"; it reads the theme atoms,
  which the mount seeds. Say plainly that nothing writes them YET (P4 does), the same way the row
  already says it for `hostModeAtom`.
- `:233` — the catalog row: every colour prop is a `Color`, and each component's default comes
  from the active theme's core roles.

- [ ] **Step 5: Run the tests**

Run: `bun test src/runtime/ && bun x tsc --noEmit`
Expected: PASS, `tsc` silent.

- [ ] **Step 6: Commit**

```bash
rtk git add src/runtime/index.test.ts docs/architecture
rtk git commit -m "docs(architecture): describe the project-owned runtime colour model"
```

---

## Final verification

Run each of these and read the actual output before claiming the plan is complete
(`superpowers:verification-before-completion`). The suites are separate commands on purpose:
`src/ui` and `src/entrypoint` render tests produce random failures when combined under load
(spec §11), and `bun test` alone can die in `Bun.Transpiler` without printing a single `(fail)`
line — `scripts/run-tests.ts` is the whole-suite gate that turns that into a loud third outcome.

- [ ] **Type check.** `bun x tsc --noEmit` → silent.
- [ ] **Declaration is fresh.** `bun run gen:runtime-dts` then `rtk git status --short src/runtime/generated`
      → no modification. A dirty file here means a task skipped its regeneration step.
- [ ] **Runtime.** `bun test src/runtime/` → pass.
- [ ] **Gate** (its fixtures compile against the regenerated declaration): `bun test src/gate/` → pass.
- [ ] **Host** (imports `DEFAULT_THEME_ID`/`themeTokens`, which D5 kept compiling): `bun test src/host/` → pass.
- [ ] **Agent prompt** (`runtime-authoring-guide.test.ts` reads `themeTokens(DEFAULT_THEME_ID)`):
      `bun test src/agent/` → pass. **If it fails, do not "fix" the guide here** — the authoring
      guide's rewrite is P4's (spec §10 Track A), and this plan must not pre-empt it. A failure
      means D5's seed accessor changed shape; restore it instead.
- [ ] **Shell render tests, separately:** `bun test src/ui/` → pass. Then `bun test src/entrypoint/`
      → pass. Never as one command.
- [ ] **Whole suite through the crash gate:** `bun run test` → exits 0. Exit 2 is a CRASH, never a
      pass; re-run once to get a verdict.
- [ ] **Lint and format:** `bun run lint && bun run fmt:check` → clean.
- [ ] **Reatom audit** (this plan adds atoms and an action): `/reatom-audit` → no findings, or
      findings resolved. Expect the auditor to look hard at `seedThemeCapability`; the answer is
      in D4 and in the action's own doc comment (grouped transition, RTM-S04 — not an identity
      setter, RTM-S01).
- [ ] **Code review:** `superpowers:requesting-code-review` before offering the worktree for merge.

## What this plan deliberately leaves broken, and for whom

Each of these is a spec-sanctioned consequence, not an oversight. They are listed so the executor
does not "fix" them into another plan's scope, and so the reviewer at sync point 1 can check them
off.

1. **A page that omits `meta.theme` type-checks but will not mount.** The FIRST, fatal blocker is
   the Gate's own `src/gate/model/page-contract.ts` (`theme?.kind !== "string"`), which reports
   `MISSING_META_FIELD` — a themeless page never reaches the host at all. Even past the Gate, the
   host child's `pageMetaSchema` (`src/host/session/model/source-mount.ts:541-546`) still requires
   `theme` and would refuse the mount with `MALFORMED_PROTOCOL` as a second blocker. **P4** relaxes
   both. Recorded in `PageMeta.theme`'s own doc comment. Nothing in the repository omits `theme`
   today, so no test covers the gap.
2. **Nothing calls `seedThemeCapability` yet.** The atoms hold the compiled seed for the whole
   process, exactly as `hostModeAtom` holds `"preview"` today. **P4** wires the mount.
3. **`theme:${DEFAULT_THEME_ID}` is still in the declaration bundle.**
   `src/host/protocol/model/embedded-declaration.ts:41` keeps the per-theme capability id; §4.6's
   fixed `theme:project-design-system` is **P4**'s.
4. **The agent authoring guide still teaches "never raw hex".**
   `src/agent/prompt/model/runtime-authoring-guide.md` is now the exact opposite of the shipped
   model. Its rewrite is **P4**'s (spec §10 Track A) and touching it here would collide at sync
   point 1.
5. **`themeTokens`/`DEFAULT_THEME_ID` are still on the public facade.** They are the SEED, not the
   palette (D5), and three out-of-scope files import them. Removing them from the facade belongs
   with **P4**'s host wiring and scaffold, which is what retires the last two call sites.
6. **`examples/clock` is untouched and will fail its Gate on every colour prop.** Spec §9 is
   explicit: example projects migrate at runtime when opened, never by hand.
