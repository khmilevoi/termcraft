# P5 — Wrappers: renderables without intrinsic tags (Track B, Wave 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Load `/reatom` and `/errore` before any code-related
> action (CLAUDE.md mandate). Every task ends green — `bun x tsc --noEmit` silent, `bun run lint`
> clean, and the named suites passing — and is one commit.

**Goal:** Add the four `@termcraft/runtime` wrappers whose OpenTUI renderables have **no intrinsic
JSX tag** — `Slider`, `ScrollBar`, `TextTable`, `FrameBuffer` — together with the one-time
`extend({…})` tag registration and the `declare module "@opentui/react"` augmentation that makes
those tags type-check with real props instead of `any`
(`docs/superpowers/specs/2026-08-11-project-design-systems-design.md` §6, §6.1, §6.3, §6.4).

**Architecture:** `@opentui/react`'s `extend({…})` registers a renderable constructor under a JSX
tag name. termcraft calls it **once, on its own side**, from `src/runtime/ui/renderable-tags.ts`;
authored pages never see `extend()`. The `OpenTUIComponents` interface carries a string index
signature, so an `extend()`-registered tag type-checks with `any` props whether or not
registration happened — the fix is a `declare module "@opentui/react"` augmentation naming each
tag's constructor (the vendor's own pattern, `node_modules/@opentui/react/src/time-to-first-draw.d.ts`).
That augmentation lives in the paired declaration file `src/runtime/ui/renderable-tags.augmentation.d.ts`
(see D2 for why it is a second file). Each wrapper is a plain function component that declares its
own prop interface, resolves colour defaults off `activeTokens()`, forwards handlers through
Reatom's `wrap`, and passes **no** `style`/`ref`/`renderBefore`/`renderAfter`/`treeSitterClient`/
`buffered`/`live` and no raw `Renderable` to its caller.

**Tech Stack:** Bun 1.3, TypeScript 7 (`bun x tsc --noEmit`), `@opentui/core@0.4.5`,
`@opentui/react@0.4.5`, Reatom v1001 (`@reatom/core@1001`), `bun:test` + the headless render
harness (`src/host/render/model/renderer.ts`), oxlint/oxfmt.

## Global Constraints

- **Scope fence.** Only `src/runtime/ui/**`, `src/runtime/index.ts` (append-only),
  `src/runtime/index.test.ts` (append-only), `src/runtime/generated/**` (regenerated, never
  hand-edited), `src/gate/model/lexer.test.ts` + `src/gate/model/lexer.oracle.test.ts` (corpus
  canary only), `src/agent/prompt/model/runtime-authoring-guide.md` (append-only section), and
  `docs/architecture/modules.md`. **No** Gate production code, **no** host code, **no** manifest
  work, **no** `Box` layout expansion (that is P6), **no** `Select`/`Textarea`/`ScrollBox` (P7),
  **no** `Code`/`Markdown`/`Diff`/`LineNumber` (P8/P9). `examples/**` is never edited (spec §9).
- **P1 is merged.** `src/runtime/types.ts` already declares `export type Color = \`#${string}\``,
  `TokenMap`, and the widened `ThemeId`; `src/runtime/model/tokens.ts` already exports
  `activeTokens(): TokenMap`. Read those two files before writing any wrapper. Do **not**
  re-declare or re-derive a colour type.
- **Every wrapper, without exception (spec §6).** A mandatory `id: string`. Colours typed `Color`
  (never a token *name*, never an `@opentui` `ColorInput`). Event handlers forwarded through
  Reatom's `wrap`. No passthrough of `style`, `ref`, `renderBefore`/`renderAfter`,
  `treeSitterClient`, `buffered`/`live`, or the underlying `Renderable`. **No `@opentui/*` type
  appears in any exported declaration** — not in a prop interface, not in a return type, not in an
  exported helper's signature. `@opentui` types may be used inside function bodies and in
  non-exported helpers only.
- **Spike-pinned constructor facts (spec §6.1) — honour these, do not re-derive them.**
  `orientation` is **required** on `Slider` and on `ScrollBar`. `FrameBuffer` requires
  `width`/`height` and **renders nothing until drawn into via its instance**. `ScrollBar` takes
  **no children**. `TextTable` cells are `TextChunk[]`, **not** strings.
- **Design is a source of truth (CLAUDE.md).** Colour and glyph defaults come from
  `design/termcraft-engine.js` (the `pal` object, and the `scrollbar()` draw method at line 1478)
  or from an existing catalog component that already took its values from there. Where the design
  does not cover a case, or cannot be reproduced 1:1, the wrapper carries a **code comment stating
  the divergence** — never a silently invented value. D5–D8 below fix each of these decisions once.
- **Module layout (CLAUDE.md).** Wrappers live in `src/runtime/ui/`. `src/runtime/types.ts` holds
  the module's shared types; `src/runtime/index.ts` is the public entry point. Cross-module imports
  use aliases (`host/render/model/renderer`), never a relative climb out of `src/runtime`.
  Relative imports (`../model/tokens`, `./renderable-tags`) stay inside `src/runtime`.
- **Imports.** `verbatimModuleSyntax: true` — every type-only import is `import type`. oxlint
  enforces `sort-imports` (member sort inside `{ … }`), `import/first`,
  `import/newline-after-import`, `import/no-duplicates`, `import/no-cycle`.
- **errore.** No `throw` for expected failures. Nothing in this plan performs I/O, so no new
  tagged error type is introduced. No `let` + reassignment: use `const` chains, ternaries, or an
  IIFE with early returns.
- **Reatom.** Handlers are forwarded with `wrap(fn)` from `../model/reatom` (the facade re-export
  of `@reatom/core`'s `wrap`). No atoms, computeds or actions are created by this plan; the
  wrappers only *read* `activeTokens()` and `isExport()`, exactly as the existing fourteen do.
- **Declaration regeneration.** Any change to `src/runtime`'s public surface invalidates
  `src/runtime/generated/runtime-dts.ts` and `runtime.generated.d.ts`;
  `src/runtime/generated/runtime-dts.test.ts` fails on the drift. Every task that touches the
  surface runs `bun run gen:runtime-dts` **before** its tests, and commits the regenerated files.
- **Corpus canary.** Every added `.ts`/`.tsx`/`.d.ts` file under `src/` bumps the exact file count
  asserted in `src/gate/model/lexer.test.ts` (`expect(files.length).toBe(…)`, currently **949**)
  and the same number quoted in `src/gate/model/lexer.oracle.test.ts`'s test title (`"the
  repository's own 949 sources: …"`). The walk's regex is `/\.(ts|tsx|mts|cts)$/`, so a `.d.ts`
  file **counts**. Each task below states its own delta. On a merge conflict against a sibling B
  plan, **re-derive** the number by running the test and reading the failure — never guess.
- **Test-command split.** `src/ui` and `src/entrypoint` render tests must run as SEPARATE
  `bun test` commands — a combined run produces random failures under load (spec §11). This plan
  adds no test under either, but the final verification honours the split.
- **Merge discipline across parallel B plans (spec §10.1).** Three files are shared collision
  surfaces: `src/runtime/index.ts` (each plan **appends** exports at the end of the file),
  `src/runtime/generated/*` (never text-merged — the orchestrator reruns `bun run
  gen:runtime-dts` after each merge), and the agent-facing documentation (append-only section,
  D9). Two more this plan touches: the corpus canary above, and `docs/architecture/modules.md`'s
  catalog bullet. Never reorder or reformat an existing line in any of them.
- **Commits.** One commit per task, conventional-commit subject. Use `rtk git …`. If the message
  is multi-line, write it to a scratch file and pass `-F <path>` (`rtk git commit` swallows
  heredoc stdin).

---

## Decisions made here, with their reasons

These are the choices the spec leaves to the implementation. They are settled here so no task has
to re-litigate them.

**D1 — the four tags are `slider`, `scroll-bar`, `text-table`, `frame-buffer`.** Kebab-case for
multi-word names is OpenTUI's own convention for its intrinsics (`ascii-font`, `tab-select`,
`line-number` in `node_modules/@opentui/react/src/components/index.d.ts`). No termcraft prefix: the
tag names live only inside `src/runtime/ui/`, never in an authored page, so a prefix would buy
nothing and diverge from the surrounding vocabulary.

**D2 — the `declare module "@opentui/react"` augmentation is a PAIRED `.d.ts` file, not a block
inside `renderable-tags.ts`. This is a stated divergence from §6.1's "colocated", and it is
forced.** `scripts/gen-runtime-dts.ts` emits declarations for every file in
`src/runtime/index.ts`'s import graph and **flattens them into one `declare module
"@termcraft/runtime" { … }` block** (`flattenChunk`/`buildDeclaration`). A module augmentation
sitting in a `.ts` file emits into that file's `.d.ts` verbatim, so flattening would (a) strip its
`declare` and drop `module "@opentui/react" { … }` — a nested ambient module declaration, which is
invalid — inside the facade block, and (b) hoist `import { SliderRenderable, … } from
"@opentui/core"` into the ambient block, leaking an `@opentui` identity into the *agent-facing*
prompt copy, which is precisely what §6 exists to prevent. Putting the augmentation in a `.d.ts`
avoids both: tsc emits **no output** for a `.d.ts` input, so `collectEmitted` never sees it. The
augmentation still takes effect where it matters, because the repo tsconfig's `include: ["src"]`
puts it in the `bun x tsc --noEmit` program, and a module augmentation applies program-wide.
Colocation is preserved as far as it can be: same directory, paired basename. The divergence is
recorded in a comment at the top of both files.

**D3 — `registerRenderableTags()` is an idempotent named function called as the FIRST statement of
each wrapper's component body, not a module-scope side effect.** React creates host instances
during commit, *after* the component function has run, so a call in the body is provably ordered
before `createInstance` reaches `getComponentCatalogue()`. A module-scope call would also work but
makes `src/runtime/ui/*` import-order-sensitive for no gain, and the repository has no other
module-scope side effect in the facade. The function guards on a module-level boolean so `extend()`
runs once per process.

**D4 — the wrappers are STATELESS BY CONSTRUCTION, which is how §6.3 is satisfied.** §6.3 requires
a defined static state under `hostMode: "export"` — scroll offset 0, nothing focused, value taken
from props rather than internal state. Rather than branch on `isExport()`, every wrapper here takes
the state as a **required prop** (`Slider.value`, `ScrollBar.position`, `TextTable.rows`,
`FrameBuffer.draw`) and exposes **no `focused` prop at all**, so preview and export render
identically. Each export-determinism test asserts exactly that — the export frame is byte-identical
to the preview frame for the same props — which is a stronger claim than "export looks static".
The one genuine exception is `TextTable`: `TextTableRenderable` defaults `selectable: true` and
keeps its own `_lastLocalSelection`, so the wrapper passes `selectable: false` unconditionally
(D8).

**D5 — `Slider`'s default colours are the `Gauge`'s, and the design gap is flagged.** The design
system has **no standalone slider**. Its nearest covered element is the gauge
(`design/termcraft-engine.js`'s gauge draw, already implemented in `src/runtime/ui/gauge.tsx`):
fill in `accent`, track in `border`. `Slider` reuses that mapping — a design-derived value, not an
invented one — and its doc comment states plainly that the design does not cover a standalone
slider and that this is the closest faithful mapping. The thumb *size* follows OpenTUI's own
proportional rule (`viewPortSize` defaults to 10% of the range); no prop is exposed for it,
because naming that number in termcraft's vocabulary would be inventing a semantic the design does
not have.

**D6 — `ScrollBar`'s defaults come from `design/termcraft-engine.js`'s `scrollbar()` (line 1478),
with one stated divergence.** The design draws a `│` track in `line` and a `█`/`▀`/`▄` thumb in
`amberDim` (= the `accentDim` token), with **arrows off**. termcraft therefore defaults
`trackColor` to `line`, `thumbColor` to `accentDim`, and `showArrows` to `false`.
`SliderRenderable` paints its track as a solid `fillRect` background rather than a `│` glyph rule,
so the glyph half of the design cannot be reproduced 1:1 — the closest faithful mapping is track
**background** `line`, thumb **foreground** `accentDim`, and that divergence is documented in the
wrapper's doc comment.

**D7 — `ScrollBar` is modelled on content/viewport/position, and the props are emitted in that
order for a measured reason.** `ScrollBarOptions` carries only `orientation`/`showArrows`/
`arrowOptions`/`trackOptions`/`onChange`; `scrollSize`, `viewportSize` and `scrollPosition` are
**setters**, applied by `@opentui/react`'s reconciler through its `default: instance[propKey] =
propValue` arm in `setInitialProperties`, which iterates `for (const propKey in props)` — i.e. in
JSX insertion order. `scrollPosition`'s setter clamps against `scrollSize - viewportSize`, so a
position written before its bounds clamps to 0. The wrapper therefore writes `scrollSize`, then
`viewportSize`, then `scrollPosition`, and says why in a comment.

**D8 — `TextTable` owns its own cell vocabulary; `TextChunk` never reaches the public surface.**
The spike pinned that cells are `TextChunk[]`, not strings. termcraft declares
`TextTableSpan` (`text` + optional `Color` fg/bg + `bold`/`italic`/`underline`) and
`TextTableCell = string | readonly TextTableSpan[]`, and converts to `TextChunk[]` inside a
non-exported helper using `@opentui/core`'s own `fg`/`bg`/`bold`/`italic`/`underline` chunk
builders — never a hand-constructed `{ __isChunk: true }` literal. Borders default **off**: the
design's tables are borderless column layouts (which is what the existing `src/runtime/ui/table.tsx`
implements); when `borders` is enabled the style is `single` in the `border` token, matching every
frame the design engine draws. `selectable` is forced `false` (D4). `TextTableRenderable`'s own
defaults are a hardcoded `#FFFFFF` for `borderColor` and `fg` — the wrapper **always** overrides
both from the active theme, so no raw white can reach a frame.

**D9 — the agent-facing entry (§6.4) is an append-only section at the END of
`src/agent/prompt/model/runtime-authoring-guide.md`.** That guide today documents no component
individually — the catalog reaches the agent as the generated `runtime.d.ts`, which every wrapper's
doc comment flows into automatically. §6.4 still asks for one entry per element, so this plan
creates a final `## Element catalog additions` section and appends one bullet per wrapper; sibling
B plans append their bullets to the same list. The bullets deliberately say **nothing about the
colour model** — the guide's existing "Colors are semantic token names … never raw hex" paragraph
is wrong under the new model and P4 (Track A) rewrites it; touching it here would collide with P4
and with every other B plan.

**D10 — `FrameBuffer` draws through an INTERNAL callback ref, and `ref` is never a wrapper prop.**
`FrameBufferRenderable` exposes its `OptimizedBuffer` only as an instance field, and the spike
pinned that it renders nothing until drawn into via its instance. §6 forbids *passing `ref`
through* to a page; it does not forbid the wrapper using one internally, and there is no other
handle. The wrapper attaches an inline callback ref, wraps the page's `draw` callback in a
termcraft-owned `FrameBufferSurface` (`Color`-typed, cell-clamped), and never exposes the
renderable. Because the inline ref's identity changes every render, React re-invokes it on every
re-render, so a token change repaints. **Fallback if the callback ref does not fire** (verify in
Task 5, Step 2): register a termcraft-owned `class TermcraftFrameBufferRenderable extends
FrameBufferRenderable` with a `draw` setter under the `frame-buffer` tag instead, and point the
augmentation at that class — same public prop surface, no ref.

---

## File Structure

Created:

| File | Responsibility |
| --- | --- |
| `src/runtime/ui/renderable-tags.ts` | The one-time idempotent `extend({…})` registration of the four tags. Exports `registerRenderableTags()`. No JSX, no props. |
| `src/runtime/ui/renderable-tags.augmentation.d.ts` | The `declare module "@opentui/react"` augmentation naming each tag's constructor. Types only; emits nothing. |
| `src/runtime/ui/renderable-tags.test.tsx` | Proves registration is live (the mounted instance's real constructor name) and that the augmentation restores real prop checking (a `@ts-expect-error` probe). |
| `src/runtime/ui/slider.tsx` | `SliderProps` + `Slider`. |
| `src/runtime/ui/slider.test.tsx` | Render test + export-determinism test. |
| `src/runtime/ui/scroll-bar.tsx` | `ScrollBarProps` + `ScrollBar`. |
| `src/runtime/ui/scroll-bar.test.tsx` | Render test + export-determinism test. |
| `src/runtime/ui/text-table.tsx` | `TextTableSpan`/`TextTableCell`/`TextTableProps` + `TextTable`. |
| `src/runtime/ui/text-table.test.tsx` | Render test + export-determinism test. |
| `src/runtime/ui/frame-buffer.tsx` | `FrameBufferSurface`/`FrameBufferProps` + `FrameBuffer`. |
| `src/runtime/ui/frame-buffer.test.tsx` | Render test + export-determinism test. |

Modified (all append-only unless stated):

- `src/runtime/index.ts` — four export pairs appended at the end.
- `src/runtime/index.test.ts` — four names appended to the catalog list.
- `src/runtime/generated/runtime-dts.ts`, `runtime.generated.d.ts` — regenerated, never hand-edited.
- `src/gate/model/lexer.test.ts`, `src/gate/model/lexer.oracle.test.ts` — corpus count.
- `src/agent/prompt/model/runtime-authoring-guide.md` — new final section + bullets.
- `docs/architecture/modules.md` — the catalog bullet at ~line 233 (Task 6).

Total new files: **11** → corpus canary goes 949 → **960**.

---

## Task 1: Tag registration and the `@opentui/react` augmentation

**Files:**
- Create: `src/runtime/ui/renderable-tags.ts`
- Create: `src/runtime/ui/renderable-tags.augmentation.d.ts`
- Create: `src/runtime/ui/renderable-tags.test.tsx`
- Modify: `src/gate/model/lexer.test.ts` (count 949 → 952), `src/gate/model/lexer.oracle.test.ts`
  (test title 949 → 952)
- Modify: `src/agent/prompt/model/runtime-authoring-guide.md` (append the empty section header)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `registerRenderableTags(): void` from `./renderable-tags`, and the JSX tags
  `slider`, `scroll-bar`, `text-table`, `frame-buffer` typed against `SliderRenderable`,
  `ScrollBarRenderable`, `TextTableRenderable`, `FrameBufferRenderable` respectively. Tasks 2–5
  each call `registerRenderableTags()` as the first statement of their component body.

- [ ] **Step 1: Write the failing test**

Create `src/runtime/ui/renderable-tags.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { registerRenderableTags } from "./renderable-tags";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

describe("renderable tag registration (spec §6.1)", () => {
  test("registerRenderableTags is idempotent", () => {
    registerRenderableTags();
    registerRenderableTags();
    expect(registerRenderableTags()).toBeUndefined();
  });

  test("each registered tag mounts its real OpenTUI renderable", async () => {
    registerRenderableTags();
    const handle = await createHeadlessRenderer({ w: 20, h: 6 });
    open = handle;
    handle.mount(
      <box id="root">
        <slider id="probe-slider" orientation="horizontal" width={10} height={1} />
        <scroll-bar id="probe-scrollbar" orientation="vertical" width={1} height={4} />
        <text-table id="probe-table" width={10} height={1} />
        <frame-buffer id="probe-framebuffer" width={4} height={1} />
      </box>,
    );
    await handle.render();
    expect(handle.renderError()).toBeNull();
    // `describe(id).kind` is the mounted renderable's real constructor name
    // (`host/render/model/geometry.ts`), so this fails if `extend()` never ran — an
    // unregistered tag throws `Unknown component type` out of the reconciler instead.
    expect(handle.describe("probe-slider")?.kind).toContain("SliderRenderable");
    expect(handle.describe("probe-scrollbar")?.kind).toContain("ScrollBarRenderable");
    expect(handle.describe("probe-table")?.kind).toContain("TextTableRenderable");
    expect(handle.describe("probe-framebuffer")?.kind).toContain("FrameBufferRenderable");
  });

  test("the module augmentation restores real prop checking on an extended tag", () => {
    // WITHOUT `renderable-tags.augmentation.d.ts`, `OpenTUIComponents`' string index
    // signature makes EVERY extended tag type-check with `any` props (spec §6.1), and this
    // `@ts-expect-error` would itself become an error ("unused '@ts-expect-error'
    // directive") under `bun x tsc --noEmit`. `orientation` is REQUIRED on SliderRenderable.
    // @ts-expect-error — `orientation` is required; the augmentation is what makes that visible.
    const rejected = <slider id="unchecked" width={4} height={1} />;
    expect(rejected).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/runtime/ui/renderable-tags.test.tsx`
Expected: FAIL — `Cannot find module './renderable-tags'`.

- [ ] **Step 3: Write the augmentation declaration file**

Create `src/runtime/ui/renderable-tags.augmentation.d.ts`:

```ts
// The `declare module "@opentui/react"` augmentation for the four renderables that have no
// intrinsic JSX tag (spec §6.1). It is the vendor's own pattern — see
// `node_modules/@opentui/react/src/time-to-first-draw.d.ts`, which augments `OpenTUIComponents`
// exactly this way for its own extended tag.
//
// WHY IT EXISTS AT ALL. `OpenTUIComponents` carries a string index signature
// (`node_modules/@opentui/react/src/types/components.d.ts`), so an `extend()`-registered tag
// type-checks with `any` props whether or not registration ever happened. Without this file the
// four wrappers below would compile against nothing.
//
// WHY IT IS A SEPARATE `.d.ts` AND NOT A BLOCK INSIDE `renderable-tags.ts` (stated divergence
// from §6.1's "colocated", plan P5 D2). `scripts/gen-runtime-dts.ts` FLATTENS every emitted
// declaration in `src/runtime/index.ts`'s import graph into one `declare module
// "@termcraft/runtime" { … }` block. An augmentation emitted from a `.ts` file would land inside
// that block as a nested ambient module declaration (invalid), and would hoist
// `import { SliderRenderable, … } from "@opentui/core"` into the AGENT-FACING prompt copy —
// exactly the `@opentui` leak §6 exists to prevent. tsc emits no output for a `.d.ts` input, so
// this file is invisible to the generator while still applying program-wide under the repo
// tsconfig's `include: ["src"]`. Colocation is kept as far as it can be: same directory, paired
// basename with `renderable-tags.ts`.
import type {
  FrameBufferRenderable,
  ScrollBarRenderable,
  SliderRenderable,
  TextTableRenderable,
} from "@opentui/core";

declare module "@opentui/react" {
  interface OpenTUIComponents {
    slider: typeof SliderRenderable;
    "scroll-bar": typeof ScrollBarRenderable;
    "text-table": typeof TextTableRenderable;
    "frame-buffer": typeof FrameBufferRenderable;
  }
}
```

- [ ] **Step 4: Write the registration module**

Create `src/runtime/ui/renderable-tags.ts`:

```ts
import {
  FrameBufferRenderable,
  ScrollBarRenderable,
  SliderRenderable,
  TextTableRenderable,
} from "@opentui/core";
import { extend } from "@opentui/react";

// The one-time `extend({…})` registration for the four OpenTUI renderables that ship with no
// intrinsic JSX tag (spec §6.1). termcraft calls this on ITS OWN side; an authored page never
// sees `extend()` and never names an `@opentui/*` identity. The prop types the four tags check
// against come from the paired `./renderable-tags.augmentation.d.ts` — read its header for why
// the augmentation is a separate file.
//
// TAG NAMES follow OpenTUI's own intrinsic vocabulary (`ascii-font`, `tab-select`,
// `line-number`): kebab-case, unprefixed. They exist only inside `src/runtime/ui/`.

let registered = false;

/**
 * Register the four tagless renderables as JSX tags. Idempotent, and called as the FIRST
 * statement of each wrapper's component body rather than at module scope: React runs a component
 * function during render and creates its host instances during commit, so a call in the body is
 * provably ordered before the reconciler looks the tag up in `getComponentCatalogue()`, without
 * making `src/runtime/ui/*` import-order-sensitive.
 */
export function registerRenderableTags(): void {
  if (registered) return;
  registered = true;
  extend({
    slider: SliderRenderable,
    "scroll-bar": ScrollBarRenderable,
    "text-table": TextTableRenderable,
    "frame-buffer": FrameBufferRenderable,
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/runtime/ui/renderable-tags.test.tsx`
Expected: PASS (3 tests).

If the second test fails with `Unknown component type: scroll-bar`, the tag name in `extend()` and
the tag name in the JSX disagree — fix the pair, never the assertion. If a `kind` assertion fails
because the bundler renamed a class (e.g. `SliderRenderable2`), relax that one assertion to
`toContain("Slider")` and record the observed name in a comment; do **not** delete the assertion.

- [ ] **Step 6: Prove the augmentation is live under the real type checker**

Run: `bun x tsc --noEmit`
Expected: exit 0, no output. The third test's `@ts-expect-error` is only satisfied because the
augmentation gives `slider` real props — if the augmentation were missing or not picked up, tsc
would report `Unused '@ts-expect-error' directive` and this step fails.

- [ ] **Step 7: Prove the generator is unaffected**

Run: `bun run gen:runtime-dts`
Then run: `bun test src/runtime/generated/runtime-dts.test.ts`
Expected: the generator writes both artifacts and the drift test passes.

Then verify by inspection that neither generated artifact grew an `@opentui/core` import or a
nested module block:

Run: `rtk git --no-pager diff --stat src/runtime/generated/`
Expected: **no change at all** — this task adds no facade export, so both artifacts must be
byte-identical to their committed versions. If either changed, the augmentation or the registration
module leaked into the emit: re-read D2 before proceeding.

- [ ] **Step 8: Bump the corpus canary**

In `src/gate/model/lexer.test.ts`, append to the running comment above `expect(files.length)` and
change the number:

```ts
    // The project-design-systems P5 plan (renderable wrappers) Task 1 adds
    // `runtime/ui/renderable-tags.ts`, `runtime/ui/renderable-tags.augmentation.d.ts` and
    // `runtime/ui/renderable-tags.test.tsx`, taking it to 952.
    // — update BOTH this number and the count quoted in `lexer.oracle.test.ts` when the corpus
    // grows.
    expect(files.length).toBe(952);
```

In `src/gate/model/lexer.oracle.test.ts`, change the test title:

```ts
  test("the repository's own 952 sources: zero under-scans and zero refusals", () => {
```

- [ ] **Step 9: Add the (empty) agent-doc section**

Append to the very end of `src/agent/prompt/model/runtime-authoring-guide.md`:

```md
## Element catalog additions

Beyond the components named above, the runtime exposes these wrappers over OpenTUI's remaining
elements. `runtime.d.ts` alongside this file carries their exact prop types; every one takes a
mandatory `id`.
```

(The bullets themselves are added by Tasks 2–5, one each, appended to this list.)

- [ ] **Step 10: Run the gate suites and lint**

Run: `bun run test src/gate/model/lexer.test.ts`
Run: `bun run test src/runtime`
Run: `bun run lint && bun run fmt:check`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
rtk git add src/runtime/ui/renderable-tags.ts src/runtime/ui/renderable-tags.augmentation.d.ts src/runtime/ui/renderable-tags.test.tsx src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts src/agent/prompt/model/runtime-authoring-guide.md
rtk git commit -m "feat(runtime): register the four tagless OpenTUI renderables as JSX tags"
```

---

## Task 2: `Slider`

**Files:**
- Create: `src/runtime/ui/slider.tsx`
- Create: `src/runtime/ui/slider.test.tsx`
- Modify: `src/runtime/index.ts` (append), `src/runtime/index.test.ts` (append),
  `src/gate/model/lexer.test.ts` + `lexer.oracle.test.ts` (952 → 954),
  `src/agent/prompt/model/runtime-authoring-guide.md` (one bullet)

**Interfaces:**
- Consumes: `registerRenderableTags()` from `./renderable-tags`; `activeTokens(): TokenMap` from
  `../model/tokens`; `wrap` from `../model/reatom`; `Color` from `../types`.
- Produces: `export interface SliderProps` and `export function Slider(props: SliderProps)`, both
  re-exported from `src/runtime/index.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/runtime/ui/slider.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { Slider } from "./slider";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const THUMB = /[█▌▐]/;
const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const rowText = (frame: { rows: StyledRun[][] }, row: number): string =>
  (frame.rows[row] ?? []).map((run) => run.text).join("");

/** Mount one Slider into a fresh renderer, paint, and return the single captured row. */
async function renderSliderRow(value: number): Promise<{ text: string; runs: StyledRun[] }> {
  const handle = await createHeadlessRenderer({ w: 20, h: 1 });
  open = handle;
  handle.mount(
    <Slider id="s" orientation="horizontal" value={value} min={0} max={100} width={20} height={1} />,
  );
  await handle.render();
  expect(handle.renderError()).toBeNull();
  const frame = handle.capture();
  const captured = { text: rowText(frame, 0), runs: allRuns(frame) };
  handle.destroy();
  open = null;
  return captured;
}

describe("Slider (spec §6.1)", () => {
  test("paints a thumb in the fill hue over a track in the track hue", async () => {
    const { text, runs } = await renderSliderRow(50);
    expect(THUMB.test(text)).toBe(true);
    const thumb = runs.find((run) => THUMB.test(run.text));
    expect(thumb && extractRgb(thumb.fg)).toBe<string>(activeTokens().accent);
    expect(thumb && extractRgb(thumb.bg)).toBe<string>(activeTokens().border);
  });

  test("explicit colours override the theme defaults", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 1 });
    open = handle;
    handle.mount(
      <Slider
        id="s"
        orientation="horizontal"
        value={50}
        width={20}
        height={1}
        fillColor={activeTokens().success}
        trackColor={activeTokens().line}
      />,
    );
    await handle.render();
    const thumb = allRuns(handle.capture()).find((run) => THUMB.test(run.text));
    expect(thumb && extractRgb(thumb.fg)).toBe<string>(activeTokens().success);
  });

  test("a token NAME is not a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().accent`.
    const rejected = <Slider id="x" orientation="horizontal" value={1} fillColor="accent" />;
    expect(rejected).toBeDefined();
  });
});

describe("Slider export determinism (spec §6.3)", () => {
  test("the thumb position is a function of the prop value alone", async () => {
    const low = await renderSliderRow(0);
    const high = await renderSliderRow(100);
    expect(low.text.search(THUMB)).toBe(0);
    expect(high.text.search(THUMB)).toBeGreaterThan(low.text.search(THUMB));
    expect([...high.text].findLastIndex((char) => THUMB.test(char))).toBe(19);
  });

  test("the export frame is identical to the preview frame for the same props", async () => {
    hostModeAtom.set("preview");
    const preview = await renderSliderRow(37);
    hostModeAtom.set("export");
    const exported = await renderSliderRow(37);
    expect(exported.text).toBe(preview.text);
  });

  test("two independent export mounts of the same props render the same row", async () => {
    hostModeAtom.set("export");
    const first = await renderSliderRow(37);
    const second = await renderSliderRow(37);
    expect(second.text).toBe(first.text);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/runtime/ui/slider.test.tsx`
Expected: FAIL — `Cannot find module './slider'`.

- [ ] **Step 3: Write the wrapper**

Create `src/runtime/ui/slider.tsx`:

```tsx
import { wrap } from "../model/reatom";
import { activeTokens } from "../model/tokens";
import type { Color } from "../types";
import { registerRenderableTags } from "./renderable-tags";

/**
 * Props for the themed `Slider`. `id` is the mandatory stable id (§3.2); `orientation` is
 * REQUIRED by the underlying renderable's constructor (spec §6.1's spike), and `value` is
 * required because a slider's rendered state must come from props rather than from the
 * renderable's own mutable `_value` (spec §6.3).
 */
export interface SliderProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  readonly orientation: "horizontal" | "vertical";
  /** The current value, clamped by the renderable into `min`..`max`. */
  readonly value: number;
  /** Range floor; defaults to 0. */
  readonly min?: number;
  /** Range ceiling; defaults to 100. */
  readonly max?: number;
  /** The unfilled track hue. Read one off `useTokens()` (spec §4.5). Defaults to `border`. */
  readonly trackColor?: Color;
  /** The thumb hue. Read one off `useTokens()` (spec §4.5). Defaults to `accent`. */
  readonly fillColor?: Color;
  /** Track length in cells for a horizontal slider. */
  readonly width?: number;
  /** Track length in cells for a vertical slider. */
  readonly height?: number;
  /** Invoked with the new value when the slider is dragged; inert in the static render. */
  readonly onChange?: (value: number) => void;
}

/**
 * A draggable value track (spec §6.1). Renders the OpenTUI `SliderRenderable` — a renderable
 * with no intrinsic tag, registered by {@link registerRenderableTags} — as a solid track filled
 * with `trackColor` and a `█`/`▌`/`▐` thumb drawn in `fillColor` at half-cell precision.
 *
 * DESIGN GAP, FLAGGED RATHER THAN GUESSED (CLAUDE.md): the design system has NO standalone
 * slider. Its nearest covered element is the gauge (`design/termcraft-engine.js`'s gauge draw,
 * implemented in `./gauge.tsx`), which fills in `accent` over a track in `border`; those two
 * roles are reused here as the closest faithful mapping, not invented.
 *
 * The thumb's SIZE follows OpenTUI's own proportional rule (its `viewPortSize` defaults to 10% of
 * the range). No prop is exposed for it: naming that number in termcraft's vocabulary would mean
 * inventing a semantic the design does not have.
 *
 * DIVERGENCE, MEASURED: `SliderRenderable` captures `onChange` in its CONSTRUCTOR
 * (`_onChange = options.onChange`) and exposes no setter for it, so a handler whose identity
 * changes after mount keeps invoking the first one. The wrapper cannot fix that without reaching
 * the instance through a `ref`, which §6 forbids exposing; it is recorded here instead. The
 * interactive path is inert in the current static render either way.
 */
export function Slider(props: SliderProps) {
  registerRenderableTags();
  const tokens = activeTokens();
  const onChange = props.onChange;
  return (
    <slider
      id={props.id}
      orientation={props.orientation}
      value={props.value}
      min={props.min ?? 0}
      max={props.max ?? 100}
      width={props.width}
      height={props.height}
      backgroundColor={props.trackColor ?? tokens.border}
      foregroundColor={props.fillColor ?? tokens.accent}
      onChange={onChange === undefined ? undefined : wrap(onChange)}
    />
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/runtime/ui/slider.test.tsx`
Expected: PASS.

If `low.text.search(THUMB)` is not 0 or the last thumb index is not 19, read the actual row out of
the failure and check the arithmetic against
`node_modules/@opentui/core`'s `getVirtualThumbStart`/`getVirtualThumbSize` before touching the
expectation. Adjust an expectation only to a value you have derived from that source — never to
whatever the run happened to print.

- [ ] **Step 5: Append the facade export**

At the END of `src/runtime/index.ts` (append-only — sibling B plans append below you):

```ts
export { Slider } from "./ui/slider";
export type { SliderProps } from "./ui/slider";
```

And append `"Slider"` to the catalog name list in `src/runtime/index.test.ts`'s
`"exports the full 13-component design-system catalog + the low-level Box escape hatch"` test.
**Leave that test's (already stale) title alone** — renaming it would conflict with every other
B plan.

- [ ] **Step 6: Regenerate the declaration**

Run: `bun run gen:runtime-dts`
Run: `bun test src/runtime/generated/runtime-dts.test.ts src/runtime/index.test.ts`
Expected: PASS. Confirm the regenerated `runtime.generated.d.ts` now contains `interface
SliderProps` and `function Slider`, and still contains **no** `@opentui/core` import:

Run: `rtk grep -n "@opentui/core" src/runtime/generated/runtime.generated.d.ts` — expected: no
match.

- [ ] **Step 7: Bump the corpus canary**

`src/gate/model/lexer.test.ts`: 952 → **954**, with a comment line naming
`runtime/ui/slider.tsx` and `runtime/ui/slider.test.tsx`.
`src/gate/model/lexer.oracle.test.ts`: test title 952 → **954**.

- [ ] **Step 8: Add the agent-doc bullet**

Append under `## Element catalog additions`:

```md
- `Slider` — a draggable value track. Required: `id`, `orientation` (`"horizontal"` |
  `"vertical"`), `value`. Optional `min`/`max` (0/100), `trackColor`/`fillColor`,
  `width`/`height`, `onChange(value)`. Its rendered position always comes from `value`, so an
  export snapshot is deterministic.
```

- [ ] **Step 9: Verify and commit**

Run: `bun x tsc --noEmit`
Run: `bun run test src/runtime`
Run: `bun run test src/gate/model/lexer.test.ts`
Run: `bun run lint && bun run fmt:check`

```bash
rtk git add src/runtime/ui/slider.tsx src/runtime/ui/slider.test.tsx src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts src/agent/prompt/model/runtime-authoring-guide.md
rtk git commit -m "feat(runtime): add the Slider wrapper"
```

---

## Task 3: `ScrollBar`

**Files:**
- Create: `src/runtime/ui/scroll-bar.tsx`
- Create: `src/runtime/ui/scroll-bar.test.tsx`
- Modify: `src/runtime/index.ts` (append), `src/runtime/index.test.ts` (append),
  `src/gate/model/lexer.test.ts` + `lexer.oracle.test.ts` (954 → 956),
  `src/agent/prompt/model/runtime-authoring-guide.md` (one bullet)

**Interfaces:**
- Consumes: `registerRenderableTags()`, `activeTokens()`, `wrap`, `Color` — as in Task 2.
- Produces: `export interface ScrollBarProps` and `export function ScrollBar(props: ScrollBarProps)`.

- [ ] **Step 1: Write the failing tests**

Create `src/runtime/ui/scroll-bar.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { ScrollBar } from "./scroll-bar";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const THUMB = /[█▀▄]/;
const rowsText = (frame: { rows: StyledRun[][] }): string[] =>
  frame.rows.map((row) => row.map((run) => run.text).join(""));
const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();

/** Mount one vertical ScrollBar into a fresh 1x10 renderer and return its ten rows. */
async function renderScrollBarRows(position: number): Promise<string[]> {
  const handle = await createHeadlessRenderer({ w: 1, h: 10 });
  open = handle;
  handle.mount(
    <ScrollBar
      id="sb"
      orientation="vertical"
      contentSize={100}
      viewportSize={10}
      position={position}
      width={1}
      height={10}
    />,
  );
  await handle.render();
  expect(handle.renderError()).toBeNull();
  const rows = rowsText(handle.capture());
  handle.destroy();
  open = null;
  return rows;
}

describe("ScrollBar (spec §6.1)", () => {
  test("paints a thumb in accentDim over a track in line", async () => {
    const handle = await createHeadlessRenderer({ w: 1, h: 10 });
    open = handle;
    handle.mount(
      <ScrollBar
        id="sb"
        orientation="vertical"
        contentSize={100}
        viewportSize={10}
        position={0}
        width={1}
        height={10}
      />,
    );
    await handle.render();
    const thumb = allRuns(handle.capture()).find((run) => THUMB.test(run.text));
    expect(thumb && extractRgb(thumb.fg)).toBe<string>(activeTokens().accentDim);
    expect(thumb && extractRgb(thumb.bg)).toBe<string>(activeTokens().line);
  });

  test("takes no children (spec §6.1 spike)", () => {
    // @ts-expect-error — ScrollBarRenderable is a leaf; the wrapper declares no `children`.
    const rejected = (
      <ScrollBar id="x" orientation="vertical" contentSize={10} viewportSize={5} position={0}>
        {"nope"}
      </ScrollBar>
    );
    expect(rejected).toBeDefined();
  });
});

describe("ScrollBar export determinism (spec §6.3)", () => {
  test("the thumb sits at the top for position 0 and lower for a larger position", async () => {
    const top = await renderScrollBarRows(0);
    const bottom = await renderScrollBarRows(90);
    const firstThumbRow = (rows: string[]): number => rows.findIndex((row) => THUMB.test(row));
    expect(firstThumbRow(top)).toBe(0);
    expect(firstThumbRow(bottom)).toBeGreaterThan(firstThumbRow(top));
  });

  test("the export frame is identical to the preview frame for the same props", async () => {
    hostModeAtom.set("preview");
    const preview = await renderScrollBarRows(40);
    hostModeAtom.set("export");
    const exported = await renderScrollBarRows(40);
    expect(exported).toEqual(preview);
  });

  test("arrows are off by default, matching the design's scrollbar", async () => {
    const rows = await renderScrollBarRows(40);
    expect(rows.join("")).not.toMatch(/[▲▼↑↓]/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/runtime/ui/scroll-bar.test.tsx`
Expected: FAIL — `Cannot find module './scroll-bar'`.

- [ ] **Step 3: Write the wrapper**

Create `src/runtime/ui/scroll-bar.tsx`:

```tsx
import { wrap } from "../model/reatom";
import { activeTokens } from "../model/tokens";
import type { Color } from "../types";
import { registerRenderableTags } from "./renderable-tags";

/**
 * Props for the themed `ScrollBar`. `id` is the mandatory stable id (§3.2); `orientation` is
 * REQUIRED by the underlying renderable's constructor, and the scroll state is required because
 * an export snapshot must render it from props rather than from the renderable's own mutable
 * offset (spec §6.3). There is deliberately NO `children`: the renderable is a leaf (spec §6.1's
 * spike).
 */
export interface ScrollBarProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  readonly orientation: "horizontal" | "vertical";
  /** The full scrollable extent, in cells. */
  readonly contentSize: number;
  /** The visible window's extent, in cells. */
  readonly viewportSize: number;
  /** The window's offset into the content, in cells; clamped to `0..contentSize - viewportSize`. */
  readonly position: number;
  /** The track hue. Read one off `useTokens()` (spec §4.5). Defaults to `line`. */
  readonly trackColor?: Color;
  /** The thumb hue. Read one off `useTokens()` (spec §4.5). Defaults to `accentDim`. */
  readonly thumbColor?: Color;
  /** Step arrows at both ends; OFF by default, matching the design's scrollbar. */
  readonly showArrows?: boolean;
  /** The arrow hue when `showArrows` is set. Defaults to `foregroundFaint`. */
  readonly arrowColor?: Color;
  readonly width?: number;
  readonly height?: number;
  /** Invoked with the new offset when the bar is dragged; inert in the static render. */
  readonly onScroll?: (position: number) => void;
}

/**
 * A proportional scroll indicator (spec §6.1). Renders the OpenTUI `ScrollBarRenderable` — a
 * renderable with no intrinsic tag, registered by {@link registerRenderableTags} — whose inner
 * track is a `SliderRenderable` drawing a `█`/`▀`/`▄` thumb at half-cell precision.
 *
 * COLOURS AND ARROWS COME FROM THE DESIGN (`design/termcraft-engine.js`'s `scrollbar()`): a track
 * in `line`, a thumb in `amberDim` (the `accentDim` role), arrows off.
 *
 * DIVERGENCE, DOCUMENTED RATHER THAN SUBSTITUTED (CLAUDE.md): the design draws the track as a
 * `│` glyph rule, while `SliderRenderable` paints its track as a solid background fill. The glyph
 * half cannot be reproduced through this renderable, so the closest faithful mapping is used —
 * track BACKGROUND `line`, thumb FOREGROUND `accentDim`.
 *
 * PROP ORDER IS LOAD-BEARING, and this is measured rather than assumed. `scrollSize`,
 * `viewportSize` and `scrollPosition` are not constructor options; `@opentui/react`'s
 * `setInitialProperties` applies them as plain property writes, iterating `for (const propKey in
 * props)` — i.e. in the order written below. `scrollPosition`'s setter clamps against
 * `scrollSize - viewportSize`, so a position written before its bounds would clamp to 0.
 *
 * The same constructor-captured-handler divergence recorded on `./slider.tsx` applies to
 * `onChange` here.
 */
export function ScrollBar(props: ScrollBarProps) {
  registerRenderableTags();
  const tokens = activeTokens();
  const track = props.trackColor ?? tokens.line;
  const onScroll = props.onScroll;
  return (
    <scroll-bar
      id={props.id}
      orientation={props.orientation}
      scrollSize={props.contentSize}
      viewportSize={props.viewportSize}
      scrollPosition={props.position}
      width={props.width}
      height={props.height}
      showArrows={props.showArrows ?? false}
      trackOptions={{
        backgroundColor: track,
        foregroundColor: props.thumbColor ?? tokens.accentDim,
      }}
      arrowOptions={{
        backgroundColor: track,
        foregroundColor: props.arrowColor ?? tokens.foregroundFaint,
      }}
      onChange={onScroll === undefined ? undefined : wrap(onScroll)}
    />
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/runtime/ui/scroll-bar.test.tsx`
Expected: PASS.

If the thumb's `bg` is not the track hue, check whether `ArrowRenderable`'s hidden cells are being
picked up instead — narrow the `find` to a run that also matches `THUMB`. If `firstThumbRow(top)`
is not 0, print the rows and check `updateSliderFromScrollState` in `@opentui/core` before changing
the expectation.

- [ ] **Step 5: Append the facade export**

At the END of `src/runtime/index.ts`:

```ts
export { ScrollBar } from "./ui/scroll-bar";
export type { ScrollBarProps } from "./ui/scroll-bar";
```

Append `"ScrollBar"` to the catalog name list in `src/runtime/index.test.ts`.

- [ ] **Step 6: Regenerate and verify the declaration**

Run: `bun run gen:runtime-dts`
Run: `bun test src/runtime/generated/runtime-dts.test.ts src/runtime/index.test.ts`
Confirm `runtime.generated.d.ts` gained `interface ScrollBarProps` and still has no
`@opentui/core` import.

- [ ] **Step 7: Bump the corpus canary**

`lexer.test.ts`: 954 → **956** with a naming comment; `lexer.oracle.test.ts` title 954 → **956**.

- [ ] **Step 8: Add the agent-doc bullet**

```md
- `ScrollBar` — a proportional scroll indicator; a leaf, it takes no children. Required: `id`,
  `orientation`, `contentSize`, `viewportSize`, `position` (all in cells). Optional
  `trackColor`/`thumbColor`/`arrowColor`, `showArrows` (off by default), `width`/`height`,
  `onScroll(position)`.
```

- [ ] **Step 9: Verify and commit**

Run: `bun x tsc --noEmit`
Run: `bun run test src/runtime`
Run: `bun run test src/gate/model/lexer.test.ts`
Run: `bun run lint && bun run fmt:check`

```bash
rtk git add src/runtime/ui/scroll-bar.tsx src/runtime/ui/scroll-bar.test.tsx src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts src/agent/prompt/model/runtime-authoring-guide.md
rtk git commit -m "feat(runtime): add the ScrollBar wrapper"
```

---

## Task 4: `TextTable`

**Files:**
- Create: `src/runtime/ui/text-table.tsx`
- Create: `src/runtime/ui/text-table.test.tsx`
- Modify: `src/runtime/index.ts` (append), `src/runtime/index.test.ts` (append),
  `src/gate/model/lexer.test.ts` + `lexer.oracle.test.ts` (956 → 958),
  `src/agent/prompt/model/runtime-authoring-guide.md` (one bullet)

**Interfaces:**
- Consumes: `registerRenderableTags()`, `activeTokens()`, `Color`.
- Produces: `export interface TextTableSpan`, `export type TextTableCell`,
  `export interface TextTableProps`, `export function TextTable(props: TextTableProps)`.

- [ ] **Step 1: Write the failing tests**

Create `src/runtime/ui/text-table.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { TextTable } from "./text-table";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const frameText = (frame: { rows: StyledRun[][] }): string =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");

const ROWS = [
  ["name", "cpu"],
  ["bun", "12%"],
] as const;

/** Mount one TextTable into a fresh renderer, paint, and return the whole frame's text. */
async function renderTableText(): Promise<string> {
  const handle = await createHeadlessRenderer({ w: 24, h: 4 });
  open = handle;
  handle.mount(<TextTable id="t" rows={ROWS} width={24} height={4} />);
  await handle.render();
  expect(handle.renderError()).toBeNull();
  const text = frameText(handle.capture());
  handle.destroy();
  open = null;
  return text;
}

describe("TextTable (spec §6.1)", () => {
  test("renders plain string cells in the foreground hue", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 4 });
    open = handle;
    handle.mount(<TextTable id="t" rows={ROWS} width={24} height={4} />);
    await handle.render();
    const frame = handle.capture();
    expect(frameText(frame)).toContain("name");
    expect(frameText(frame)).toContain("12%");
    const cell = allRuns(frame).find((run) => run.text.includes("name"));
    expect(cell && extractRgb(cell.fg)).toBe<string>(activeTokens().foreground);
  });

  test("a styled span carries its own Color", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 2 });
    open = handle;
    handle.mount(
      <TextTable
        id="t"
        rows={[[[{ text: "hot", color: activeTokens().danger }]]]}
        width={24}
        height={2}
      />,
    );
    await handle.render();
    const cell = allRuns(handle.capture()).find((run) => run.text.includes("hot"));
    expect(cell && extractRgb(cell.fg)).toBe<string>(activeTokens().danger);
  });

  test("borders are off by default and draw in the border token when enabled", async () => {
    expect(await renderTableText()).not.toMatch(/[┌┐└┘│]/);

    const handle = await createHeadlessRenderer({ w: 24, h: 6 });
    open = handle;
    handle.mount(<TextTable id="t" rows={ROWS} borders width={24} height={6} />);
    await handle.render();
    const border = allRuns(handle.capture()).find((run) =>
      /[┌┐└┘│─]/.test(run.text),
    );
    expect(border && extractRgb(border.fg)).toBe<string>(activeTokens().border);
  });

  test("a token NAME is not a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().border`.
    const rejected = <TextTable id="x" rows={ROWS} borderColor="border" />;
    expect(rejected).toBeDefined();
  });
});

describe("TextTable export determinism (spec §6.3)", () => {
  test("the export frame is identical to the preview frame for the same rows", async () => {
    hostModeAtom.set("preview");
    const preview = await renderTableText();
    hostModeAtom.set("export");
    const exported = await renderTableText();
    expect(exported).toBe(preview);
  });

  test("no selection back-fill can appear — selection is disabled", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 24, h: 4 });
    open = handle;
    handle.mount(<TextTable id="t" rows={ROWS} width={24} height={4} />);
    await handle.render();
    const filled = allRuns(handle.capture()).filter((run) => run.bg !== "default");
    expect(filled).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/runtime/ui/text-table.test.tsx`
Expected: FAIL — `Cannot find module './text-table'`.

- [ ] **Step 3: Write the wrapper**

Create `src/runtime/ui/text-table.tsx`:

```tsx
import { bg, bold, fg, italic, underline } from "@opentui/core";
import type { TextChunk } from "@opentui/core";

import { activeTokens } from "../model/tokens";
import type { Color, TokenMap } from "../types";
import { registerRenderableTags } from "./renderable-tags";

/** One styled run inside a table cell. Colours are `Color` values read off `useTokens()`. */
export interface TextTableSpan {
  readonly text: string;
  /** Text hue; defaults to the table's `textColor`. */
  readonly color?: Color;
  /** Cell-run back-fill. */
  readonly background?: Color;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
}

/**
 * A single cell: a plain string, or a run list when parts of it need their own style.
 * The underlying renderable takes styled runs and nothing else (spec §6.1's spike); the plain
 * string form is termcraft's own convenience over that, converted here.
 */
export type TextTableCell = string | readonly TextTableSpan[];

/** Props for the themed `TextTable`. `id` is the mandatory stable id (§3.2). */
export interface TextTableProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  /** Rows of cells, positional. A short row simply renders fewer columns. */
  readonly rows: readonly (readonly TextTableCell[])[];
  /** Draw a single-line grid. OFF by default — the design's tables are borderless. */
  readonly borders?: boolean;
  /** The grid hue when `borders` is set. Defaults to `border`. */
  readonly borderColor?: Color;
  /** The default cell text hue. Defaults to `foreground`. */
  readonly textColor?: Color;
  /** The table's back-fill. */
  readonly background?: Color;
  /** Cells between columns; defaults to 1, matching the design's table gutter. */
  readonly columnGap?: number;
  /** Wrapping inside a cell; defaults to `word`. */
  readonly wrap?: "none" | "char" | "word";
  /** Padding inside every cell. */
  readonly cellPadding?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Convert one span into the renderable's own chunk type through `@opentui/core`'s own chunk
 * builders — never a hand-constructed `{ __isChunk: true }` literal, which would be fabricating
 * a vendor internal. Non-exported on purpose: `TextChunk` must not reach the facade's surface
 * (spec §6).
 */
function toChunk(span: TextTableSpan, fallback: Color): TextChunk {
  const coloured = fg(span.color ?? fallback)(span.text);
  const filled = span.background === undefined ? coloured : bg(span.background)(coloured);
  const emboldened = span.bold === true ? bold(filled) : filled;
  const slanted = span.italic === true ? italic(emboldened) : emboldened;
  return span.underline === true ? underline(slanted) : slanted;
}

/** Normalize one cell — string or run list — into the renderable's chunk list. */
function toCell(cell: TextTableCell, fallback: Color): TextChunk[] {
  if (typeof cell === "string") return [toChunk({ text: cell }, fallback)];
  return cell.map((span) => toChunk(span, fallback));
}

/** The whole content matrix, as fresh mutable arrays the renderable owns. */
function toContent(
  rows: TextTableProps["rows"],
  tokens: TokenMap,
  textColor: Color | undefined,
): TextChunk[][][] {
  const fallback = textColor ?? tokens.foreground;
  return rows.map((row) => row.map((cell) => toCell(cell, fallback)));
}

/**
 * A grid of styled text cells (spec §6.1). Renders the OpenTUI `TextTableRenderable` — a
 * renderable with no intrinsic tag, registered by {@link registerRenderableTags} — which
 * measures its own column widths and wraps inside a cell, which is what it offers over the
 * hand-composed `./table.tsx`.
 *
 * BORDERS ARE OFF BY DEFAULT because the design's tables are borderless column layouts (the
 * shape `./table.tsx` implements from `design/termcraft-engine.js`). With `borders` set, the
 * style is `single` in the `border` token — the same frame vocabulary the design engine draws
 * every panel with.
 *
 * THE RENDERABLE'S OWN DEFAULTS ARE A HARDCODED `#FFFFFF` for both `borderColor` and `fg`, so
 * this wrapper always passes both from the active theme: no raw white can reach a frame.
 *
 * SELECTION IS DISABLED UNCONDITIONALLY (spec §6.3). `TextTableRenderable` defaults
 * `selectable: true` and keeps its own `_lastLocalSelection`, which is exactly the kind of
 * renderer-internal state an export snapshot must not depend on; row selection is `./table.tsx`'s
 * job, driven from props.
 */
export function TextTable(props: TextTableProps) {
  registerRenderableTags();
  const tokens = activeTokens();
  return (
    <text-table
      id={props.id}
      content={toContent(props.rows, tokens, props.textColor)}
      border={props.borders ?? false}
      showBorders={props.borders ?? false}
      borderStyle="single"
      borderColor={props.borderColor ?? tokens.border}
      fg={props.textColor ?? tokens.foreground}
      backgroundColor={props.background}
      columnGap={props.columnGap ?? 1}
      wrapMode={props.wrap ?? "word"}
      cellPadding={props.cellPadding}
      selectable={false}
      width={props.width}
      height={props.height}
    />
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/runtime/ui/text-table.test.tsx`
Expected: PASS.

If the "no back-fill" assertion fails, print the offending runs: a `bg` other than `"default"`
with no selection means the renderable is painting `backgroundColor`'s default — check that the
wrapper passes `backgroundColor: undefined` rather than a colour when the prop is absent. If
`toContent`'s type is rejected where the tag expects `TextTableContent`, keep the arrays freshly
built (they already are) and widen only the local helper's return type — never the public props.

- [ ] **Step 5: Append the facade export**

At the END of `src/runtime/index.ts`:

```ts
export { TextTable } from "./ui/text-table";
export type { TextTableProps, TextTableCell, TextTableSpan } from "./ui/text-table";
```

Append `"TextTable"` to the catalog name list in `src/runtime/index.test.ts`.

- [ ] **Step 6: Regenerate and verify the declaration**

Run: `bun run gen:runtime-dts`
Run: `bun test src/runtime/generated/runtime-dts.test.ts src/runtime/index.test.ts`

Then confirm the chunk type did **not** leak:

Run: `rtk grep -n "TextChunk\|@opentui/core" src/runtime/generated/runtime.generated.d.ts`
Expected: **no match**. If `TextChunk` appears, an exported symbol's type references it —
make the offending helper non-exported.

- [ ] **Step 7: Bump the corpus canary**

`lexer.test.ts`: 956 → **958** with a naming comment; `lexer.oracle.test.ts` title 956 → **958**.

- [ ] **Step 8: Add the agent-doc bullet**

```md
- `TextTable` — a grid of styled text cells that measures its own column widths and wraps inside
  a cell. Required: `id`, `rows` (a matrix whose cells are a plain string or a list of
  `{ text, color?, background?, bold?, italic?, underline? }` runs). Optional `borders` (off),
  `borderColor`, `textColor`, `background`, `columnGap` (1), `wrap` (`"word"`), `cellPadding`,
  `width`/`height`. Row selection belongs to `Table`, not here.
```

- [ ] **Step 9: Verify and commit**

Run: `bun x tsc --noEmit`
Run: `bun run test src/runtime`
Run: `bun run test src/gate/model/lexer.test.ts`
Run: `bun run lint && bun run fmt:check`

```bash
rtk git add src/runtime/ui/text-table.tsx src/runtime/ui/text-table.test.tsx src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts src/agent/prompt/model/runtime-authoring-guide.md
rtk git commit -m "feat(runtime): add the TextTable wrapper"
```

---

## Task 5: `FrameBuffer`

**Files:**
- Create: `src/runtime/ui/frame-buffer.tsx`
- Create: `src/runtime/ui/frame-buffer.test.tsx`
- Modify: `src/runtime/index.ts` (append), `src/runtime/index.test.ts` (append),
  `src/gate/model/lexer.test.ts` + `lexer.oracle.test.ts` (958 → 960),
  `src/agent/prompt/model/runtime-authoring-guide.md` (one bullet)

**Interfaces:**
- Consumes: `registerRenderableTags()`, `activeTokens()`, `wrap`, `Color`.
- Produces: `export interface FrameBufferSurface`, `export interface FrameBufferProps`,
  `export function FrameBuffer(props: FrameBufferProps)`.

- [ ] **Step 1: Write the failing tests**

Create `src/runtime/ui/frame-buffer.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { FrameBuffer } from "./frame-buffer";
import type { FrameBufferSurface } from "./frame-buffer";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const frameText = (frame: { rows: StyledRun[][] }): string =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");

/** Mount one FrameBuffer with the given draw callback and return the captured frame's text. */
async function renderDrawn(draw: (surface: FrameBufferSurface) => void): Promise<string> {
  const handle = await createHeadlessRenderer({ w: 8, h: 2 });
  open = handle;
  handle.mount(<FrameBuffer id="fb" width={8} height={2} draw={draw} />);
  await handle.render();
  expect(handle.renderError()).toBeNull();
  const text = frameText(handle.capture());
  handle.destroy();
  open = null;
  return text;
}

describe("FrameBuffer (spec §6.1)", () => {
  test("drawText paints into the buffer in the given Color", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 2 });
    open = handle;
    handle.mount(
      <FrameBuffer
        id="fb"
        width={8}
        height={2}
        draw={(surface) => {
          surface.clear(activeTokens().background);
          surface.drawText("ok", 0, 0, activeTokens().accent);
        }}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(frameText(frame)).toContain("ok");
    const painted = allRuns(frame).find((run) => run.text.includes("ok"));
    expect(painted && extractRgb(painted.fg)).toBe<string>(activeTokens().accent);
  });

  test("setCell and fillRect reach individual cells", async () => {
    const text = await renderDrawn((surface) => {
      surface.clear(activeTokens().background);
      surface.fillRect(0, 0, 8, 1, activeTokens().surface);
      surface.setCell(3, 1, "█", activeTokens().success);
    });
    expect(text).toContain("█");
  });

  test("a write outside the buffer is dropped, never a crash", async () => {
    const text = await renderDrawn((surface) => {
      surface.clear(activeTokens().background);
      surface.setCell(99, 99, "X", activeTokens().danger);
      surface.setCell(-1, 0, "Y", activeTokens().danger);
    });
    expect(text).not.toContain("X");
    expect(text).not.toContain("Y");
  });

  test("the surface reports the declared size", async () => {
    const seen: number[] = [];
    await renderDrawn((surface) => {
      seen.push(surface.width, surface.height);
    });
    expect(seen).toEqual([8, 2]);
  });
});

describe("FrameBuffer export determinism (spec §6.3)", () => {
  test("the export frame is identical to the preview frame for the same draw", async () => {
    const draw = (surface: FrameBufferSurface): void => {
      surface.clear(activeTokens().background);
      surface.drawText("det", 1, 0, activeTokens().accent);
    };
    hostModeAtom.set("preview");
    const preview = await renderDrawn(draw);
    hostModeAtom.set("export");
    const exported = await renderDrawn(draw);
    expect(exported).toBe(preview);
  });

  test("two independent export mounts of the same draw render the same frame", async () => {
    const draw = (surface: FrameBufferSurface): void => {
      surface.clear(activeTokens().background);
      surface.fillRect(0, 0, 4, 2, activeTokens().selection);
    };
    hostModeAtom.set("export");
    const first = await renderDrawn(draw);
    const second = await renderDrawn(draw);
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 2: Probe the callback ref BEFORE writing the wrapper**

Run: `bun test src/runtime/ui/frame-buffer.test.tsx`
Expected: FAIL — `Cannot find module './frame-buffer'`.

Then write the wrapper (Step 3) and run the suite. **If the first test fails with an empty frame**,
the callback ref never fired. In that case take D10's stated fallback rather than inventing a third
mechanism: define a termcraft-owned `class TermcraftFrameBufferRenderable extends
FrameBufferRenderable` in `src/runtime/ui/frame-buffer-renderable.ts` with a `draw` setter that
paints and calls `this.requestRender()`, register **that** class under the `frame-buffer` tag in
`renderable-tags.ts`, point `renderable-tags.augmentation.d.ts` at it, drop the ref, and pass
`draw={…}` as an ordinary prop (the reconciler's `default: instance[propKey] = propValue` arm
routes it into the setter). The public `FrameBufferProps`/`FrameBufferSurface` surface below does
not change, and the corpus canary gains one more file (960 → 961) — bump it accordingly.

- [ ] **Step 3: Write the wrapper**

Create `src/runtime/ui/frame-buffer.tsx`:

```tsx
import { parseColor } from "@opentui/core";
import type { FrameBufferRenderable, OptimizedBuffer } from "@opentui/core";

import { wrap } from "../model/reatom";
import type { Color } from "../types";
import { registerRenderableTags } from "./renderable-tags";

/**
 * The cell surface a `FrameBuffer`'s `draw` callback paints into (spec §6.1's "raw drawing …
 * the last escape hatch"). Every colour is a `Color` value read off `useTokens()`; the
 * underlying `OptimizedBuffer` is never handed out, so a page cannot reach the renderer.
 * Coordinates are buffer-local, origin top-left; a write outside the buffer is DROPPED.
 */
export interface FrameBufferSurface {
  /** The buffer's width in cells — the `width` prop. */
  readonly width: number;
  /** The buffer's height in cells — the `height` prop. */
  readonly height: number;
  /** Fill the whole buffer with one hue. */
  clear(color: Color): void;
  /** Paint one cell. */
  setCell(x: number, y: number, glyph: string, color: Color, background?: Color): void;
  /** Paint a run of text starting at `x`,`y`. */
  drawText(text: string, x: number, y: number, color: Color, background?: Color): void;
  /** Fill a rectangle with one hue. */
  fillRect(x: number, y: number, width: number, height: number, color: Color): void;
}

/** Props for the low-level `FrameBuffer`. `id` is the mandatory stable id (§3.2). */
export interface FrameBufferProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  /** Buffer width in cells. REQUIRED by the underlying renderable (spec §6.1's spike). */
  readonly width: number;
  /** Buffer height in cells. REQUIRED by the underlying renderable (spec §6.1's spike). */
  readonly height: number;
  /**
   * Paints the buffer. REQUIRED: the renderable renders NOTHING until it is drawn into (spec
   * §6.1's spike), so an optional `draw` would make the blank render the default.
   */
  readonly draw: (surface: FrameBufferSurface) => void;
}

/** The transparent fill the surface uses when a caller gives no background. */
const TRANSPARENT = parseColor("transparent");

/**
 * Wrap one live `OptimizedBuffer` in the `Color`-typed, bounds-checked surface. Non-exported:
 * the buffer type must not reach the facade's surface (spec §6).
 */
function createSurface(buffer: OptimizedBuffer, width: number, height: number): FrameBufferSurface {
  const inside = (x: number, y: number): boolean =>
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height;
  return {
    width,
    height,
    clear(color) {
      buffer.clear(parseColor(color));
    },
    setCell(x, y, glyph, color, background) {
      // Bounds-checked here rather than trusting the native buffer to clip: an out-of-range
      // write is a page's bug, and dropping it keeps the frame deterministic either way.
      if (!inside(x, y)) return;
      buffer.setCell(
        x,
        y,
        glyph,
        parseColor(color),
        background === undefined ? TRANSPARENT : parseColor(background),
      );
    },
    drawText(text, x, y, color, background) {
      if (!inside(x, y)) return;
      buffer.drawText(
        text,
        x,
        y,
        parseColor(color),
        background === undefined ? undefined : parseColor(background),
      );
    },
    fillRect(x, y, rectWidth, rectHeight, color) {
      if (!inside(x, y)) return;
      buffer.fillRect(
        x,
        y,
        Math.min(rectWidth, width - x),
        Math.min(rectHeight, height - y),
        parseColor(color),
      );
    },
  };
}

/**
 * A raw cell buffer for bespoke graphics — spec §6.1's "last escape hatch". Renders the OpenTUI
 * `FrameBufferRenderable`, a renderable with no intrinsic tag, registered by
 * {@link registerRenderableTags}.
 *
 * HOW `draw` REACHES THE BUFFER, and why a `ref` is used INTERNALLY. The renderable exposes its
 * buffer only as an instance field and renders nothing until something paints into it (spec
 * §6.1's spike), so an instance handle is the only path. §6 forbids PASSING `ref` through to an
 * authored page, which this does not do: the callback ref below is termcraft's own, the page sees
 * only {@link FrameBufferSurface}, and the renderable never escapes. Because the inline callback's
 * identity changes on every render, React re-invokes it on every re-render, so a theme change
 * repaints the buffer.
 *
 * DETERMINISM (spec §6.3): the whole rendered state is a pure function of `draw`, `width` and
 * `height`, with no internal offset, focus or selection — so the export frame equals the preview
 * frame for the same props, which is what `./frame-buffer.test.tsx` asserts.
 */
export function FrameBuffer(props: FrameBufferProps) {
  registerRenderableTags();
  const draw = wrap(props.draw);
  return (
    <frame-buffer
      id={props.id}
      width={props.width}
      height={props.height}
      ref={(instance: FrameBufferRenderable | null): void => {
        if (instance === null) return;
        draw(createSurface(instance.frameBuffer, props.width, props.height));
      }}
    />
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/runtime/ui/frame-buffer.test.tsx`
Expected: PASS. If it fails with an empty frame, go to Step 2's fallback.

- [ ] **Step 5: Append the facade export**

At the END of `src/runtime/index.ts`:

```ts
export { FrameBuffer } from "./ui/frame-buffer";
export type { FrameBufferProps, FrameBufferSurface } from "./ui/frame-buffer";
```

Append `"FrameBuffer"` to the catalog name list in `src/runtime/index.test.ts`.

- [ ] **Step 6: Regenerate and verify the declaration**

Run: `bun run gen:runtime-dts`
Run: `bun test src/runtime/generated/runtime-dts.test.ts src/runtime/index.test.ts`

Then confirm no renderer identity leaked:

Run: `rtk grep -n "OptimizedBuffer\|FrameBufferRenderable\|@opentui/core" src/runtime/generated/runtime.generated.d.ts`
Expected: **no match**.

- [ ] **Step 7: Bump the corpus canary**

`lexer.test.ts`: 958 → **960** with a naming comment; `lexer.oracle.test.ts` title 958 → **960**.
(If Step 2's fallback was taken, 961 instead — in both files.)

- [ ] **Step 8: Add the agent-doc bullet**

```md
- `FrameBuffer` — a raw cell buffer for bespoke graphics; the last escape hatch. Required: `id`,
  `width`, `height`, and `draw(surface)`, which paints through `clear`, `setCell`, `drawText` and
  `fillRect`. It renders nothing until `draw` paints into it, and writes outside the buffer are
  dropped.
```

- [ ] **Step 9: Verify and commit**

Run: `bun x tsc --noEmit`
Run: `bun run test src/runtime`
Run: `bun run test src/gate/model/lexer.test.ts`
Run: `bun run lint && bun run fmt:check`

```bash
rtk git add src/runtime/ui/frame-buffer.tsx src/runtime/ui/frame-buffer.test.tsx src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts src/agent/prompt/model/runtime-authoring-guide.md
rtk git commit -m "feat(runtime): add the FrameBuffer wrapper"
```

---

## Task 6: Architecture docs

**Files:**
- Modify: `docs/architecture/modules.md` (the `src/runtime/ui/` catalog bullet, ~line 233)

**Interfaces:**
- Consumes: the four wrappers and the tag-registration module from Tasks 1–5.
- Produces: nothing consumed by code.

CLAUDE.md requires architecture docs to be updated inside the plan that changes the structure they
describe (spec §10.1: "Architecture-doc updates for a plan's own modules happen inside that plan").

- [ ] **Step 1: Read the bullet you are editing**

Run: `rtk grep -n "src/runtime/ui/" docs/architecture/modules.md`

It currently opens `- \`src/runtime/ui/\` (14 components — primitive, row, column, panel,
separator, spacer, text, button, input, tabs, list, table, gauge, sparkline) — the themed
component catalog; …`.

- [ ] **Step 2: Edit the bullet**

Change the parenthetical to name the four additions and add one sentence about the tag
registration. Keep every other clause of the existing sentence untouched — sibling B plans edit the
same bullet, and rewriting it wholesale guarantees a conflict:

```md
- `src/runtime/ui/` (18 components — primitive, row, column, panel, separator, spacer, text, button, input, tabs, list, table, gauge, sparkline, slider, scroll-bar, text-table, frame-buffer) — the themed component catalog; …
```

Then append, at the end of that same bullet's sentence chain:

```md
  `model`-free by design: `ui/renderable-tags.ts` calls `@opentui/react`'s `extend({…})` once for the four renderables that ship with no intrinsic JSX tag (`Slider`, `ScrollBar`, `TextTable`, `FrameBuffer`), and the paired `ui/renderable-tags.augmentation.d.ts` carries the `declare module "@opentui/react"` augmentation that restores real prop checking on them — a separate `.d.ts` because `scripts/gen-runtime-dts.ts` flattens every emitted chunk into one ambient module, where a nested `declare module` would be invalid and would leak an `@opentui/core` import into the agent-facing prompt copy
```

- [ ] **Step 3: Confirm the Russian mirror needs no change**

Run: `rtk grep -n "runtime/ui\|gauge\|sparkline" docs/architecture/modules.ru.md`
Expected: **no match** — the `.ru.md` mirror is a shorter summary and does not carry this bullet,
so it stays untouched. If a match does appear, mirror the same edit there.

- [ ] **Step 4: Commit**

```bash
rtk git add docs/architecture/modules.md
rtk git commit -m "docs(architecture): record the four tagless-renderable wrappers"
```

---

## Final verification

Run every command below and read its output before claiming the plan is complete
(superpowers:verification-before-completion). `src/ui` and `src/entrypoint` are separate commands
by spec §11 — a combined run produces random failures under load.

- [ ] `bun x tsc --noEmit` → exit 0, no output. This is what proves the
  `declare module "@opentui/react"` augmentation is live: the `@ts-expect-error` probe in
  `renderable-tags.test.tsx` fails as "unused directive" if it is not.
- [ ] `bun run lint` → clean.
- [ ] `bun run fmt:check` → clean.
- [ ] `bun run gen:runtime-dts` → writes both artifacts; then `rtk git status --short
  src/runtime/generated` shows **no** uncommitted change (every task already committed its
  regeneration).
- [ ] `rtk grep -n "@opentui" src/runtime/generated/runtime.generated.d.ts` → the only matches are
  the pre-existing `@opentui/react/jsx-runtime` and `@opentui/react/jsx-dev-runtime` imports that
  were there before this plan. **No `@opentui/core`. No `TextChunk`, `OptimizedBuffer`,
  `SliderRenderable`, `ScrollBarRenderable`, `TextTableRenderable`, `FrameBufferRenderable`.**
- [ ] `rtk grep -n "declare module" src/runtime/generated/runtime-dts.ts` → only
  `@termcraft/runtime`, `@termcraft/runtime/jsx-runtime`, `@termcraft/runtime/jsx-dev-runtime`
  and `@reatom/core`. A `@opentui/react` block here means D2 was violated.
- [ ] `bun run test src/runtime` → all pass, including the eleven new/updated files.
- [ ] `bun run test src/gate` → all pass (the corpus canary is the one that moved).
- [ ] `bun run test src/agent` → all pass.
- [ ] `bun run test src/ui` → all pass (separate command).
- [ ] `bun run test src/entrypoint` → all pass (separate command).
- [ ] `bun run test src/host src/store src/core src/entities` → all pass.
- [ ] Every wrapper has BOTH a render test and an export-determinism test (spec §6.3/§6.4): four
  wrappers × 2 describe blocks. Confirm by
  `rtk grep -n "export determinism" src/runtime/ui/` → four matches.
- [ ] `src/agent/prompt/model/runtime-authoring-guide.md` ends with `## Element catalog
  additions` and exactly four bullets (spec §6.4's "one entry in the agent-facing documentation"
  per element).
- [ ] `/reatom-audit` over the changed TypeScript — the wrappers touch Reatom (`wrap`,
  `activeTokens()`), so this is required before reporting the work done (CLAUDE.md).
- [ ] Nothing under `examples/` was edited (`rtk git --no-pager diff --stat main...HEAD --
  examples/` is empty).

## Known risks, stated rather than discovered later

1. **The callback ref in `FrameBuffer` (D10).** Verified from the reconciler's source that host
   instances are ordinary React instances, but not exercised end-to-end before this plan was
   written. Task 5 Step 2 carries the exact fallback.
2. **`describe(id).kind` and bundler renaming.** The assertions match on `toContain`, so a
   `SliderRenderable2`-style rename fails loudly and is recoverable in one line; the failure mode
   is a false red, never a false green.
3. **Corpus-canary merge conflicts.** Guaranteed against sibling B plans. Resolve by running the
   test and reading the failure — the number is measured, never guessed.
4. **`docs/architecture/modules.md`'s catalog bullet** is edited by every B plan. Task 6 changes
   only the parenthetical and appends one clause, which is the smallest possible conflict surface.
5. **The authoring guide's colour paragraph still says "never raw hex"**, which is wrong under the
   new model. That is P4's rewrite (Track A); this plan's bullets deliberately say nothing about
   colour so the two changes cannot collide.
