# P6 — Inline text wrappers, `AsciiFont`, and the `Box` layout expansion (Track B, Wave 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Load `/reatom` and `/errore` before any code-related
> action (CLAUDE.md mandate). Every task ends green — `bun x tsc --noEmit` silent and the named
> suites passing — and is one commit.

**Goal:** Add the seven wrappers of spec §6.1's *inline text* and *display text* groups (`Span`,
`Bold`, `Italic`, `Underline`, `Link`, `LineBreak`, `AsciiFont`) to the `@termcraft/runtime`
catalog, and grow `Box` from its ten props to the full §6.2 layout surface — border style and
custom glyphs, per-side borders, top/bottom titles with alignment, absolute positioning, margin,
min/max sizing, overflow, the remaining flex controls, `alignSelf`, and percentage/`auto` sizes.

**Architecture:** Each wrapper is a plain function component in `src/runtime/ui/` that renders
exactly one OpenTUI intrinsic from a **termcraft-declared** prop interface. No `@opentui/*` type
is re-exported and no `style`/`ref`/`renderBefore`/`renderAfter`/`buffered`/`live`/raw
`Renderable` prop is passed through (spec §6). The six inline wrappers share one module
(`ui/inline.tsx`) because they share one contract — they are `TextNodeRenderable`s and are only
valid **inside** a `Text` — and `Text`'s `children` widens to accept them. `AsciiFont` is a real
layout `Renderable` and gets its own module. `Box` stays one component; the expansion is new
props plus three new public-vocabulary → Yoga/OpenTUI maps, in the same shape the existing
`ALIGN`/`JUSTIFY` maps already use.

**Tech Stack:** Bun 1.3, TypeScript 7 (`bun x tsc --noEmit`), `@opentui/core@0.4.5` +
`@opentui/react@0.4.5`, Reatom v1001, `bun:test` with `host/render`'s headless renderer,
errore 0.14.1, oxlint/oxfmt.

## Global Constraints

- **Scope fence.** Only `src/runtime/types.ts`, `src/runtime/ui/**`, `src/runtime/index.ts`,
  `src/runtime/index.test.ts`, `src/runtime/generated/**` (regenerated, never hand-edited), the
  two Gate lexer **canary** files, and `docs/architecture/modules{,.ru}.md`. **No** Gate
  production code, **no** host wiring, **no** `src/agent/prompt/model/runtime-authoring-guide.md`
  (its rewrite is P4's — touching it collides at the merge), **no** `examples/**` (spec §9),
  **no** `design/**`.
- **Design is a source of truth.** Every glyph, alignment value, font name and colour default in
  this plan is either read off `@opentui/core@0.4.5`'s own declarations (quoted with its file
  path at the point of use) or off the existing catalog's established default. Nothing is
  invented. Where the design system does not cover a case, the gap is stated in a code comment
  rather than filled with a guess (see the Design gaps section).
- **Wrapper rules (spec §6), applied to every wrapper in this plan.**
  1. `id` is **mandatory** on every wrapper, `LineBreak` included — see decision **D3**.
  2. Every colour prop is typed `Color` (`` `#${string}` ``, `src/runtime/types.ts`). A token
     NAME must not type-check.
  3. Handlers are wrapped with `wrap`. **None of the eight components in this plan has a
     handler** — `SpanProps`/`LinkProps`/`LineBreakProps`/`AsciiFontProps` declare no `on*` prop,
     and §6.2 adds none to `Box`. The rule is therefore satisfied vacuously; it is recorded here
     so a reviewer can see it was checked, not skipped. Nothing in this plan may add an `on*`
     prop.
  4. No passthrough of `style`, `ref`, `key`, `renderBefore`/`renderAfter`, `buffered`/`live`,
     `selectable`, `focusable`, or the underlying `Renderable`. Each wrapper's JSX lists its
     props explicitly — never `{...props}`.
  5. Prop interfaces are termcraft's own. No `import type { … } from "@opentui/core"` in a
     `*Props` interface. (`TextAttributes` — a runtime *value* — may be imported inside a
     component body and inside tests, exactly as `ui/text.tsx` already does.)
- **Module layout (CLAUDE.md).** `src/runtime/types.ts` holds the module's shared types;
  `src/runtime/index.ts` is the public entry point; `ui/` holds the presentation layer.
- **Imports.** Relative inside `src/runtime` (`../types`, `../model/tokens`); alias
  (`host/protocol`, `host/render/...`) across module boundaries. `verbatimModuleSyntax: true` —
  every type-only import is `import type`.
- **errore.** Nothing in this plan performs I/O or has a failure channel; no `throw`, no new
  error type, no `try`/`catch`.
- **Reatom.** This plan adds no atom, computed or action. Components read the theme through the
  existing non-reactive `activeTokens()` (P1's decision D6). Tests drive export mode through the
  existing `hostModeAtom`.
- **Declaration regeneration.** Any change to `src/runtime`'s public surface invalidates
  `src/runtime/generated/runtime-dts.ts` and `runtime.generated.d.ts`, and
  `src/runtime/generated/runtime-dts.test.ts` fails on the drift. **Every task below runs
  `bun run gen:runtime-dts` before it runs its tests.** The generated files are the agent-facing
  documentation (see decision **D6**) — never hand-edit them.
- **Corpus canary.** `src/gate/model/lexer.test.ts` asserts the exact number of `.ts`/`.tsx`
  files under `src/`, and `src/gate/model/lexer.oracle.test.ts` quotes the same number in a test
  title. The count is **949** at the start of this plan. Every task that creates a file bumps
  **both**, in the same commit, with a one-line note in the existing running comment.
- **Test-command split.** `src/ui` and `src/entrypoint` render tests must run as SEPARATE
  `bun test` commands — a combined run produces random failures under load (spec §11). This plan
  touches neither, but the final verification honours the split.
- **Facade edits are append-only.** P5/P7/P8/P9 run in parallel worktrees and all append to
  `src/runtime/index.ts`. Every export this plan adds goes at the **end** of the file under its
  own comment header; **do not edit the existing `export type { Color, … } from "./types"` line**
  — add a new one instead. Same rule for `src/runtime/index.test.ts`: add new `test(...)` blocks,
  do not rewrite the existing 14-name catalog list.
- **Commits.** One commit per task, conventional-commit subject. Use `rtk git …`. If a message is
  multi-line, write it to a scratch file and pass `-F <path>` (`rtk git commit` swallows heredoc
  stdin).

---

## Decisions made here, with their reasons

These are the choices the spec leaves to the implementation. They are settled here so no task has
to re-litigate them.

**D1 — the six inline wrappers share one module, `src/runtime/ui/inline.tsx`.** The existing
fourteen are one component per file, and that convention holds for anything with substance. These
six are three-to-eight lines each and share one non-obvious contract that must be stated once and
kept consistent: they render `TextNodeRenderable`s (`@opentui/core/renderables/TextNode.d.ts:17`,
`class TextNodeRenderable extends BaseRenderable`), so they are only valid **inside** a `Text`,
and they have no layout box. CLAUDE.md's own rule — "files that change together live together" —
points at one module; splitting them into six files would duplicate that contract comment six
times and cost six canary bumps for no reviewable boundary. `AsciiFont` does **not** join them:
it is a real `Renderable` with layout, an entirely different failure surface, and its own module.

**D2 — inline wrappers must be nested inside `Text`, and `TextProps.children` widens to
`unknown` to allow it.** `TextProps.children` is `string | number` today. `BoxProps.children` is
already `unknown` and compiles against the intrinsic's `React.ReactNode`; `text`'s intrinsic
children type is `TextChildren = string | number | boolean | null | undefined | React.ReactNode`
(`@opentui/react/src/types/components.d.ts:27`), which is at least as wide as `box`'s, so the
same widening compiles. Widening is purely permissive — no existing call site or Gate fixture
breaks. Every render test in this plan nests its inline wrapper in a `Text`, and every inline
wrapper's doc comment states the requirement, because a standalone `<Span>` has no container to
attach to.

**D3 — `id` stays MANDATORY on all six inline wrappers, `LineBreak` included. No exception is
carved.** Three reasons, in order of weight:

1. *The intrinsic accepts it.* `LineBreakProps = Pick<SpanProps, "id">`
   (`@opentui/react/src/types/components.d.ts:37`) — `id` is literally the **only** prop `br`
   has. A mandatory `id` on `LineBreak` is not a strained fit; it is the whole prop surface.
2. *Spec §6 says "every wrapper, without exception".* An exception carved for `br` alone would
   be arbitrary, since — per the divergence below — `Span` is no more host-addressable than
   `LineBreak` is. Either the exception covers the whole inline family (contradicting §6) or it
   covers nothing.
3. *Uniformity is the authored-page contract.* "Every visible component needs a stable, unique
   `id`" is what the authoring guide tells the agent and what the shell's select/pin vocabulary
   assumes. One rule with no memorised exceptions is cheaper for an authoring agent than one rule
   plus a footnote.

**DIVERGENCE, STATED RATHER THAN SILENTLY DROPPED (CLAUDE.md).** An inline `id` reaches the
element but the host **cannot resolve it geometrically**. `rectOf`/`checkHit`
(`src/host/render/model/geometry.ts`) go through `renderer.root.findDescendantById`, declared on
`Renderable` and returning `Renderable | undefined` (`@opentui/core/Renderable.d.ts:187`), and
they read `screenX`/`screenY`/`width`/`height`. `TextNodeRenderable` extends `BaseRenderable`
(`TextNode.d.ts:17`), which has **no Yoga node and no screen rect**, and text nodes are not in
`Renderable.getChildren()`. So an inline id is carried and stable but is not addressable by the
shell's geometry queries today. This must be written into `inline.tsx`'s module doc comment and
pinned by a test (Task 3, Step 6) so it is a recorded fact rather than a surprise. It is **not**
a reason to drop the id: ids are also the export/diff vocabulary, and the day
`describe`/`layoutTree` learn to walk text nodes, the ids are already there.

**D4 — `Span` carries `color` only; weight/slant/underline are the dedicated wrappers.** Giving
`Span` `bold`/`italic`/`underline` booleans **and** shipping `Bold`/`Italic`/`Underline` would be
two spellings for one effect, which is exactly what §4.5 removed from the colour model. `Text`
keeps its existing `bold`/`dim` props unchanged (they predate this plan and removing them is
out of scope). `bg` is deliberately **not** exposed on the inline family in this stage: `Text`
has no background prop either, and adding one to `Span` alone would split the text vocabulary.
Adding it later is purely additive. Recorded in `inline.tsx`'s doc comment.

**D5 — `Box` gains no defaults; it stays the raw escape hatch.** `borderStyle` is passed through
as given and omitted when absent, so OpenTUI's own `"single"` default applies. The **design's**
default frame is rounded (`design/termcraft-engine.js:47`, `const r = o.rounded !== false`) and
that is already pinned where it belongs — `Panel`, the design-conformant frame, hard-codes
`borderStyle="rounded"`. Making `Box` default to rounded too would change what every existing
`<Box border>` renders, for a component whose stated job (runtime-api §3.2) is to be the
un-opinionated escape hatch. Stated in `BoxProps.borderStyle`'s doc comment.

**D6 — the "agent-doc entry" (§6.4) is the JSDoc on the wrapper and its props, carried into
`runtime.generated.d.ts` by `bun run gen:runtime-dts`.** That is exactly how the fourteen
existing components are documented — compare `src/runtime/ui/sparkline.tsx`'s comments with
`src/runtime/generated/runtime.generated.d.ts:596-611`, which are the same text. The generator
auto-discovers emitted chunks (`scripts/gen-runtime-dts.ts:436-473`), so a new `ui/*.tsx` file
needs no registration — only a facade export and a regeneration. The prose guide
(`runtime-authoring-guide.md`) is **P4's** and is not touched here.

**D7 — `AsciiFont.text` is required; `color` is a single `Color`, not a gradient.** Upstream's
`ASCIIFontOptions.text` is optional (`@opentui/core/renderables/ASCIIFont.d.ts:8`), but a
display-text element with no text renders nothing and would be a silent no-op in an authored
page. Upstream's `color?: ColorInput | ColorInput[]` accepts an array (a per-row gradient); §6.1
asks for a display-text wrapper, not a gradient API, and the project's design system contains no
ASCII-banner screen to take a gradient from. The array form is therefore **not** exposed in this
stage — recorded as a deliberate omission in the prop's doc comment, additive to re-add.

**D8 — the export-determinism test for these eight (§6.3) asserts frame equality across
`hostMode`.** None of them holds internal state — that clause of §6.3 targets `Select`,
`Textarea`, `ScrollBox`, `Slider` (P7/P5). What is still worth pinning, and what §6.4 asks for
per element, is that the wrapper's frame does not depend on `hostModeAtom`: render the same tree
in `preview`, then in `export`, and assert `rows` are deeply equal. That is a real assertion —
it fails the moment someone adds a mode-dependent branch — and it is cheap.

## Design gaps, recorded rather than guessed

Per CLAUDE.md ("if the design does not cover a case, ask or flag the gap explicitly"):

- **The design system has no ASCII-banner screen.** `design/*.dc.html` and
  `design/termcraft-engine.js` contain no ASCII-font display text, so there is no design hue for
  `AsciiFont`. It therefore takes the **catalog's own established default** — `Text`'s
  `activeTokens().foreground` — rather than an invented accent. Written into the component's doc
  comment as a gap, not as a design decision.
- **A terminal hyperlink's target is not observable in a captured frame.** `StyledRun`
  (`src/host/protocol/types.ts:77-83`) carries `text`/`fg`/`bg`/`attrs` and no link field, so
  `Link`'s `href` reaches OpenTUI (`LinkRenderable` maps `href` → `link: { url }`) but never
  reaches an export snapshot. `Link`'s render test asserts the link *text* and its hue; the
  unobservable target is recorded in the component's doc comment.
- **§6.2 asks for `margin`, singular.** OpenTUI also offers `marginX/Y/Top/Right/Bottom/Left`
  (`@opentui/core/Renderable.d.ts:49-54`). Only the scalar `margin` the spec names is exposed;
  the per-side forms are a documented, additive omission. Same for `position: "static"` (the
  third member of OpenTUI's `PositionTypeString`, which §6.2 does not ask for and which is Yoga's
  default anyway), and for `shouldFill`/`focusable`/`focusedBorderColor`/`rowGap`/`columnGap`.

## OpenTUI backing for every §6.2 prop — verified, none missing

Read from `node_modules/@opentui/core@0.4.5` declarations. **Every prop §6.2 names has real
OpenTUI backing; there is no gap to report in the layout coverage.**

| §6.2 asks for | OpenTUI prop | Type | Source |
| --- | --- | --- | --- |
| border style single/double/rounded/heavy | `borderStyle` | `BorderStyle = "single" \| "double" \| "rounded" \| "heavy"` | `Box.d.ts:8`, `lib/border.d.ts:15` |
| custom border glyphs | `customBorderChars` | `BorderCharacters` (11 required `string` fields) | `Box.d.ts:11`, `lib/border.d.ts:2-14` |
| `border: boolean \| BorderSides[]` | `border` | `boolean \| BorderSides[]`, `BorderSides = "top" \| "right" \| "bottom" \| "left"` | `Box.d.ts:9`, `lib/border.d.ts:16` |
| border title + alignment | `title`, `titleAlignment` | `string`; `"left" \| "center" \| "right"` | `Box.d.ts:13,15` |
| bottom title + alignment | `bottomTitle`, `bottomTitleAlignment` | `string`; `"left" \| "center" \| "right"` | `Box.d.ts:16,17` |
| position absolute + offsets | `position`, `top`/`right`/`bottom`/`left` | `"static" \| "relative" \| "absolute"`; `number \| "auto" \| \`${number}%\`` | `Renderable.d.ts:38,40-43` |
| `zIndex` | `zIndex` | `number` | `Renderable.d.ts:67` |
| `margin` | `margin` | `number \| "auto" \| \`${number}%\`` | `Renderable.d.ts:48` |
| min/max sizing | `minWidth`/`maxWidth`/`minHeight`/`maxHeight` | `number \| "auto" \| \`${number}%\`` | `Renderable.d.ts:44-47` |
| `overflow` | `overflow` | `"visible" \| "hidden" \| "scroll"` | `Renderable.d.ts:39` |
| `flexShrink`/`flexBasis`/`flexWrap` | same names | `number`; `number \| "auto" \| undefined`; `"no-wrap" \| "wrap" \| "wrap-reverse"` | `Renderable.d.ts:31,37,33` |
| `alignSelf` | `alignSelf` | `AlignString` (`"auto" \| "flex-start" \| "center" \| "flex-end" \| "stretch" \| "baseline" \| …`) | `Renderable.d.ts:36` |
| percentage and `auto` sizes | `width`/`height` | `number \| "auto" \| \`${number}%\`` | `Renderable.d.ts:65-66` |

The four border glyph tables, quoted for the tests (`@opentui/core` bundle,
`chunk-bun-t2myhmwd.js:1224-1276`):

| style | topLeft | topRight | bottomLeft | bottomRight | horizontal | vertical |
| --- | --- | --- | --- | --- | --- | --- |
| `single` | `┌` | `┐` | `└` | `┘` | `─` | `│` |
| `double` | `╔` | `╗` | `╚` | `╝` | `═` | `║` |
| `rounded` | `╭` | `╮` | `╰` | `╯` | `─` | `│` |
| `heavy` | `┏` | `┓` | `┗` | `┛` | `━` | `┃` |

Inline-family backing, same method:

| Wrapper | Intrinsic | Props OpenTUI gives it | Source |
| --- | --- | --- | --- |
| `Span` | `span` | `id?`, `fg?`, `bg?`, `attributes?`, `link?`, children | `components.d.ts:31-33`, `TextNode.d.ts:7-14` |
| `Bold` | `b` | same as `span`; the renderable ORs in `TextAttributes.BOLD` | `components.d.ts:54`; `@opentui/react/chunk-hjtp6jv9.js:33-44` |
| `Italic` | `i` | same; ORs in `TextAttributes.ITALIC` | idem |
| `Underline` | `u` | same; ORs in `TextAttributes.UNDERLINE` | idem |
| `Link` | `a` | `SpanProps & { href: string }`; the renderable maps `href` → `link: { url }` | `components.d.ts:34-36`; `chunk-hjtp6jv9.js:74-80` |
| `LineBreak` | `br` | `Pick<SpanProps, "id">` only; the renderable appends `"\n"` and ignores children | `components.d.ts:37`; `chunk-hjtp6jv9.js:63-72` |
| `AsciiFont` | `ascii-font` | `text?`, `font?: ASCIIFontName`, `color?`, `backgroundColor?`, `selectionBg?`, `selectionFg?`, `selectable?`; `width`/`height` are `Omit`ted upstream | `components.d.ts:65`, `ASCIIFont.d.ts:7-15` |

`ASCIIFontName = "tiny" | "block" | "shade" | "slick" | "huge" | "grid" | "pallet"`
(`@opentui/core/lib/ascii.font.d.ts:3`); upstream's default is `"tiny"`
(`ASCIIFont.d.ts:20`).

The protocol attribute mask, for the `Bold`/`Italic`/`Underline` assertions:
`1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikethrough`
(`src/host/protocol/types.ts:81`).

---

## File structure

| File | Change | Responsibility after this plan |
| --- | --- | --- |
| `src/runtime/types.ts` | modify | Adds the shared layout vocabulary: `Dimension`, `BorderSide`, `BorderGlyphs` |
| `src/runtime/ui/primitive.tsx` | modify | `Box` with the full §6.2 surface + the `ALIGN_SELF`/`WRAP` maps and the `border` array normaliser |
| `src/runtime/ui/primitive.test.tsx` | modify | Adds the border-surface and layout-surface cases + `Box`'s export-determinism test |
| `src/runtime/ui/text.tsx` | modify | `TextProps.children` widens to `unknown` so inline wrappers may nest |
| `src/runtime/ui/inline.tsx` | **create** | `Span`, `Bold`, `Italic`, `Underline`, `Link`, `LineBreak` + the family's contract comment |
| `src/runtime/ui/inline.test.tsx` | **create** | Render + export-determinism test per inline wrapper; the id/geometry divergence pin |
| `src/runtime/ui/ascii-font.tsx` | **create** | `AsciiFont` + `AsciiFontName` |
| `src/runtime/ui/ascii-font.test.tsx` | **create** | Render + export-determinism test |
| `src/runtime/index.ts` | modify | Appends the new value/type exports (append-only) |
| `src/runtime/index.test.ts` | modify | Appends a facade-contract test for the eight additions |
| `src/runtime/generated/runtime-dts.ts`, `runtime.generated.d.ts` | regenerate | Never hand-edited |
| `src/gate/model/lexer.test.ts`, `lexer.oracle.test.ts` | modify | Corpus canary 949 → 953 |
| `docs/architecture/modules.md`, `modules.ru.md` | modify | The `src/runtime/ui/` row counts and describes the new wrappers |

**The eight deliverables, accounted for** so none is assumed covered: `Box` (Tasks 1–2), `Span`
(Task 3), `Bold`/`Italic`/`Underline` (Task 4), `Link`/`LineBreak` (Task 5), `AsciiFont`
(Task 6). Task 7 is the facade/doc/regeneration sweep.

---

### Task 1: `Box` — the border surface

**Files:**
- Modify: `src/runtime/types.ts` (append `BorderSide`, `BorderGlyphs`)
- Modify: `src/runtime/ui/primitive.tsx`
- Modify: `src/runtime/index.ts` (append a type export line at the end of the file)
- Test: `src/runtime/ui/primitive.test.tsx` (modify — append a new `describe` block)

**Interfaces:**
- Consumes: `Color` from `src/runtime/types.ts`; `createHeadlessRenderer` from
  `host/render/model/renderer`; `activeTokens` from `../model/tokens`.
- Produces:
  - `export type BorderSide = "top" | "right" | "bottom" | "left"` (in `runtime/types.ts`)
  - `export interface BorderGlyphs` with eleven `readonly … : string` members
  - `BoxProps` gains `borderStyle?`, `borderChars?`, `title?`, `titleAlign?`, `titleColor?`,
    `bottomTitle?`, `bottomTitleAlign?`, and `border` widens to
    `boolean | readonly BorderSide[]`.

- [ ] **Step 1: Write the failing tests**

Append this block to the end of `src/runtime/ui/primitive.test.tsx` (keep the existing
`describe`, the `open` handle and its `afterEach` exactly as they are):

```tsx
const frameText = (frame: { rows: StyledRun[][] }): string =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");

describe("Box border surface (spec §6.2)", () => {
  test("borderStyle picks the glyph table — double draws ╔ and ═", async () => {
    // Glyphs quoted from @opentui/core@0.4.5's own BorderChars table
    // (chunk-bun-t2myhmwd.js:1238-1249), not invented.
    const handle = await createHeadlessRenderer({ w: 8, h: 3 });
    open = handle;
    handle.mount(<Box id="dbl" border borderStyle="double" borderColor={activeTokens().border} />);
    await handle.render();
    const text = frameText(handle.capture());
    expect(text).toContain("╔");
    expect(text).toContain("═");
  });

  test("borderStyle=heavy draws the heavy table instead", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 3 });
    open = handle;
    handle.mount(<Box id="hvy" border borderStyle="heavy" borderColor={activeTokens().border} />);
    await handle.render();
    const text = frameText(handle.capture());
    expect(text).toContain("┏");
    expect(text).toContain("━");
  });

  test("border as a side list draws only those sides", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 3 });
    open = handle;
    handle.mount(
      <Box id="top-only" border={["top"]} borderStyle="single" borderColor={activeTokens().border}>
        <Text id="top-only-body">x</Text>
      </Box>,
    );
    await handle.render();
    const text = frameText(handle.capture());
    expect(text).toContain("─");
    // The vertical rule belongs to the left/right sides, which were not requested.
    expect(text).not.toContain("│");
  });

  test("borderChars overrides the glyph table entirely", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 3 });
    open = handle;
    handle.mount(
      <Box
        id="custom"
        border
        borderColor={activeTokens().border}
        borderChars={{
          topLeft: "A",
          topRight: "B",
          bottomLeft: "C",
          bottomRight: "D",
          horizontal: "E",
          vertical: "F",
          topT: "G",
          bottomT: "H",
          leftT: "I",
          rightT: "J",
          cross: "K",
        }}
      />,
    );
    await handle.render();
    const text = frameText(handle.capture());
    expect(text).toContain("A");
    expect(text).toContain("E");
  });

  test("title and bottomTitle are drawn into their border rows", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 4 });
    open = handle;
    handle.mount(
      <Box
        id="titled"
        border
        borderColor={activeTokens().border}
        title="Top"
        titleAlign="center"
        titleColor={activeTokens().accent}
        bottomTitle="Bot"
        bottomTitleAlign="right"
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const rows = frame.rows.map((row) => row.map((run) => run.text).join(""));
    expect(rows[0]).toContain("Top");
    expect(rows[rows.length - 1]).toContain("Bot");
  });

  test("titleColor is a Color, never a token name (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().accent`.
    const rejected = <Box id="rejected-title" title="t" titleColor="accent" />;
    expect(rejected).toBeDefined();
  });
});
```

The file already imports `StyledRun`, `extractRgb`, `createHeadlessRenderer`, `RenderHandle`,
`activeTokens`, `Box` and `Text` — no new imports are needed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/runtime/ui/primitive.test.tsx`
Expected: FAIL. The `borderStyle`/`borderChars`/`title`/… props do not exist on `BoxProps`, so
`bun x tsc --noEmit` reports `TS2322`/`TS2353` on them and the run reports failures.

- [ ] **Step 3: Add the shared border vocabulary to `src/runtime/types.ts`**

Append at the end of the file:

```ts
/**
 * One side of a box frame (spec §6.2). `Box.border` takes `true` for all four, `false` for none,
 * or a list of exactly the sides to draw. termcraft declares this locally rather than re-exporting
 * `@opentui/core`'s `BorderSides`, so an OpenTUI upgrade changes the adapter and not one saved
 * page (§6).
 */
export type BorderSide = "top" | "right" | "bottom" | "left";

/**
 * A complete custom frame glyph set (spec §6.2). All eleven members are required: a partial set
 * would leave a frame drawn half in one alphabet and half in another, which reads as a rendering
 * bug rather than a choice. The four built-in tables `borderStyle` selects
 * (`single`/`double`/`rounded`/`heavy`) each supply exactly these eleven.
 */
export interface BorderGlyphs {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  /** The horizontal run along the top and bottom edges. */
  readonly horizontal: string;
  /** The vertical run along the left and right edges. */
  readonly vertical: string;
  /** T-junctions where an interior rule meets an edge. */
  readonly topT: string;
  readonly bottomT: string;
  readonly leftT: string;
  readonly rightT: string;
  /** The four-way junction where two interior rules cross. */
  readonly cross: string;
}
```

- [ ] **Step 4: Grow `BoxProps` and `Box` in `src/runtime/ui/primitive.tsx`**

Change the import line to pull in the new types:

```tsx
import type { BorderGlyphs, BorderSide, Color } from "../types";
```

Replace the `border`/`borderColor`/`background` members of `BoxProps` with this block (keep every
existing member above them unchanged):

```tsx
  /**
   * The frame: `true` for all four sides, `false`/omitted for none, or exactly the sides to
   * draw (spec §6.2).
   */
  readonly border?: boolean | readonly BorderSide[];
  /**
   * Which glyph table the frame is drawn from. OMITTED ON PURPOSE BY DEFAULT: `Box` is the
   * un-opinionated escape hatch (runtime-api §3.2), so with no `borderStyle` OpenTUI's own
   * `single` applies. The DESIGN's default frame is rounded
   * (`design/termcraft-engine.js:47` — `const r = o.rounded !== false`) and is pinned where it
   * belongs, on `Panel`, the design-conformant frame.
   */
  readonly borderStyle?: "single" | "double" | "rounded" | "heavy";
  /** A complete custom glyph set, replacing whatever `borderStyle` would have selected. */
  readonly borderChars?: BorderGlyphs;
  /** The border hue (only meaningful with `border`). Read one off `useTokens()` (spec §4.5). */
  readonly borderColor?: Color;
  /** Caption drawn into the TOP border row. */
  readonly title?: string;
  /** Where the top caption sits along its row; OpenTUI's own default is `left`. */
  readonly titleAlign?: "left" | "center" | "right";
  /** The caption hue. Read one off `useTokens()` (spec §4.5). */
  readonly titleColor?: Color;
  /** Caption drawn into the BOTTOM border row. */
  readonly bottomTitle?: string;
  /** Where the bottom caption sits along its row; OpenTUI's own default is `left`. */
  readonly bottomTitleAlign?: "left" | "center" | "right";
  /** The fill hue. Read one off `useTokens()` (spec §4.5). */
  readonly background?: Color;
```

Add this helper above the `Box` function:

```tsx
/**
 * `border` as the intrinsic wants it. The array is COPIED rather than forwarded: termcraft's own
 * prop is `readonly BorderSide[]` (an authored page must not be handed a mutable alias of its own
 * literal), and the intrinsic's `BorderSides[]` is mutable — a `readonly` array is not assignable
 * to it.
 */
function borderOption(
  border: boolean | readonly BorderSide[] | undefined,
): boolean | BorderSide[] | undefined {
  if (border === undefined || typeof border === "boolean") return border;
  return [...border];
}
```

And extend the rendered element — insert these attributes after the existing `border={…}` line
and replace that line itself:

```tsx
      border={borderOption(props.border)}
      borderStyle={props.borderStyle}
      customBorderChars={props.borderChars}
      borderColor={props.borderColor}
      title={props.title}
      titleAlignment={props.titleAlign}
      titleColor={props.titleColor}
      bottomTitle={props.bottomTitle}
      bottomTitleAlignment={props.bottomTitleAlign}
      backgroundColor={props.background}
```

- [ ] **Step 5: Append the facade export**

At the very END of `src/runtime/index.ts` (append-only, see Global Constraints):

```ts
// §6.2 border and layout vocabulary (plan P6). A SEPARATE export line from the §4 one above on
// purpose: P5/P7/P8/P9 append to this file from their own worktrees, and appended lines merge
// where an edited line conflicts.
export type { BorderGlyphs, BorderSide } from "./types";
```

- [ ] **Step 6: Regenerate the declaration**

Run: `bun run gen:runtime-dts`
Expected: `src/runtime/generated/runtime-dts.ts` and `runtime.generated.d.ts` both change, now
carrying `BorderSide`, `BorderGlyphs` and the widened `BoxProps`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun x tsc --noEmit` → silent.
Run: `bun test src/runtime/` → PASS (including `generated/runtime-dts.test.ts`, which fails on a
stale artifact).

If "border as a side list" fails because a vertical glyph still appears, do **not** weaken the
assertion — read the captured frame and check that `borderOption` really forwarded the array
(a `readonly` array silently forwarded as `undefined` is the likely bug).

- [ ] **Step 8: Commit**

```bash
rtk git add src/runtime/types.ts src/runtime/ui/primitive.tsx src/runtime/ui/primitive.test.tsx src/runtime/index.ts src/runtime/generated
rtk git commit -m "feat(runtime): Box border style, custom glyphs, per-side borders and titles (spec §6.2)"
```

---

### Task 2: `Box` — the layout surface

**Files:**
- Modify: `src/runtime/types.ts` (append `Dimension`)
- Modify: `src/runtime/ui/primitive.tsx`
- Modify: `src/runtime/index.ts` (extend the P6 type-export line added in Task 1)
- Test: `src/runtime/ui/primitive.test.tsx` (modify — append a second new `describe` block)

**Interfaces:**
- Consumes: Task 1's `BoxProps` and the `frameText` helper already added to the test file.
- Produces:
  - ``export type Dimension = number | "auto" | `${number}%` `` (in `runtime/types.ts`)
  - `BoxProps` gains `shrink?`, `basis?`, `wrap?`, `alignSelf?`, `minWidth?`, `maxWidth?`,
    `minHeight?`, `maxHeight?`, `margin?`, `position?`, `top?`, `right?`, `bottom?`, `left?`,
    `zIndex?`, `overflow?`; `width?`/`height?` widen from `number` to `Dimension`.

- [ ] **Step 1: Write the failing tests**

Append to `src/runtime/ui/primitive.test.tsx`:

```tsx
describe("Box layout surface (spec §6.2)", () => {
  test("a percentage width resolves against the parent", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 2 });
    open = handle;
    handle.mount(
      <Box id="outer" width={20} height={1} direction="row">
        <Box id="half" width="50%" height={1} background={activeTokens().surface} />
      </Box>,
    );
    await handle.render();
    expect(handle.rectOf("half")?.width).toBe(10);
  });

  test("auto sizing falls back to content", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 2 });
    open = handle;
    handle.mount(
      <Box id="auto-outer" width="auto" height={1} direction="row">
        <Text id="auto-body">abcde</Text>
      </Box>,
    );
    await handle.render();
    expect(handle.rectOf("auto-outer")?.width).toBe(5);
  });

  test("maxWidth clamps a box that would otherwise grow", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 2 });
    open = handle;
    handle.mount(
      <Box id="clamp-outer" width={20} height={1} direction="row">
        <Box id="clamped" grow={1} maxWidth={6} height={1} background={activeTokens().surface} />
      </Box>,
    );
    await handle.render();
    expect(handle.rectOf("clamped")?.width).toBe(6);
  });

  test("minHeight raises a box above its content height", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 6 });
    open = handle;
    handle.mount(<Box id="tall" minHeight={4} width={4} background={activeTokens().surface} />);
    await handle.render();
    expect(handle.rectOf("tall")?.height).toBe(4);
  });

  test("margin offsets a box inside its parent", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 4 });
    open = handle;
    handle.mount(
      <Box id="margin-outer" width={12} height={4}>
        <Box id="inset" margin={2} width={4} height={1} background={activeTokens().surface} />
      </Box>,
    );
    await handle.render();
    const rect = handle.rectOf("inset");
    expect(rect?.x).toBe(2);
    expect(rect?.y).toBe(2);
  });

  test("position absolute with offsets places a box at exact coordinates", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 5 });
    open = handle;
    handle.mount(
      <Box id="abs-outer" width={12} height={5}>
        <Box
          id="floating"
          position="absolute"
          left={3}
          top={2}
          width={2}
          height={1}
          zIndex={5}
          background={activeTokens().accent}
        />
      </Box>,
    );
    await handle.render();
    const rect = handle.rectOf("floating");
    expect(rect?.x).toBe(3);
    expect(rect?.y).toBe(2);
  });

  test("wrap moves an overflowing child onto the next line", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 4 });
    open = handle;
    handle.mount(
      <Box id="wrap-outer" direction="row" wrap="wrap" width={8} height={4}>
        <Box id="w1" width={6} height={1} background={activeTokens().surface} />
        <Box id="w2" width={6} height={1} background={activeTokens().accent} />
      </Box>,
    );
    await handle.render();
    expect(handle.rectOf("w2")?.y).toBe(1);
  });

  test("shrink lets an oversized child give way", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 2 });
    open = handle;
    handle.mount(
      <Box id="shrink-outer" direction="row" width={8} height={1}>
        <Box id="rigid" width={6} shrink={0} height={1} background={activeTokens().surface} />
        <Box id="giving" width={6} shrink={1} height={1} background={activeTokens().accent} />
      </Box>,
    );
    await handle.render();
    const giving = handle.rectOf("giving")?.width ?? 0;
    expect(giving).toBeLessThan(6);
  });

  test("alignSelf overrides the parent's cross-axis alignment for one child", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 4 });
    open = handle;
    handle.mount(
      <Box id="self-outer" direction="row" align="start" width={10} height={4}>
        <Box id="pinned" alignSelf="end" width={2} height={1} background={activeTokens().accent} />
      </Box>,
    );
    await handle.render();
    expect(handle.rectOf("pinned")?.y).toBe(3);
  });

  test("overflow hidden clips a child that exceeds the box", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 3 });
    open = handle;
    handle.mount(
      <Box id="clip" width={4} height={1} overflow="hidden">
        <Text id="clip-body">abcdefghij</Text>
      </Box>,
    );
    await handle.render();
    expect(frameText(handle.capture())).not.toContain("abcdefghij");
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = (
      <Box
        id="det"
        border
        borderStyle="rounded"
        borderColor={activeTokens().border}
        title="T"
        titleAlign="center"
        titleColor={activeTokens().accent}
        width="100%"
        minHeight={3}
        margin={0}
        overflow="hidden"
        background={activeTokens().surface}
      >
        <Text id="det-body">body</Text>
      </Box>
    );
    const preview = await renderOnce(tree, { w: 12, h: 4 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 12, h: 4 });
    expect(exported.rows).toEqual(preview.rows);
  });
});
```

Add, above the first `describe` in the file, the helper and the mode reset the last test needs:

```tsx
/** Render one tree into a throwaway renderer and return its frame. */
const renderOnce = async (node: unknown, size: { w: number; h: number }) => {
  const handle = await createHeadlessRenderer(size);
  try {
    handle.mount(node);
    await handle.render();
    return handle.capture();
  } finally {
    handle.destroy();
  }
};
```

and extend the existing `afterEach` body with `hostModeAtom.set("preview");`, importing it:

```tsx
import { hostModeAtom } from "../model/capabilities";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/runtime/ui/primitive.test.tsx`
Expected: FAIL — `width="50%"`, `maxWidth`, `margin`, `position`, `wrap`, `shrink`, `alignSelf`,
`overflow` are not on `BoxProps`.

- [ ] **Step 3: Add `Dimension` to `src/runtime/types.ts`**

Append:

```ts
/**
 * A layout length (spec §6.2): a cell count, a percentage of the containing box, or `auto` —
 * "whatever the content or the flex algorithm decides". termcraft declares this locally rather
 * than re-exporting OpenTUI's own union, so an OpenTUI upgrade changes the adapter and not one
 * saved page (§6).
 */
export type Dimension = number | "auto" | `${number}%`;
```

- [ ] **Step 4: Grow `BoxProps` and `Box`**

Import: `import type { BorderGlyphs, BorderSide, Color, Dimension } from "../types";`

Replace the existing `grow`/`width`/`height` members and add the rest, so the layout half of
`BoxProps` reads:

```tsx
  /** Flex grow factor — a 0 keeps the box at content size; ≥1 lets it expand. */
  readonly grow?: number;
  /** Flex shrink factor — a 0 refuses to give way when the line is over-full. */
  readonly shrink?: number;
  /** Flex basis — the main-axis starting size before grow/shrink, or `auto` for content size. */
  readonly basis?: number | "auto";
  /** Whether an over-full row/column wraps onto further lines. */
  readonly wrap?: "nowrap" | "wrap" | "wrap-reverse";
  /** Cross-axis placement of THIS box, overriding its parent's `align` for it alone. */
  readonly alignSelf?: "auto" | "start" | "center" | "end" | "stretch" | "baseline";
  readonly width?: Dimension;
  readonly height?: Dimension;
  readonly minWidth?: Dimension;
  readonly maxWidth?: Dimension;
  readonly minHeight?: Dimension;
  readonly maxHeight?: Dimension;
  /**
   * Outer spacing on all four sides. DELIBERATE OMISSION: OpenTUI also offers per-side and
   * per-axis margins; spec §6.2 asks for the scalar form only, and exposing more is additive.
   */
  readonly margin?: Dimension;
  /**
   * `absolute` takes the box out of its parent's flex flow and places it by the offsets below.
   * DELIBERATE OMISSION: OpenTUI's third value, `static`, is Yoga's own default and §6.2 does not
   * ask for it.
   */
  readonly position?: "relative" | "absolute";
  readonly top?: Dimension;
  readonly right?: Dimension;
  readonly bottom?: Dimension;
  readonly left?: Dimension;
  /** Paint order among overlapping siblings; higher paints later. */
  readonly zIndex?: number;
  /** What happens to content larger than the box. */
  readonly overflow?: "visible" | "hidden" | "scroll";
```

Add the two new vocabulary maps beside the existing `ALIGN`/`JUSTIFY`:

```tsx
/** Public prop value → Yoga `alignSelf`. `start`/`end` gain the `flex-` prefix; the rest pass through. */
const ALIGN_SELF = {
  auto: "auto",
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
} as const;

/** Public prop value → Yoga `flexWrap`. Only `nowrap` is respelled (`no-wrap` upstream). */
const WRAP = {
  nowrap: "no-wrap",
  wrap: "wrap",
  "wrap-reverse": "wrap-reverse",
} as const;
```

And extend the rendered element with:

```tsx
      flexShrink={props.shrink}
      flexBasis={props.basis}
      flexWrap={props.wrap !== undefined ? WRAP[props.wrap] : undefined}
      alignSelf={props.alignSelf !== undefined ? ALIGN_SELF[props.alignSelf] : undefined}
      minWidth={props.minWidth}
      maxWidth={props.maxWidth}
      minHeight={props.minHeight}
      maxHeight={props.maxHeight}
      margin={props.margin}
      position={props.position}
      top={props.top}
      right={props.right}
      bottom={props.bottom}
      left={props.left}
      zIndex={props.zIndex}
      overflow={props.overflow}
```

- [ ] **Step 5: Extend the facade type export**

In `src/runtime/index.ts`, change the P6 line added in Task 1 to:

```ts
export type { BorderGlyphs, BorderSide, Dimension } from "./types";
```

- [ ] **Step 6: Regenerate and run**

Run: `bun run gen:runtime-dts`
Run: `bun x tsc --noEmit` → silent.
Run: `bun test src/runtime/` → PASS.

If a layout assertion disagrees with Yoga (e.g. the `shrink` or `alignSelf` case resolves to a
different cell), **read `handle.layoutTree()` and correct the EXPECTED number to what Yoga
actually computes** — the prop plumbing is what this task proves, and a fabricated expectation is
worse than a corrected one. Never delete the assertion.

- [ ] **Step 7: Commit**

```bash
rtk git add src/runtime/types.ts src/runtime/ui/primitive.tsx src/runtime/ui/primitive.test.tsx src/runtime/index.ts src/runtime/generated
rtk git commit -m "feat(runtime): Box sizing, position, margin, overflow and flex controls (spec §6.2)"
```

---

### Task 3: `Text` accepts inline children, and `Span` lands

**Files:**
- Modify: `src/runtime/ui/text.tsx` (widen `children`)
- Create: `src/runtime/ui/inline.tsx`
- Create: `src/runtime/ui/inline.test.tsx`
- Modify: `src/runtime/index.ts` (append)
- Modify: `src/gate/model/lexer.test.ts`, `src/gate/model/lexer.oracle.test.ts` (canary 949 → 951)

**Interfaces:**
- Consumes: `Color` (`../types`), `activeTokens` (`../model/tokens`), `hostModeAtom`
  (`../model/capabilities`), the headless harness (`host/render/model/renderer`), `extractRgb`
  (`host/render/model/color`), `StyledRun` (`host/protocol`).
- Produces: `export interface SpanProps { readonly id: string; readonly children?: unknown;
  readonly color?: Color }` and `export function Span(props: SpanProps)`, both from
  `src/runtime/ui/inline.tsx`. `TextProps.children` becomes `unknown`.

- [ ] **Step 1: Write the failing test file**

Create `src/runtime/ui/inline.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { Span } from "./inline";
import { Text } from "./text";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const frameText = (frame: { rows: StyledRun[][] }): string =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");

/** Render one tree into a throwaway renderer and return its frame. */
const renderOnce = async (node: unknown, size: { w: number; h: number }) => {
  const handle = await createHeadlessRenderer(size);
  try {
    handle.mount(node);
    await handle.render();
    return handle.capture();
  } finally {
    handle.destroy();
  }
};

describe("Span inline text (spec §6.1)", () => {
  test("renders its children inside a Text", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Span id="part">hello</Span>
      </Text>,
    );
    await handle.render();
    expect(frameText(handle.capture())).toContain("hello");
  });

  test("an explicit Color renders as that hue on the styled run", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Span id="warned" color={activeTokens().danger}>
          bad
        </Span>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("bad"));
    expect(styled && extractRgb(styled.fg)).toBe<string>(activeTokens().danger);
  });

  test("a token NAME is no longer a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().danger`.
    const rejected = <Span id="rejected" color="danger" />;
    expect(rejected).toBeDefined();
  });

  test("sibling spans compose into one line", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Span id="a">ab</Span>
        <Span id="b">cd</Span>
      </Text>,
    );
    await handle.render();
    expect(frameText(handle.capture())).toContain("abcd");
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = (
      <Text id="line">
        <Span id="part" color={activeTokens().accent}>
          hello
        </Span>
      </Text>
    );
    const preview = await renderOnce(tree, { w: 16, h: 1 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 16, h: 1 });
    expect(exported.rows).toEqual(preview.rows);
  });
});

describe("inline ids and host geometry — the recorded divergence", () => {
  test("an inline id is carried but is NOT resolvable by rectOf", async () => {
    // WHY THIS IS ASSERTED RATHER THAN LAMENTED: `TextNodeRenderable extends BaseRenderable`
    // (@opentui/core/renderables/TextNode.d.ts:17) — no Yoga node, no screen rect — and
    // `findDescendantById` is declared on `Renderable` (Renderable.d.ts:187), walking only
    // renderable children. So the shell's geometry queries cannot address an inline element.
    // The id is still mandatory (plan D3); this test is what makes the limit a fact instead of
    // a surprise, and it is what will FAIL — loudly, and in the good direction — on the day
    // OpenTUI or the host learns to walk text nodes.
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Span id="unreachable">x</Span>
      </Text>,
    );
    await handle.render();
    expect(handle.rectOf("line")).not.toBeNull();
    expect(handle.rectOf("unreachable")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/runtime/ui/inline.test.tsx`
Expected: FAIL — `Cannot find module "./inline"`.

- [ ] **Step 3: Widen `TextProps.children`**

In `src/runtime/ui/text.tsx`, replace the `children` member:

```tsx
  /**
   * Literal text, or the inline wrappers of `ui/inline` (`Span`, `Bold`, `Italic`, `Underline`,
   * `Link`, `LineBreak`). `unknown` rather than a named node union: the React/OpenTUI node type
   * is a private identity this facade must not leak into authored source (runtime-api §3.3), and
   * `BoxProps.children` already takes the same shape for the same reason.
   */
  readonly children?: unknown;
```

- [ ] **Step 4: Create `src/runtime/ui/inline.tsx` with `Span`**

```tsx
import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/**
 * THE INLINE TEXT FAMILY (spec §6.1). Six wrappers over OpenTUI's text-node intrinsics —
 * `span`, `b`, `i`, `u`, `a`, `br` — kept in ONE module because they share one contract that
 * has to be stated once and obeyed by all of them:
 *
 *  - **They are only valid inside a `Text`.** Each renders a `TextNodeRenderable`
 *    (`@opentui/core/renderables/TextNode.d.ts:17`), which is not a layout renderable and has no
 *    container of its own; a `Text` is what holds them. `TextProps.children` is widened to accept
 *    them.
 *  - **Their `id` is mandatory but NOT host-addressable.** `TextNodeRenderable` extends
 *    `BaseRenderable` — no Yoga node, no screen rect — and the host's `rectOf`/`checkHit` walk
 *    `Renderable.findDescendantById` (`@opentui/core/Renderable.d.ts:187`), which never reaches a
 *    text node. DIVERGENCE, DOCUMENTED RATHER THAN SILENTLY DROPPED (CLAUDE.md): the id is
 *    carried, stable, and part of the authored-page contract spec §6 states without exception,
 *    but the shell cannot select or pin an inline run today. `ui/inline.test.tsx` pins that fact.
 *  - **Weight, slant and underline are the dedicated wrappers, not `Span` flags.** Two spellings
 *    for one effect is what §4.5 removed from the colour model; one spelling is kept here.
 *  - **No background prop in this stage.** `Text` has none either, and splitting the text
 *    vocabulary for `Span` alone would cost more than it buys. Adding it later is additive.
 */

/** Props for the inline `Span`. `id` is the mandatory stable id (§3.2). */
export interface SpanProps {
  /** Stable id the shell keys on. Mandatory on every catalog component — see the module note. */
  readonly id: string;
  /** Literal text, or further inline wrappers. */
  readonly children?: unknown;
  /** The run's hue; defaults to the theme's `foreground`. Read one off `useTokens()` (spec §4.5). */
  readonly color?: Color;
}

/**
 * An inline run of text inside a `Text` (design-system §6.1). Its only styling is a hue — for
 * weight, slant or underline, wrap it in `Bold`, `Italic` or `Underline`. Must be nested in a
 * `Text`; on its own it has no container to attach to.
 */
export function Span(props: SpanProps) {
  return (
    <span id={props.id} fg={props.color ?? activeTokens().foreground}>
      {props.children}
    </span>
  );
}
```

- [ ] **Step 5: Append the facade exports**

At the end of `src/runtime/index.ts`:

```ts
// Inline text wrappers (§6.1). Valid only inside a `Text` — see `./ui/inline`'s module note for
// the family contract and for the documented id/geometry divergence.
export { Span } from "./ui/inline";
export type { SpanProps } from "./ui/inline";
```

- [ ] **Step 6: Bump the corpus canary 949 → 951**

In `src/gate/model/lexer.test.ts`, append to the running comment above the assertion and change
the number:

```
    // Plan P6 (inline wrappers and the Box expansion) task 3 adds `runtime/ui/inline.tsx` and
    // its own `inline.test.tsx`, taking it to 951.
```

```ts
    expect(files.length).toBe(951);
```

In `src/gate/model/lexer.oracle.test.ts:556`, change the test title's number:

```ts
  test("the repository's own 951 sources: zero under-scans and zero refusals", () => {
```

- [ ] **Step 7: Regenerate and run**

Run: `bun run gen:runtime-dts`
Run: `bun x tsc --noEmit` → silent.
Run: `bun test src/runtime/` → PASS.
Run: `bun test src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts` → PASS. A
mismatch here means the canary bump missed a file — count with the walk, do not guess.

- [ ] **Step 8: Commit**

```bash
rtk git add src/runtime/ui/inline.tsx src/runtime/ui/inline.test.tsx src/runtime/ui/text.tsx src/runtime/index.ts src/runtime/generated src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts
rtk git commit -m "feat(runtime): Span inline text wrapper and Text inline children (spec §6.1)"
```

---

### Task 4: `Bold`, `Italic`, `Underline`

**Files:**
- Modify: `src/runtime/ui/inline.tsx`
- Modify: `src/runtime/ui/inline.test.tsx`
- Modify: `src/runtime/index.ts` (append)

**Interfaces:**
- Consumes: Task 3's `SpanProps` shape and `inline.test.tsx`'s helpers.
- Produces: `BoldProps`, `ItalicProps`, `UnderlineProps` (each identical in shape to `SpanProps`)
  and `Bold`, `Italic`, `Underline`.

- [ ] **Step 1: Write the failing tests**

Append to `src/runtime/ui/inline.test.tsx`, and extend its imports with
`import { TextAttributes } from "@opentui/core";` and `Bold, Italic, Underline` from `./inline`:

```tsx
describe("Bold / Italic / Underline inline wrappers (spec §6.1)", () => {
  test("Bold sets the bold attribute on its run", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Bold id="strong">hey</Bold>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("hey"));
    // The mask is the protocol's own (src/host/protocol/types.ts:81 — 1 bold, 2 dim, 4 italic,
    // 8 underline); `TextAttributes` is OpenTUI's source for the same bits.
    expect((styled?.attrs ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
  });

  test("Italic sets the italic attribute on its run", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Italic id="slant">hey</Italic>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("hey"));
    expect((styled?.attrs ?? 0) & TextAttributes.ITALIC).toBe(TextAttributes.ITALIC);
  });

  test("Underline sets the underline attribute on its run", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Underline id="rule">hey</Underline>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("hey"));
    expect((styled?.attrs ?? 0) & TextAttributes.UNDERLINE).toBe(TextAttributes.UNDERLINE);
  });

  test("they nest, and the attributes combine", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Bold id="outer">
          <Italic id="inner">hey</Italic>
        </Bold>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("hey"));
    const mask = TextAttributes.BOLD | TextAttributes.ITALIC;
    expect((styled?.attrs ?? 0) & mask).toBe(mask);
  });

  test("each takes a Color, and a token NAME does not compile (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().accent`.
    const rejected = <Bold id="rejected-bold" color="accent" />;
    expect(rejected).toBeDefined();
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = (
      <Text id="line">
        <Bold id="b" color={activeTokens().accent}>
          a
        </Bold>
        <Italic id="i">b</Italic>
        <Underline id="u">c</Underline>
      </Text>
    );
    const preview = await renderOnce(tree, { w: 16, h: 1 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 16, h: 1 });
    expect(exported.rows).toEqual(preview.rows);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/runtime/ui/inline.test.tsx`
Expected: FAIL — `Bold`, `Italic`, `Underline` are not exported from `./inline`.

- [ ] **Step 3: Implement the three wrappers**

Append to `src/runtime/ui/inline.tsx`:

```tsx
/** Props for the inline `Bold`. `id` is the mandatory stable id (§3.2). */
export interface BoldProps {
  /** Stable id the shell keys on. Mandatory on every catalog component — see the module note. */
  readonly id: string;
  /** Literal text, or further inline wrappers. */
  readonly children?: unknown;
  /** The run's hue; defaults to the theme's `foreground`. Read one off `useTokens()` (spec §4.5). */
  readonly color?: Color;
}

/**
 * A bold inline run inside a `Text` (design-system §6.1). The weight comes from the intrinsic
 * itself — `@opentui/react`'s `b` renderable ORs `TextAttributes.BOLD` into the run — so nesting
 * `Bold` inside `Italic` combines both rather than replacing one.
 */
export function Bold(props: BoldProps) {
  return (
    <b id={props.id} fg={props.color ?? activeTokens().foreground}>
      {props.children}
    </b>
  );
}

/** Props for the inline `Italic`. `id` is the mandatory stable id (§3.2). */
export interface ItalicProps {
  /** Stable id the shell keys on. Mandatory on every catalog component — see the module note. */
  readonly id: string;
  /** Literal text, or further inline wrappers. */
  readonly children?: unknown;
  /** The run's hue; defaults to the theme's `foreground`. Read one off `useTokens()` (spec §4.5). */
  readonly color?: Color;
}

/**
 * An italic inline run inside a `Text` (design-system §6.1). The slant comes from the intrinsic
 * (`TextAttributes.ITALIC`); whether the terminal actually renders italics is the terminal's
 * choice, and the attribute is carried into the export snapshot either way.
 */
export function Italic(props: ItalicProps) {
  return (
    <i id={props.id} fg={props.color ?? activeTokens().foreground}>
      {props.children}
    </i>
  );
}

/** Props for the inline `Underline`. `id` is the mandatory stable id (§3.2). */
export interface UnderlineProps {
  /** Stable id the shell keys on. Mandatory on every catalog component — see the module note. */
  readonly id: string;
  /** Literal text, or further inline wrappers. */
  readonly children?: unknown;
  /** The run's hue; defaults to the theme's `foreground`. Read one off `useTokens()` (spec §4.5). */
  readonly color?: Color;
}

/**
 * An underlined inline run inside a `Text` (design-system §6.1). The rule comes from the
 * intrinsic (`TextAttributes.UNDERLINE`), not from a drawn glyph, so it never consumes a row.
 */
export function Underline(props: UnderlineProps) {
  return (
    <u id={props.id} fg={props.color ?? activeTokens().foreground}>
      {props.children}
    </u>
  );
}
```

- [ ] **Step 4: Append the facade exports**

Extend the P6 inline block at the end of `src/runtime/index.ts`:

```ts
export { Bold, Italic, Underline } from "./ui/inline";
export type { BoldProps, ItalicProps, UnderlineProps } from "./ui/inline";
```

- [ ] **Step 5: Regenerate and run**

Run: `bun run gen:runtime-dts`
Run: `bun x tsc --noEmit` → silent.
Run: `bun test src/runtime/` → PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add src/runtime/ui/inline.tsx src/runtime/ui/inline.test.tsx src/runtime/index.ts src/runtime/generated
rtk git commit -m "feat(runtime): Bold, Italic and Underline inline wrappers (spec §6.1)"
```

---

### Task 5: `Link` and `LineBreak`

**Files:**
- Modify: `src/runtime/ui/inline.tsx`
- Modify: `src/runtime/ui/inline.test.tsx`
- Modify: `src/runtime/index.ts` (append)

**Interfaces:**
- Consumes: Task 3's module and test helpers.
- Produces: `LinkProps` (`id`, `href`, `children?`, `color?`), `Link`, `LineBreakProps` (`id`
  only), `LineBreak`.

- [ ] **Step 1: Write the failing tests**

Append to `src/runtime/ui/inline.test.tsx` (extend the `./inline` import with `Link, LineBreak`):

```tsx
describe("Link inline wrapper (spec §6.1)", () => {
  test("renders its label text", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Link id="docs" href="https://example.invalid/docs">
          docs
        </Link>
      </Text>,
    );
    await handle.render();
    expect(frameText(handle.capture())).toContain("docs");
  });

  test("takes a Color for the label hue", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Link id="docs" href="https://example.invalid/docs" color={activeTokens().accent}>
          docs
        </Link>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("docs"));
    expect(styled && extractRgb(styled.fg)).toBe<string>(activeTokens().accent);
  });

  test("href is required — omitting it does not compile", () => {
    // @ts-expect-error — a link with no target is not a link.
    const rejected = <Link id="rejected-link">docs</Link>;
    expect(rejected).toBeDefined();
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = (
      <Text id="line">
        <Link id="docs" href="https://example.invalid/docs" color={activeTokens().accent}>
          docs
        </Link>
      </Text>
    );
    const preview = await renderOnce(tree, { w: 20, h: 1 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 20, h: 1 });
    expect(exported.rows).toEqual(preview.rows);
  });
});

describe("LineBreak inline wrapper (spec §6.1)", () => {
  test("splits one Text across two rows", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Span id="first">one</Span>
        <LineBreak id="brk" />
        <Span id="second">two</Span>
      </Text>,
    );
    await handle.render();
    const rows = handle.capture().rows.map((row) => row.map((run) => run.text).join(""));
    expect(rows[0]).toContain("one");
    expect(rows[1]).toContain("two");
  });

  test("id is mandatory — omitting it does not compile (plan decision D3)", () => {
    // @ts-expect-error — spec §6 makes `id` mandatory on EVERY wrapper, `br` included: `id` is
    // the only prop the intrinsic has (`LineBreakProps = Pick<SpanProps, "id">`), so no exception
    // is carved here.
    const rejected = <LineBreak />;
    expect(rejected).toBeDefined();
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = (
      <Text id="line">
        <Span id="first">one</Span>
        <LineBreak id="brk" />
        <Span id="second">two</Span>
      </Text>
    );
    const preview = await renderOnce(tree, { w: 12, h: 3 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 12, h: 3 });
    expect(exported.rows).toEqual(preview.rows);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/runtime/ui/inline.test.tsx`
Expected: FAIL — `Link` and `LineBreak` are not exported from `./inline`.

- [ ] **Step 3: Implement both wrappers**

Append to `src/runtime/ui/inline.tsx`:

```tsx
/** Props for the inline `Link`. `id` is the mandatory stable id (§3.2). */
export interface LinkProps {
  /** Stable id the shell keys on. Mandatory on every catalog component — see the module note. */
  readonly id: string;
  /** The link target, emitted as a terminal hyperlink. Required: a link with no target is text. */
  readonly href: string;
  /** The label; literal text, or further inline wrappers. */
  readonly children?: unknown;
  /** The label's hue; defaults to the theme's `foreground`. Read one off `useTokens()` (spec §4.5). */
  readonly color?: Color;
}

/**
 * A terminal hyperlink inside a `Text` (design-system §6.1). The label renders as ordinary
 * inline text; `href` becomes the run's hyperlink target in terminals that support it.
 *
 * DESIGN GAP, RECORDED RATHER THAN GUESSED (CLAUDE.md): the design system defines no distinct
 * link hue, so this defaults to `foreground` like every other inline run instead of inventing
 * one — pass `color={t.accent}` for the conventional highlighted link.
 *
 * DIVERGENCE: a hyperlink TARGET is not observable in a captured frame. `StyledRun`
 * (`src/host/protocol/types.ts:77-83`) carries text, colours and attributes and has no link
 * field, so an export snapshot preserves the label and drops the target. The tests assert the
 * label and its hue for exactly that reason.
 */
export function Link(props: LinkProps) {
  return (
    <a id={props.id} href={props.href} fg={props.color ?? activeTokens().foreground}>
      {props.children}
    </a>
  );
}

/** Props for the inline `LineBreak`. `id` is the mandatory stable id (§3.2) and its only prop. */
export interface LineBreakProps {
  /**
   * Stable id the shell keys on. Mandatory, with no exception carved for this element: `id` is
   * the ENTIRE prop surface the `br` intrinsic has (`LineBreakProps = Pick<SpanProps, "id">`,
   * `@opentui/react/src/types/components.d.ts:37`), and spec §6 states the rule without
   * exception. See the module note for what an inline id can and cannot do.
   */
  readonly id: string;
}

/**
 * A hard line break inside a `Text` (design-system §6.1). Takes no children and no styling — the
 * intrinsic emits a newline and nothing else. Use it to split one `Text` across rows without
 * paying for a second container.
 */
export function LineBreak(props: LineBreakProps) {
  return <br id={props.id} />;
}
```

- [ ] **Step 4: Append the facade exports**

```ts
export { Link, LineBreak } from "./ui/inline";
export type { LinkProps, LineBreakProps } from "./ui/inline";
```

- [ ] **Step 5: Regenerate and run**

Run: `bun run gen:runtime-dts`
Run: `bun x tsc --noEmit` → silent.
Run: `bun test src/runtime/` → PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add src/runtime/ui/inline.tsx src/runtime/ui/inline.test.tsx src/runtime/index.ts src/runtime/generated
rtk git commit -m "feat(runtime): Link and LineBreak inline wrappers (spec §6.1)"
```

---

### Task 6: `AsciiFont`

**Files:**
- Create: `src/runtime/ui/ascii-font.tsx`
- Create: `src/runtime/ui/ascii-font.test.tsx`
- Modify: `src/runtime/index.ts` (append)
- Modify: `src/gate/model/lexer.test.ts`, `src/gate/model/lexer.oracle.test.ts` (canary 951 → 953)

**Interfaces:**
- Consumes: `Color` (`../types`), `activeTokens` (`../model/tokens`), `hostModeAtom`, the
  headless harness.
- Produces:
  `export type AsciiFontName = "tiny" | "block" | "shade" | "slick" | "huge" | "grid" | "pallet"`,
  `export interface AsciiFontProps { readonly id: string; readonly text: string;
  readonly font?: AsciiFontName; readonly color?: Color; readonly background?: Color }`,
  `export function AsciiFont(props: AsciiFontProps)`.

- [ ] **Step 1: Write the failing test file**

Create `src/runtime/ui/ascii-font.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { AsciiFont } from "./ascii-font";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();

const renderOnce = async (node: unknown, size: { w: number; h: number }) => {
  const handle = await createHeadlessRenderer(size);
  try {
    handle.mount(node);
    await handle.render();
    return handle.capture();
  } finally {
    handle.destroy();
  }
};

describe("AsciiFont display text (spec §6.1)", () => {
  test("paints a block of glyphs and resolves as a real layout element", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(<AsciiFont id="banner" text="AB" font="tiny" />);
    await handle.render();
    const rect = handle.rectOf("banner");
    // Unlike the inline family, ASCIIFontRenderable IS a layout Renderable, so its id resolves.
    expect(rect).not.toBeNull();
    expect((rect?.height ?? 0) > 1).toBe(true);
    expect(allRuns(handle.capture()).some((run) => run.text.trim() !== "")).toBe(true);
  });

  test("an explicit Color paints the glyphs in that hue", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(<AsciiFont id="banner" text="A" font="tiny" color={activeTokens().accent} />);
    await handle.render();
    const painted = allRuns(handle.capture()).filter((run) => run.text.trim() !== "");
    expect(painted.some((run) => extractRgb(run.fg) === activeTokens().accent)).toBe(true);
  });

  test("a token NAME is no longer a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().accent`.
    const rejected = <AsciiFont id="rejected" text="A" color="accent" />;
    expect(rejected).toBeDefined();
  });

  test("text is required — omitting it does not compile", () => {
    // @ts-expect-error — a display-text element with no text is a silent no-op (plan decision D7).
    const rejected = <AsciiFont id="rejected-empty" />;
    expect(rejected).toBeDefined();
  });

  test("an unknown font name does not compile", () => {
    // @ts-expect-error — the seven names are @opentui/core's own `ASCIIFontName` union.
    const rejected = <AsciiFont id="rejected-font" text="A" font="comic" />;
    expect(rejected).toBeDefined();
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = <AsciiFont id="banner" text="A" font="tiny" color={activeTokens().accent} />;
    const preview = await renderOnce(tree, { w: 40, h: 8 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 40, h: 8 });
    expect(exported.rows).toEqual(preview.rows);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/runtime/ui/ascii-font.test.tsx`
Expected: FAIL — `Cannot find module "./ascii-font"`.

- [ ] **Step 3: Implement the wrapper**

Create `src/runtime/ui/ascii-font.tsx`:

```tsx
import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/**
 * The seven glyph sets `@opentui/core@0.4.5` ships (`lib/ascii.font.d.ts:3`), declared locally
 * rather than re-exported so an OpenTUI upgrade changes this adapter and not one saved page (§6).
 * Omitting `font` leaves OpenTUI's own default, `tiny`.
 */
export type AsciiFontName = "tiny" | "block" | "shade" | "slick" | "huge" | "grid" | "pallet";

/** Props for the `AsciiFont` display text. `id` is the mandatory stable id (§3.2). */
export interface AsciiFontProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  /**
   * The string to draw. REQUIRED, where upstream's is optional: a banner with no text renders
   * nothing, and a silently empty element in an authored page reads as a broken render.
   */
  readonly text: string;
  /** Which glyph set to draw with; omitted leaves OpenTUI's `tiny`. */
  readonly font?: AsciiFontName;
  /**
   * The glyph hue; defaults to the theme's `foreground`.
   *
   * DESIGN GAP, RECORDED RATHER THAN GUESSED (CLAUDE.md): the project's design system contains
   * no ASCII-banner screen — `design/*.dc.html` and `design/termcraft-engine.js` have none — so
   * there is no design hue to take. The default is therefore the CATALOG's own established one
   * (`Text` defaults to `foreground` too), not an invented accent.
   *
   * DELIBERATE OMISSION: upstream also accepts an ARRAY of colours for a per-row gradient. §6.1
   * asks for a display-text wrapper, not a gradient API, and nothing in the design system would
   * pick the stops. Adding it later is additive.
   */
  readonly color?: Color;
  /** The fill behind the glyph block. Read one off `useTokens()` (spec §4.5). */
  readonly background?: Color;
}

/**
 * Large ASCII-art display text (design-system §6.1). Renders one OpenTUI `ascii-font` element,
 * sized by the chosen glyph set rather than by width/height props — upstream `Omit`s both
 * (`@opentui/core/renderables/ASCIIFont.d.ts:7`), so wrap it in a `Box` when it needs to be
 * placed or constrained. The mandatory `id` resolves for host geometry: unlike the inline text
 * family, this is a real layout `Renderable`.
 */
export function AsciiFont(props: AsciiFontProps) {
  return (
    <ascii-font
      id={props.id}
      text={props.text}
      font={props.font}
      color={props.color ?? activeTokens().foreground}
      backgroundColor={props.background}
    />
  );
}
```

- [ ] **Step 4: Append the facade exports**

At the end of `src/runtime/index.ts`:

```ts
// Display text (§6.1).
export { AsciiFont } from "./ui/ascii-font";
export type { AsciiFontProps, AsciiFontName } from "./ui/ascii-font";
```

- [ ] **Step 5: Bump the corpus canary 951 → 953**

`src/gate/model/lexer.test.ts` — extend the running comment and the assertion:

```
    // Task 6 adds `runtime/ui/ascii-font.tsx` and its own `ascii-font.test.tsx`, taking it to 953.
```

```ts
    expect(files.length).toBe(953);
```

`src/gate/model/lexer.oracle.test.ts:556` — the title becomes `the repository's own 953 sources`.

- [ ] **Step 6: Regenerate and run**

Run: `bun run gen:runtime-dts`
Run: `bun x tsc --noEmit` → silent.
Run: `bun test src/runtime/` → PASS.
Run: `bun test src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts` → PASS.

If "an explicit Color paints the glyphs in that hue" fails, capture the frame and look at which
channel the glyphs actually use — the `block`/`shade` sets paint solid cells and could land in
`bg`. Keep `font="tiny"` (line glyphs, `fg`) and assert the channel the frame really carries,
recording it in a comment. Do **not** delete the colour assertion.

- [ ] **Step 7: Commit**

```bash
rtk git add src/runtime/ui/ascii-font.tsx src/runtime/ui/ascii-font.test.tsx src/runtime/index.ts src/runtime/generated src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts
rtk git commit -m "feat(runtime): AsciiFont display-text wrapper (spec §6.1)"
```

---

### Task 7: Facade contract, agent documentation, architecture docs

**Files:**
- Modify: `src/runtime/index.test.ts` (append two tests)
- Modify: `docs/architecture/modules.md`, `docs/architecture/modules.ru.md`
- Regenerate: `src/runtime/generated/**`

**Interfaces:**
- Consumes: every export added by Tasks 1–6.
- Produces: nothing new — this task proves the surface and updates the docs the repository
  requires (CLAUDE.md, "Architecture docs maintenance").

- [ ] **Step 1: Write the failing facade tests**

Append to `src/runtime/index.test.ts`, inside the existing `describe` (do **not** rewrite the
existing 14-name catalog list — see the append-only rule):

```ts
  test("exports the §6.1 inline text family and the display-text wrapper", () => {
    for (const name of [
      "Span",
      "Bold",
      "Italic",
      "Underline",
      "Link",
      "LineBreak",
      "AsciiFont",
    ] as const) {
      // See the rationale on the first loop above: tsc already validates `name`.
      // oxlint-disable-next-line import/namespace
      expect(typeof runtime[name]).toBe("function");
    }
  });

  test("the generated prompt declaration carries the §6.1/§6.2 additions with their docs", () => {
    const dts = readFileSync(
      new URL("./generated/runtime.generated.d.ts", import.meta.url),
      "utf8",
    );
    // The agent's own component documentation IS this file's doc comments (spec §6.4).
    for (const symbol of [
      "function Span",
      "function Bold",
      "function Italic",
      "function Underline",
      "function Link",
      "function LineBreak",
      "function AsciiFont",
      "type AsciiFontName",
      "type Dimension",
      "type BorderSide",
      "interface BorderGlyphs",
    ]) {
      expect(dts).toContain(symbol);
    }
    // The Box expansion, sampled at three props that did not exist before plan P6.
    expect(dts).toContain("borderStyle?:");
    expect(dts).toContain("bottomTitleAlign?:");
    expect(dts).toContain("alignSelf?:");
    // And the family contract an authoring agent must read.
    expect(dts).toContain("only valid inside a `Text`");
  });
```

- [ ] **Step 2: Run to verify the state**

Run: `bun test src/runtime/index.test.ts`
Expected: the first test PASSES already (Tasks 3–6 exported everything). The second may FAIL on
`"only valid inside a `Text`"` if the module doc comment was flattened away — if so, move that
sentence into `SpanProps`'s own doc comment (the generator keeps per-declaration comments and
drops file-level ones) and re-run. This is the point of the assertion: the agent-facing
documentation must actually reach the agent, not merely exist in the source.

- [ ] **Step 3: Regenerate the declaration one final time**

Run: `bun run gen:runtime-dts`
Run: `rtk git status --short src/runtime/generated` → clean (Tasks 1–6 each regenerated; a
modification here means one of them skipped its step).

- [ ] **Step 4: Update the architecture docs**

In `docs/architecture/modules.md`, the `src/runtime/ui/` bullet currently opens "14 components —
primitive, row, column, panel, separator, spacer, text, button, input, tabs, list, table, gauge,
sparkline". Replace that opening with "**21 components in 16 modules** — primitive, row, column,
panel, separator, spacer, text, button, input, tabs, list, table, gauge, sparkline, inline (six:
`Span`, `Bold`, `Italic`, `Underline`, `Link`, `LineBreak`), ascii-font" — 14 modules today plus
`inline.tsx` and `ascii-font.tsx`, and 14 components plus the seven this plan adds. Then append
one sentence:

```
Plan P6 adds the spec §6.1 inline text family (`Span`, `Bold`, `Italic`, `Underline`, `Link`,
`LineBreak` — all six in `ui/inline.tsx`, valid only inside a `Text`, and carrying ids that are
stable but NOT resolvable by the host's `rectOf`/`checkHit`, because a `TextNodeRenderable` has
no layout box) and `AsciiFont` (`ui/ascii-font.tsx`, a real layout renderable whose id does
resolve); `Box` grows from ten props to the full §6.2 layout surface — border style and custom
glyphs, per-side borders, top/bottom titles with alignment, absolute positioning with offsets and
`zIndex`, margin, min/max sizing, overflow, `flexShrink`/`flexBasis`/`flexWrap`, `alignSelf`, and
percentage/`auto` sizes.
```

Mirror the same edit in `docs/architecture/modules.ru.md` (Russian prose, same facts, same file
paths and identifiers untranslated).

- [ ] **Step 5: Verify the docs claim matches the code**

Run: `rtk git diff --stat docs/architecture` → both files changed.
Count the `src/runtime/ui/*.tsx` non-test modules and confirm the number written in the docs
matches: `ls src/runtime/ui/*.tsx | grep -v test | wc -l` → **16**. If it is not 16, the docs
sentence is wrong — fix the sentence, never the count.

- [ ] **Step 6: Commit**

```bash
rtk git add src/runtime/index.test.ts src/runtime/generated docs/architecture
rtk git commit -m "docs(runtime): facade contract and architecture docs for the P6 wrappers"
```

---

## Final verification

Run each of these and read the actual output before claiming the plan is complete
(`superpowers:verification-before-completion`). The suites are separate commands on purpose:
`src/ui` and `src/entrypoint` render tests produce random failures when combined under load
(spec §11), and `bun test` alone can die in `Bun.Transpiler` without printing a single `(fail)`
line — `scripts/run-tests.ts` is the whole-suite gate that turns that into a loud third outcome.

- [ ] **Type check.** `bun x tsc --noEmit` → silent.
- [ ] **Declaration is fresh.** `bun run gen:runtime-dts` then
      `rtk git status --short src/runtime/generated` → no modification.
- [ ] **Runtime.** `bun test src/runtime/` → pass. This is the plan's own suite: 8 wrappers ×
      (render + export-determinism), plus the Box border and layout blocks and the inline
      id/geometry pin.
- [ ] **Gate** (the corpus canary and the fixtures that compile against the regenerated
      declaration): `bun test src/gate/` → pass. A canary mismatch means a file was added or
      removed without bumping BOTH `lexer.test.ts` and `lexer.oracle.test.ts`.
- [ ] **Host** (`src/host/render`'s harness is what every test here drives):
      `bun test src/host/` → pass.
- [ ] **Agent prompt** (`runtime-docs`/`runtime-authoring-guide` read the regenerated
      declaration): `bun test src/agent/` → pass. **If it fails, do not rewrite the authoring
      guide** — that rewrite is P4's (spec §10 Track A) and touching it here collides at the
      merge. A failure means the generated declaration changed shape, not that the guide is wrong.
- [ ] **Shell render tests, separately:** `bun test src/ui/` → pass. Then
      `bun test src/entrypoint/` → pass. Never as one command.
- [ ] **Whole suite through the crash gate:** `bun run test` → exits 0. Exit 2 is a CRASH, never
      a pass; re-run once to get a verdict (a crashed run prints no `(fail)` lines and reads as
      clean).
- [ ] **Lint and format:** `bun run lint && bun run fmt:check` → clean.
- [ ] **Reatom audit.** This plan adds no atom, computed, action or `reatomComponent`. Per
      CLAUDE.md, `/reatom-audit` is skipped **only** if that stayed true — confirm with
      `rtk git diff --stat` that no new Reatom primitive was introduced; if one was, run it.
- [ ] **Spec §6 compliance sweep, by eye, before review.** For each of the eight components:
      `id` mandatory; every colour prop typed `Color` with a `@ts-expect-error` test proving a
      token name fails; no `on*` prop; no `style`/`ref`/`renderBefore`/`renderAfter`/`buffered`/
      `live`/`selectable`/`focusable` passthrough; no `{...props}` spread; no
      `import … from "@opentui/…"` inside any `*Props` interface;
      `rtk git diff src/runtime/index.ts` shows appended lines only.
- [ ] **Code review:** `superpowers:requesting-code-review` before offering the worktree for
      merge.

## What this plan deliberately leaves out, and for whom

Each of these is a spec-sanctioned boundary, not an oversight. Listed so the executor does not
pull another plan's work in, and so the reviewer at the merge can check them off.

1. **The authoring guide still describes the old layout/colour vocabulary.**
   `src/agent/prompt/model/runtime-authoring-guide.md` is **P4**'s (spec §10 Track A). The eight
   new components document themselves through their JSDoc → `runtime.generated.d.ts`, which is
   staged into every turn workspace as `runtime.d.ts` (`src/agent/prompt/model/runtime-docs.ts`).
2. **`extend()` and the `OpenTUIComponents` module augmentation are not here.** `Slider`,
   `ScrollBar`, `TextTable` and `FrameBuffer` need them; all eight components in this plan render
   real intrinsic tags. That work is **P5**'s (spec §6.1).
3. **`Select`, `Textarea`, `ScrollBox` are not here** (**P7**), nor `Code`/`Markdown` (**P8**) nor
   `Diff`/`LineNumber` (**P9**). §6.3's *internal-state* clause targets those, which is why this
   plan's determinism tests assert mode-invariance rather than a reset scroll offset.
4. **Inline ids are not host-addressable.** Recorded in `ui/inline.tsx` and pinned by a test
   (decision **D3**). Making `describe`/`layoutTree` walk text nodes is a host-side change, not a
   runtime one, and no plan in spec §10.1 owns it — it is a gap to raise at the closeout, not to
   fix here.
5. **`Box` exposes no per-side margin/padding, no `position: "static"`, no
   `shouldFill`/`focusable`/`focusedBorderColor`/`rowGap`/`columnGap`.** §6.2 names none of them;
   each is additive later.
6. **`Span` has no `bg`, and `AsciiFont` no gradient colour array.** Decisions **D4** and **D7**,
   both additive.
