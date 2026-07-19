# Phase 1 — `runtime/` (@termcraft/runtime facade) Implementation Plan

> **For agentic workers:** Load `/reatom` and `/errore` before touching code
> (CLAUDE.md mandate). This is a Reatom + React + OpenTUI surface — the `/reatom`
> rules bind. TDD each task; keep `bun test` + `bun x tsc --noEmit` green after
> every task, and `bun test` must return to the shell (no hang).

**Goal:** Build `src/runtime/` — the single public `@termcraft/runtime` facade an
authored design page imports from. Per `docs/superpowers/specs/2026-07-16-runtime-api-compatibility-design.md`
(whole), the roadmap §1 phase 1, and Spike D. The facade must leak **no** private
dependency identity (`@reatom/*`, `react`, `react/jsx-runtime`, `@opentui/*`) into
authored source, ambient types, page metadata, or exported identity (spec §3.3).

**Architecture:** `runtime/` is a **leaf** module (code-structure.md): it imports
only its own internals + the embedded private deps (Reatom/React/OpenTUI), and
NOTHING from `entities/`, `host/`, `core/`, etc. The design page's ONLY import is
`@termcraft/runtime`; the Gate enforces that at the AST level. Components are React
components over OpenTUI intrinsics (`<box>`/`<text>`/`<input>`/`<tab-select>`),
themed by a token palette, each carrying a **mandatory `id`** (the stable-id
contract that selection/pinning key on). All page state/orchestration is Reatom
(re-exported here); no general-purpose React state/effect hooks are exposed.

**Tech Stack:** Bun, TypeScript 7 (`strict`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, `jsx: react-jsx`), `@reatom/core@1001.1.0`,
`@reatom/react@1001`, `@opentui/core`+`@opentui/react@0.4.5`, `react@19`, `errore`.
Component snapshot tests drive the **host** headless renderer (`src/host/render`)
as a **test-only** utility — a test edge, never a production DAG edge (runtime
stays a leaf; its shipped code never imports host).

## Global constraints

- **errore** for any value-level error path (there are few here — mostly pure
  facade re-exports + presentational components).
- **Reatom v1001 rules** (binding): named atoms/computeds/actions; `reatomComponent`
  from `@reatom/react@1001`; test-renderer trees wrap Reatom writes in `act()` from
  `'react'` or frames silently never change (Spike D); a Reatom+OpenTUI one-shot
  render child must `process.exit()` (Spike D) — N/A here (tests use the render
  harness which owns teardown).
- **No private identity leak (§3.3):** the facade re-exports Reatom/React symbols
  under termcraft's own names/types; `index.ts` is the ONLY public surface; authored
  pages never see `@reatom/*`/`react`/`@opentui/*` paths. `verbatimModuleSyntax`
  keeps type-only re-exports erased.
- **Module folder shape (CLAUDE.md):** `model/` (non-UI logic), `ui/` (components),
  `types.ts` + `index.ts` at the root. Components live under `ui/`; don't
  over-fragment (small components are single files under `ui/`).
- **Mandatory `id`:** every catalog component's props require `id: string`. TS
  enforces it; a dev-mode runtime warning is a nice-to-have, not required for MVP.

## Facade surface (§3.2 families → `index.ts` exports)

| Family | Exports |
|---|---|
| Page contract | `definePage` (exists), `PageMeta`, `Size`, `ThemeId` types |
| Reatom state | `atom`, `computed`, `action` (+ public model types `AtomLike`, `Ext`) |
| Reatom async/derivation | `wrap`, `withAsync`, `withAsyncData`, `withComputed`, `withAbort`, `withConnectHook` (+ `ConnectionCleanup`/`ConnectionHookResult`) |
| React binding | `reatomComponent` |
| Design system | the 13 components, `tokens`/`ThemeTokens` types, low-level primitive escape hatch |
| Page capabilities | navigation/tweaks/theme/viewport/color/interaction/export declarations + scoped access (MVP: mostly dormant stubs) |
| Interaction types | facade-owned event/focus/layout/style types accepted by components + primitives |
| JSX helpers | `jsx`, `jsxs`, `jsxDEV`, `Fragment` (so authored `.tsx` compiles against `@termcraft/runtime` as `jsxImportSource`) |

## File structure

```
runtime/
  model/
    define-page.ts        (exists)
    reatom.ts             re-export atom/computed/action/wrap/with*/reatomComponent under facade names
    tokens.ts             ThemeTokens type + dark-default palette + theme registry
    capabilities.ts       runtime capabilities (navigation/tweaks/theme/viewport/color/interaction/export) + export flag; MVP dormant stubs
    jsx.ts                jsx/jsxs/jsxDEV/Fragment re-export (OpenTUI react jsx-runtime) — the authored jsxImportSource surface
    primitive.ts          the low-level escape hatch (facade-owned Box/Text primitives + style/attr types)
  ui/
    row.tsx column.tsx panel.tsx tabs.tsx text.tsx button.tsx input.tsx
    list.tsx table.tsx gauge.tsx sparkline.tsx separator.tsx spacer.tsx
  types.ts                (exists: PageMeta/Size/ThemeId) + component prop types + interaction types
  index.ts                (exists: definePage) → grows into the full facade surface
```

## Component contracts (MVP — mandatory `id`, themed, over OpenTUI intrinsics)

Each maps to OpenTUI `BoxOptions`/`TextOptions`/`InputRenderableOptions`/
`TabSelectRenderableOptions`; tokens come from the active theme (MVP: `dark-default`).

| Component | Props (MVP) | Renders |
|---|---|---|
| `Row` | `id`, `children`, `gap?`, `padding?`, `align?`, `justify?` | `<box flexDirection="row">` |
| `Column` | `id`, `children`, `gap?`, `padding?`, `align?`, `justify?` | `<box flexDirection="column">` |
| `Panel` | `id`, `title?`, `children`, `padding?` | `<box border title>` |
| `Tabs` | `id`, `tabs: {id,label}[]`, `activeId`, `onSelect?` | `<tab-select>` (static: highlighted label row) |
| `Text` | `id`, `children` (string/number), `color?`, `bold?`, `dim?` | `<text fg attributes>` |
| `Button` | `id`, `children`, `onPress?`, `disabled?` | `<box border>` + `<text>` (press only in interactive) |
| `Input` | `id`, `value?`, `placeholder?`, `onChange?`, `focused?` | `<input>` |
| `List` | `id`, `items:{id,label}[]`, `selectedId?`, `onSelect?` | `<box>` of `<text>` rows |
| `Table` | `id`, `columns:{id,label,width?}[]`, `rows:{id,cells}[]` | `<box>` header + rows |
| `Gauge` | `id`, `value` (0..1), `label?` | `<box>` filled bar |
| `Sparkline` | `id`, `values:number[]` | `<text>` of block glyphs (▁▂▃▄▅▆▇█) |
| `Separator` | `id`, `direction?` | `<box>` 1-cell rule |
| `Spacer` | `id`, `size?` | `<box flexGrow>` / fixed gap |

Deferred/dormant (spec + roadmap out-of-scope): `Modal`/`Menu`/`Tree`/`Progress`/
`Chart`/`Scroll`; light theme; interactive input forwarding (`Button.onPress`/
`Input.onChange` accept handlers but the shell only dispatches them in accepted
`interactive` mode — the handler wiring is real, the interaction path lands with
the Kernel/UI). `defineTweaks` export exists but dormant.

## Tasks (TDD, dependency-ordered)

- **T1 — `reatom.ts` facade re-export.** Re-export `atom`, `computed`, `action`,
  `wrap`, `withAsync`, `withAsyncData`, `withComputed`, `withAbort`,
  `withConnectHook` from `@reatom/core` and `reatomComponent` from `@reatom/react`,
  under the facade. Public model types `AtomLike`/`Ext`/`ConnectionCleanup`/
  `ConnectionHookResult` (§3.2) that reveal no private module path. Test: the
  symbols are callable; a named atom round-trips a value; `reatomComponent` renders
  through the host harness reactively (act()-wrapped write, Spike D).
- **T2 — `tokens.ts` theme registry.** `ThemeTokens` type (bg/fg/border/accent/
  muted/success/warning/danger + surface levels) + the `dark-default` palette + a
  `themeTokens(id): ThemeTokens` lookup. Test: dark-default resolves; the type is
  closed to `ThemeId`.
- **T3 — `jsx.ts` + `primitive.ts`.** Re-export `jsx`/`jsxs`/`jsxDEV`/`Fragment`
  from `@opentui/react/jsx-runtime` (facade-owned so authored pages set
  `jsxImportSource: "@termcraft/runtime"`). `primitive.ts`: facade-owned `Box`/
  `Text` low-level primitives + style/attribute/event interaction types (no direct
  OpenTUI import in authored pages). Tests: a `jsx()`-built tree renders; a
  primitive Box renders with a style.
- **T4 — `capabilities.ts`.** Runtime capability declarations (navigation/tweaks/
  theme/viewport/color/interaction/export) + the `isExport()` export-mode flag.
  MVP: dormant stubs returning typed defaults; `defineTweaks` dormant export. Test:
  the capability accessors return typed defaults; export flag toggles.
- **T5..Tn — component catalog** (parallelizable across subagents; each component +
  its snapshot test is independent). Each: props type in `types.ts`, component in
  `ui/<name>.tsx`, snapshot test via the host render harness asserting the themed
  frame text/geometry + that `id` is mandatory. Group commits (e.g. containers,
  text/button/input, data widgets).
- **T-final — `index.ts` facade assembly** + a facade contract test (§11.1): every
  §3.2 family symbol is exported; no `@reatom`/`react`/`@opentui` string appears in
  the public `.d.ts` surface (grep guard). Architecture-doc anchor note.

## Testing

- Component snapshot tests import `createHeadlessRenderer` from `src/host/render`
  (test-only). Wrap Reatom writes in `act()` (Spike D). Assert bounded frame text
  and, where relevant, geometry/dimensions.
- Facade contract test (§11.1): assert the export surface + the no-private-identity
  guard.
- Reatom policy is validated by the `/reatom` audit at the slice boundary.

## Deferred (NOT built in phase 1)

Light theme; `Modal`/`Menu`/`Tree`/`Progress`/`Chart`/`Scroll`; the Tweaks panel UI
(`defineTweaks` export exists, dormant); real interactive input dispatch (handlers
exist; the shell wires them in phase 7); navigation execution (declaration exists,
dormant). The Gate's AST enforcement of the import rule is phase 3; the host
resolver already registers the three specifiers (phase 2C).
