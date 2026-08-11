# P7 — Wrappers: input & scroll (Track B, Wave 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Load `/reatom` and `/errore` before any code-related
> action (CLAUDE.md mandate). Every task ends green — `bun x tsc --noEmit` silent, the named
> suites passing, the generated declaration regenerated — and is one commit.

**Goal:** Add the three input/scrolling wrappers of
`docs/superpowers/specs/2026-08-11-project-design-systems-design.md` §6.1 — `Select`, `Textarea`,
`ScrollBox` — over the `select`, `textarea` and `scrollbox` OpenTUI intrinsics, each with a render
test and an **export-determinism** test that proves §6.3: under `hostMode === "export"` the frame
is a function of props alone — scroll offset 0, nothing focused, value from props rather than
internal state.

**Architecture:** Three new plain function components in `src/runtime/ui/`, each shaped exactly
like the existing fourteen: a termcraft-declared `*Props` interface (no `@opentui/*` type on the
public surface), a mandatory `id`, colours resolved from `activeTokens()`, handlers wrapped with
Reatom's `wrap`, and **one export branch** — `isExport()` from `runtime/model/capabilities` — that
replaces every source of internal state with a prop-derived value. Each wrapper is exported from
`src/runtime/index.ts` (append-only), regenerated into the two declaration artifacts, and its
doc comment is the agent-facing documentation entry (the generated `runtime.generated.d.ts` is
what a turn workspace stages as `runtime.d.ts`).

**Tech Stack:** Bun 1.3, TypeScript 7 (`bun x tsc --noEmit`), Reatom v1001 (`@reatom/core@1001`,
`@reatom/react@1001`), `@opentui/core@0.4.5` + `@opentui/react@0.4.5`, `bun:test` through
`scripts/run-tests.ts`, oxlint 1.74 / oxfmt 0.59.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Scope fence.** Only `src/runtime/ui/{select,textarea,scroll-box}.tsx` and their tests,
  `src/runtime/index.ts`, `src/runtime/index.test.ts`, the two regenerated artifacts
  (`src/runtime/generated/runtime-dts.ts`, `src/runtime/generated/runtime.generated.d.ts`), the
  corpus canary in `src/gate/model/lexer.test.ts` + `src/gate/model/lexer.oracle.test.ts`, and
  `docs/architecture/modules.md` + `modules.ru.md`. **No** other `src/runtime/ui/*` file, **no**
  Gate production code, **no** host wiring, **no** `src/agent/prompt/model/runtime-authoring-guide.md`
  (plan P4 rewrites it wholesale — editing it here guarantees a merge conflict). `examples/**` is
  never edited (spec §9).
- **P1 is merged and is the baseline.** `Color` (`` `#${string}` ``), `TokenMap`, `useTokens`,
  `activeTokens`, `themeIdAtom`/`themeTokensAtom`, `seedThemeCapability` all exist in
  `src/runtime/types.ts` and `src/runtime/model/tokens.ts`. Read them before writing code.
- **Design is a source of truth (CLAUDE.md).** Every hue in this plan is a core token role from
  `src/runtime/model/tokens.ts`'s `DARK_DEFAULT`, which took its values 1:1 from
  `design/termcraft-engine.js`'s `pal`. Where the design has no recipe for a case, this plan says
  so in the Decisions below and records the mapping in a code comment — never a silently invented
  hue, glyph or layout.
- **No `@opentui/*` type on a wrapper's PUBLIC surface** (spec §6). A wrapper module MAY import an
  `@opentui/core` type internally (Task 2 does, for one instance ref); its exported `*Props`
  interface may name only `string`, `number`, `boolean`, `Color`, and interfaces declared in the
  same module.
- **No passthrough** of `style`, `ref`, `renderBefore`/`renderAfter`, `treeSitterClient`,
  `buffered`/`live`, or the underlying `Renderable` (spec §6). An author can supply none of them.
  A ref the WRAPPER creates and keeps to itself is not passthrough.
- **Every intrinsic visual flag is pinned explicitly**, never left to an upstream default. OpenTUI
  0.4.5's defaults are measured in the Decisions below and several of them are wrong for this
  design (`showDescription: true`, a hard-coded `#666666` scroll indicator).
- **Module layout (CLAUDE.md).** Files live in `src/runtime/ui/`; relative imports inside
  `src/runtime` (`../model/tokens`, `../types`); alias imports across module boundaries
  (`host/render/model/renderer` in tests). `verbatimModuleSyntax: true` — every type-only import
  is `import type`.
- **errore.** Nothing in this plan performs I/O or has an expected failure, so no new error type
  and no `throw` is introduced.
- **Reatom.** Every event handler that can reach page state is wrapped with `wrap(...)` from
  `../model/reatom` (RTM-C02, spec §6). No new atom, computed or action is created here; if one
  ever were, it would be named.
- **Declaration regeneration.** Every task that changes `src/runtime`'s public surface runs
  `bun run gen:runtime-dts` **before** running its tests —
  `src/runtime/generated/runtime-dts.test.ts` fails on drift.
- **Corpus canary.** `src/gate/model/lexer.test.ts` asserts the exact count of `.ts`/`.tsx` files
  under `src/`, and `src/gate/model/lexer.oracle.test.ts` quotes the same number in a test title.
  The count at this plan's start is **949**. Each task below adds exactly two files and bumps
  **both** places, with a sentence appended to the canary's running commentary. Final: **955**.
- **Test-command split.** `src/ui` and `src/entrypoint` render tests run as SEPARATE `bun test`
  commands — a combined run produces random failures under load (spec §11, and the
  `opentui-render-tests-flaky-under-load` note). This plan touches neither, but the final
  verification honours the split.
- **Test runner.** Always `bun run scripts/run-tests.ts <paths>`, never bare `bun test`: a bare
  run can segfault inside `Bun.Transpiler` and print no failures at all, which reads as green.
- **Commits.** One commit per task, conventional-commit subject. Use `rtk git …`. If a message is
  multi-line, write it to a scratch file and pass `-F <path>` — `rtk git commit` swallows heredoc
  stdin.

---

## Decisions made here, with their reasons

These are the choices the spec leaves to the implementation, settled once so no task re-litigates
them. Every OpenTUI fact below was read out of the installed 0.4.5 packages, not assumed.

**D1 — The export branch is one call to `isExport()`, read like `activeTokens()` is.** The
fourteen existing components are plain function components, not `reatomComponent`s, so a read of
`hostModeAtom` inside them is a current-value read, not a tracked one (P1's D6). That is correct
by construction for the same reason it is correct for the theme: the host writes `hostModeAtom`
once, before the first render of a mount. These three wrappers stay plain function components for
consistency with their fourteen siblings; the trigger to revisit is the same one P1 recorded (a
component that must re-render on a mid-session mode change).

**D2 — §6.3's "scroll offset 0, nothing focused, value from props" maps onto three concrete,
frame-observable guarantees**, one per widget, because "scroll offset" is only literally a thing
for `ScrollBox`:

| Widget | Internal state §6.3 forbids | The export guarantee, as the frame shows it |
| --- | --- | --- |
| `Select` | focus highlight; `_selectedIndex` drifting from keys | body painted in `background` (never the focused `surface`) even with `focused`; the selected row is the one `selectedId` names |
| `Textarea` | the edit buffer's own text; cursor; focus lift | the rendered text is `value` **on every render**, not only the first; no cursor; body painted in `background` |
| `ScrollBox` | scroll offset (`follow`/sticky, wheel, keys) | viewport pinned to offset 0 — the FIRST content row is the top visible row, even with `follow` set |

**D3 — "nothing focused" is enforced twice, deliberately.** Each wrapper passes
`focused={false}` under export (`@opentui/react`'s host config turns a falsy `focused` into an
explicit `instance.blur()`), **and** collapses the widget's focused colour onto its unfocused one.
The first is the mechanism; the second is what makes the guarantee observable in a captured frame
and immune to a focus arriving by some other route.

**D4 — The focus recipe is `background` → `surface`, taken from `surface`'s own documented role.**
`src/runtime/types.ts` defines `surface` as "Elevated fill — status bar, lifted card/**input
bodies**". A focused input body lifting from `background` to `surface` is therefore read off the
token model rather than invented. `ScrollBox`, which is a frame rather than an input body, uses
the design's own labelled focus hue instead: `design/termcraft-engine.js:1876` draws the palette
legend swatch `sw(P.amberHi,'focus #f6c163')`, i.e. `accentHi`, applied to
`focusedBorderColor`. **Stated as a mapping, not a design fact:** the design ships no screen of an
authored page's own focused select/textarea/scroll frame, so these two mappings reuse existing
design vocabulary; they are recorded in each wrapper's doc comment and must be revisited if a
design screen ever covers the case.

**D5 — `Select` is fully controlled by `items` + `selectedId`, with no ref.** Measured in
`node_modules/@opentui/core/index.node.js`: `SelectRenderable`'s `set selectedIndex` clamps and
**does not emit** `selectionChanged`, and `set options` clamps `_selectedIndex` and emits nothing
either. So re-passing both every render can never loop back into the wrapper's own `onHighlight`.
`options` is written **before** `selectedIndex` in the JSX literal so the clamp sees the new list.

**D6 — `Select` shows one line per item: no descriptions, no scroll indicator, upstream's marker.**
Three measured upstream facts drive this:
- `SelectOption.description` is **required** (`renderables/Select.d.ts`), and `showDescription`
  defaults to **`true`** — so an unpinned wrapper would paint a blank description line per item.
  The wrapper pins `showDescription={false}` and maps every item to `description: ""`.
- `showScrollIndicator`'s indicator is drawn with a **hard-coded `parseColor("#666666")`** with no
  option to theme it. An un-themable grey is exactly what the token model exists to prevent, so
  the wrapper pins `showScrollIndicator={false}`.
- `showSelectionIndicator` is pinned `true` (the design's rows do carry a marker), but the glyph is
  upstream's `"▶ "` (U+25B6) with no option to change it, while the design's marker is `▸`
  (U+25B8) — `design/termcraft-engine.js:501`, and `List`/`Tabs` both render `▸`. **DIVERGENCE,
  recorded in the wrapper's doc comment**, not silently substituted: `SelectRenderableOptions`
  exposes no marker character.
  With `itemSpacing` pinned to `0` and descriptions off, `linesPerItem` is exactly 1, which is
  what makes `height ?? items.length` an exact content size.

**D7 — `Textarea`'s text comes from `value`, and under export a remount key makes that true on
every render.** OpenTUI's `TextareaOptions` has no `value`; it has `initialValue`, whose setter is
a **one-shot latch** (`if (!this._initialValueSet) { this.setText(value); this._initialValueSet =
true }`). Under export the wrapper therefore keys the intrinsic on
`` `${props.id}:${value}` ``, so a changed `value` produces a fresh instance and the latch
re-fires — §6.3's "value taken from props rather than internal state", enforced rather than hoped
for. In preview the key is the stable `props.id`, because keying on the text would remount the
editor on every keystroke once the phase-7 input path lands. The consequence — in preview a
`value` change after mount does not re-apply — is upstream's `defaultValue` semantics and is
recorded in the wrapper's doc comment and in this plan's Open Risks.

**D8 — `Textarea.onChange` reads the value through a wrapper-owned callback ref.** Upstream's
`ContentChangeEvent` is an **empty interface** — the event carries no text — so the only way to
honour an `onChange: (value: string) => void` signature is to read `plainText` off the instance.
The wrapper uses a **callback ref**, not `useRef`: this repository installs no `@types/react`
(see `src/host/render/model/error-capture.ts:24-33`, which measured that adding it surfaces eight
pre-existing errors), so `import { useRef } from "react"` is a TS7016 implicit-any error. A
callback ref needs no React import at all. Because its identity changes every render, React
re-attaches it on every commit, so the per-render slot the same render's handler closes over is
always populated.

**D9 — `ScrollBox` exposes no scroll-offset prop, and `follow` is the design's "following" state.**
`ScrollBoxOptions` has no `scrollTop`/`scrollLeft` — they exist only as class setters, so a
declarative offset prop is not expressible and would have to go through a ref. What IS declarative
is `stickyScroll` + `stickyStart`, which is exactly the design's own chat-scroll vocabulary
(`design/termcraft-engine.js:1474-1495` §28: a viewport that stays pinned to the newest content
until the reader scrolls away). So the wrapper exposes `follow?: boolean`, and **under export it
pins `stickyScroll` with `stickyStart` at the start edge instead**, which is what forces offset 0
positively rather than relying on a fresh instance happening to start there.

**D10 — the scrollbar is themed through `scrollbarOptions.trackOptions`, colours only.** §28's
recipe is a `│` track in `P.line` with a `█`/`▀`/`▄` thumb in `P.amberDim`, arrows off. `ScrollBar`
takes `showArrows` and `trackOptions?: Partial<SliderOptions>`, whose `backgroundColor` is the
track and `foregroundColor` the thumb — so `line` and `accentDim` map exactly. **DIVERGENCE,
recorded in the doc comment:** `SliderRenderable` draws its own glyphs, so the half-cell `▀`/`▄`
precision of the design's thumb is not reproducible here; only the hues and the arrows-off rule
are. `scrollbarOptions.onChange` is never passed — `ScrollBoxRenderable`'s constructor writes its
own after the spread and silently wins.

**D11 — the agent-doc entry is the wrapper's doc comment.** There is no prose list of the fourteen
components anywhere in the repository (verified: `runtime-authoring-guide.md` documents shape,
state, layout and determinism, never a component roster). What documents each component for an
authoring agent is its JSDoc, emitted into `src/runtime/generated/runtime.generated.d.ts` and
staged into every turn workspace as `runtime.d.ts` (`src/agent/prompt/model/runtime-docs.ts`).
So §6.4's "one entry in the agent-facing documentation" is discharged by a doc comment on the
component and on every prop, matching the existing fourteen in depth and voice, plus the
regeneration. `runtime-authoring-guide.md` is deliberately untouched (P4 owns it).

---

## File structure

| File | Change | Responsibility after this plan |
| --- | --- | --- |
| `src/runtime/ui/select.tsx` | **create** | `SelectItem`, `SelectProps`, `Select` — controlled single-choice list over the `select` intrinsic |
| `src/runtime/ui/select.test.tsx` | **create** | Render test + export-determinism test |
| `src/runtime/ui/textarea.tsx` | **create** | `TextareaProps`, `Textarea` — multi-line editor over the `textarea` intrinsic |
| `src/runtime/ui/textarea.test.tsx` | **create** | Render test + export-determinism test |
| `src/runtime/ui/scroll-box.tsx` | **create** | `ScrollBoxProps`, `ScrollBox` — scrolling viewport over the `scrollbox` intrinsic |
| `src/runtime/ui/scroll-box.test.tsx` | **create** | Render test + export-determinism test |
| `src/runtime/index.ts` | modify (append only) | Three value exports + three type export lines |
| `src/runtime/index.test.ts` | modify | The catalog roster grows from 13 + `Box` to 16 + `Box` |
| `src/runtime/generated/runtime-dts.ts`, `runtime.generated.d.ts` | regenerate | Never hand-edited |
| `src/gate/model/lexer.test.ts`, `lexer.oracle.test.ts` | modify | Corpus canary 949 → 955 |
| `docs/architecture/modules.md`, `modules.ru.md` | modify | The runtime rows describe 17 components and the export-determinism contract |

---

### Task 1: `Select`

**Files:**
- Create: `src/runtime/ui/select.tsx`
- Create: `src/runtime/ui/select.test.tsx`
- Modify: `src/runtime/index.ts` (append after the `Sparkline` block, currently lines 88-89)
- Modify: `src/runtime/index.test.ts` (the catalog roster test)
- Modify: `src/gate/model/lexer.test.ts`, `src/gate/model/lexer.oracle.test.ts` (949 → 951)
- Regenerate: `src/runtime/generated/runtime-dts.ts`, `runtime.generated.d.ts`

**Interfaces:**
- Consumes: `activeTokens(): TokenMap` from `../model/tokens`; `isExport(): boolean` from
  `../model/capabilities`; `wrap` from `../model/reatom`.
- Produces: `interface SelectItem { readonly id: string; readonly label: string }`;
  `interface SelectProps { readonly id: string; readonly items: readonly SelectItem[];
  readonly selectedId?: string; readonly focused?: boolean; readonly height?: number;
  readonly onHighlight?: (id: string) => void; readonly onSelect?: (id: string) => void }`;
  `function Select(props: SelectProps)`. Both types and the component are re-exported from
  `src/runtime/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/runtime/ui/select.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { themeTokens } from "../model/tokens";
import { Select } from "./select";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  // A host-input atom, so a leaked "export" would silently change every later test's frame.
  hostModeAtom.set("preview");
});

const T = themeTokens("dark-default");
const lineRuns = (frame: { rows: StyledRun[][] }, row: number): StyledRun[] => frame.rows[row] ?? [];
const runWith = (frame: { rows: StyledRun[][] }, row: number, needle: string) =>
  lineRuns(frame, row).find((run) => run.text.includes(needle));

const ITEMS = [
  { id: "a", label: "alpha" },
  { id: "b", label: "bravo" },
  { id: "c", label: "charlie" },
];

describe("Select component (spec §6.1)", () => {
  test("renders every item label on its own row", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="a" />);
    await handle.render();
    const frame = handle.capture();
    expect(runWith(frame, 0, "alpha")).toBeDefined();
    expect(runWith(frame, 1, "bravo")).toBeDefined();
    expect(runWith(frame, 2, "charlie")).toBeDefined();
  });

  test("the selected row follows the design's selection recipe", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="b" />);
    await handle.render();
    const selected = runWith(handle.capture(), 1, "bravo");
    expect(selected && extractRgb(selected.fg)).toBe<string>(T.selectionFg);
    expect(selected && extractRgb(selected.bg)).toBe<string>(T.selection);
  });

  test("an unselected row uses the foreground hue over the background fill", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="b" />);
    await handle.render();
    const other = runWith(handle.capture(), 0, "alpha");
    expect(other && extractRgb(other.fg)).toBe<string>(T.foreground);
    expect(other && extractRgb(other.bg)).toBe<string>(T.background);
  });

  test("a focused Select lifts its body onto the surface token (preview)", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="b" focused />);
    await handle.render();
    const other = runWith(handle.capture(), 0, "alpha");
    expect(other && extractRgb(other.bg)).toBe<string>(T.surface);
  });
});

// §6.3: an interactive widget must render a DEFINED STATIC STATE under export. Asserted, not
// noted — a focus lift and a cursor that follows keys are exactly what makes a snapshot vary.
describe("Select export determinism (spec §6.3)", () => {
  test("under export nothing is focused: the body never lifts, even with `focused`", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="b" focused />);
    await handle.render();
    const other = runWith(handle.capture(), 0, "alpha");
    expect(other && extractRgb(other.bg)).toBe<string>(T.background);
    expect(other && extractRgb(other.bg)).not.toBe<string>(T.surface);
  });

  test("under export the selection is the prop's, on a re-render as much as on the first", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 16, h: 3 });
    open = handle;
    handle.mount(<Select id="agent" items={ITEMS} selectedId="a" />);
    await handle.render();
    const first = runWith(handle.capture(), 0, "alpha");
    expect(first && extractRgb(first.bg)).toBe<string>(T.selection);

    handle.mount(<Select id="agent" items={ITEMS} selectedId="c" />);
    await handle.render();
    const frame = handle.capture();
    const moved = runWith(frame, 2, "charlie");
    const vacated = runWith(frame, 0, "alpha");
    expect(moved && extractRgb(moved.bg)).toBe<string>(T.selection);
    expect(vacated && extractRgb(vacated.bg)).toBe<string>(T.background);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run scripts/run-tests.ts src/runtime/ui/select.test.tsx`
Expected: FAIL — `Cannot find module './select'`.

- [ ] **Step 3: Write the wrapper**

Create `src/runtime/ui/select.tsx`:

```tsx
import { isExport } from "../model/capabilities";
import { wrap } from "../model/reatom";
import { activeTokens } from "../model/tokens";

/** One selectable row in a `Select` (spec §6.1). */
export interface SelectItem {
  /** Stable per-item id; what `onSelect`/`onHighlight` report. */
  readonly id: string;
  /** The rendered row label. */
  readonly label: string;
}

/** Props for the themed `Select` component. `id` is the mandatory stable id (§3.2). */
export interface SelectProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  /** The choices, in display order. */
  readonly items: readonly SelectItem[];
  /**
   * The highlighted item's id. A `Select` is a CURSOR, not an optional highlight: an absent or
   * unmatched id lands on the first item, unlike `List`, where no `selectedId` means no
   * selection band at all.
   */
  readonly selectedId?: string;
  /** Whether the list holds keyboard focus. Always false under export (§6.3). */
  readonly focused?: boolean;
  /** Viewport height in rows; defaults to the item count (one row per item). */
  readonly height?: number;
  /** Invoked with an item id when the cursor MOVES onto it (the intrinsic's `onChange`). */
  readonly onHighlight?: (id: string) => void;
  /** Invoked with an item id when it is COMMITTED (the intrinsic's `onSelect`, i.e. Enter). */
  readonly onSelect?: (id: string) => void;
}

/**
 * Themed single-choice list (design-system §3.2, spec §6.1). Renders one OpenTUI `<select>`,
 * one line per item, with the design's selection recipe: a `selection` back-fill and
 * `selectionFg` text on the cursor row (`design/termcraft-engine.js:499-503`, the agent/model
 * picker), `foreground` on the rest, over the terminal `background`. A focused list lifts its
 * body onto `surface` — the role its own definition calls the "lifted input body" fill; the
 * design ships no screen of an authored page's focused select, so that is a MAPPING onto
 * existing vocabulary, recorded here rather than invented as a new hue.
 *
 * CONTROLLED, WITH NO REF. `SelectRenderable`'s `selectedIndex` and `options` setters both clamp
 * and emit nothing (measured against `@opentui/core@0.4.5`), so re-passing them every render can
 * never loop back into `onHighlight`. `options` is written before `selectedIndex` so the clamp
 * sees the new list.
 *
 * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED: the cursor marker is OpenTUI's own `▶ `
 * (U+25B6). The design's marker is `▸` (U+25B8) — the glyph `List` and `Tabs` render — but
 * `SelectRenderableOptions` exposes no marker character. Descriptions are off (upstream defaults
 * them ON, which would paint a blank line per item) and the scroll indicator is off (upstream
 * draws it in a hard-coded `#666666` that no theme can reach).
 *
 * EXPORT DETERMINISM (§6.3): under `hostMode === "export"` the widget is blurred and its focused
 * fill collapses onto the unfocused one, so the frame is a function of `items` + `selectedId`
 * alone.
 */
export function Select(props: SelectProps) {
  const tokens = activeTokens();
  const exporting = isExport();
  const items = props.items;
  const found = items.findIndex((item) => item.id === props.selectedId);
  const selectedIndex = found < 0 ? 0 : found;
  const onHighlight = props.onHighlight;
  const onSelect = props.onSelect;
  // `wrap` restores the Reatom frame the terminal event loop drops (spec §6, RTM-C02). The
  // intrinsic passes `(index, option)`; the id is resolved from `items` rather than from
  // `option.value`, which upstream types as `any`.
  const handleHighlight =
    onHighlight === undefined
      ? undefined
      : wrap((index: number) => {
          const item = items[index];
          if (item !== undefined) onHighlight(item.id);
        });
  const handleSelect =
    onSelect === undefined
      ? undefined
      : wrap((index: number) => {
          const item = items[index];
          if (item !== undefined) onSelect(item.id);
        });
  return (
    <select
      id={props.id}
      height={props.height ?? items.length}
      // BEFORE `selectedIndex`: the `options` setter clamps the stored index against the NEW
      // list, so writing the list first is what makes an index into a shrunk list land safely.
      options={items.map((item) => ({ name: item.label, description: "" }))}
      selectedIndex={selectedIndex}
      // §6.3: blurred under export. `@opentui/react` turns a falsy `focused` into `blur()`.
      focused={exporting ? false : props.focused}
      showDescription={false}
      showScrollIndicator={false}
      showSelectionIndicator
      itemSpacing={0}
      wrapSelection={false}
      backgroundColor={tokens.background}
      textColor={tokens.foreground}
      // §6.3, the second half of "nothing focused": the focused fill collapses onto the
      // unfocused one under export, so the guarantee holds in the FRAME and not only in the
      // focus call above.
      focusedBackgroundColor={exporting ? tokens.background : tokens.surface}
      focusedTextColor={tokens.foreground}
      selectedBackgroundColor={tokens.selection}
      selectedTextColor={tokens.selectionFg}
      descriptionColor={tokens.foregroundMuted}
      selectedDescriptionColor={tokens.selectionFg}
      onChange={handleHighlight}
      onSelect={handleSelect}
    />
  );
}
```

- [ ] **Step 4: Export it from the facade**

In `src/runtime/index.ts`, APPEND after the existing `Sparkline` lines (currently 88-89):

```ts
// Input and scrolling wrappers (spec §6.1). Each renders a defined static state under
// `hostMode === "export"` (§6.3).
export { Select } from "./ui/select";
export type { SelectProps, SelectItem } from "./ui/select";
```

- [ ] **Step 5: Grow the facade roster test**

In `src/runtime/index.test.ts`, change the roster test's title and list:

```ts
  test("exports the full 14-component design-system catalog + the low-level Box escape hatch", () => {
    for (const name of [
      "Row",
      "Column",
      "Panel",
      "Separator",
      "Spacer",
      "Text",
      "Button",
      "Input",
      "Tabs",
      "List",
      "Table",
      "Gauge",
      "Sparkline",
      "Select",
      "Box",
    ] as const) {
```

- [ ] **Step 6: Bump the corpus canary**

In `src/gate/model/lexer.test.ts`, append to the running commentary immediately above
`expect(files.length).toBe(949);` and change the number:

```ts
    // The project-design-systems P7 plan (input/scroll wrappers) adds `runtime/ui/select.tsx`
    // and its own `select.test.tsx`, taking it to 951.
    // — update BOTH this number and the count quoted in `lexer.oracle.test.ts` when the corpus
    // grows.
    expect(files.length).toBe(951);
```

(Keep the existing `— update BOTH …` sentence as the last two comment lines; insert the new
sentence before it.)

In `src/gate/model/lexer.oracle.test.ts` line ~556, change the test title:

```ts
  test("the repository's own 951 sources: zero under-scans and zero refusals", () => {
```

- [ ] **Step 7: Regenerate the declaration**

Run: `bun run gen:runtime-dts`
Expected: `src/runtime/generated/runtime-dts.ts` and `runtime.generated.d.ts` both change, each
gaining a `// ── src/runtime/ui/select` block carrying the doc comments written in Step 3 and a
`export { Select }; export type { SelectProps, SelectItem };` line.

- [ ] **Step 8: Run the tests to verify they pass**

Run, in this order:

```bash
bun x tsc --noEmit
bun run scripts/run-tests.ts src/runtime
bun run scripts/run-tests.ts src/gate/model/lexer.test.ts
bun run scripts/run-tests.ts src/gate/model/lexer.oracle.test.ts
```

Expected: `tsc` silent; all three suites PASS (`src/runtime` includes the new
`select.test.tsx`, the facade roster test and the declaration drift test).

If a colour assertion fails because the run's `bg` comes back as the terminal fill rather than
the widget's own: **do not weaken the assertion.** `SelectRenderable.refreshFrameBuffer` clears
its whole framebuffer with `focused ? focusedBackgroundColor : backgroundColor` before drawing,
so the fill is real; re-check that the wrapper is passing the colour props rather than relaxing
the test.

- [ ] **Step 9: Lint, format, commit**

```bash
bun run lint && bun run fmt:check
rtk git add src/runtime/ui/select.tsx src/runtime/ui/select.test.tsx src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts
rtk git commit -m "feat(runtime): add the Select wrapper with its export-determinism contract"
```

---

### Task 2: `Textarea`

**Files:**
- Create: `src/runtime/ui/textarea.tsx`
- Create: `src/runtime/ui/textarea.test.tsx`
- Modify: `src/runtime/index.ts` (append after Task 1's `Select` block)
- Modify: `src/runtime/index.test.ts` (roster)
- Modify: `src/gate/model/lexer.test.ts`, `src/gate/model/lexer.oracle.test.ts` (951 → 953)
- Regenerate: `src/runtime/generated/runtime-dts.ts`, `runtime.generated.d.ts`

**Interfaces:**
- Consumes: exactly what Task 1 consumes, plus `import type { TextareaRenderable } from
  "@opentui/core"` (an INTERNAL type import — it never appears in `TextareaProps`).
- Produces: `interface TextareaProps { readonly id: string; readonly value?: string;
  readonly placeholder?: string; readonly focused?: boolean; readonly width?: number;
  readonly height?: number; readonly grow?: number; readonly wrap?: "none" | "char" | "word";
  readonly onChange?: (value: string) => void; readonly onSubmit?: () => void }`;
  `function Textarea(props: TextareaProps)`.

- [ ] **Step 1: Write the failing test**

Create `src/runtime/ui/textarea.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { themeTokens } from "../model/tokens";
import { Textarea } from "./textarea";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const T = themeTokens("dark-default");
const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame).find((run) => run.text.includes(needle));
const allText = (frame: { rows: StyledRun[][] }) =>
  allRuns(frame)
    .map((run) => run.text)
    .join("");

describe("Textarea component (spec §6.1)", () => {
  test("paints its value in the foreground token", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(<Textarea id="note" value="alpha" height={3} />);
    await handle.render();
    const run = findRun(handle.capture(), "alpha");
    expect(run?.text).toContain("alpha");
    expect(run && extractRgb(run.fg)).toBe<string>(T.foreground);
  });

  test("paints the placeholder in the faint token when the value is empty", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(<Textarea id="note" placeholder="type here" height={3} />);
    await handle.render();
    const run = findRun(handle.capture(), "type here");
    expect(run?.text).toContain("type here");
    expect(run && extractRgb(run.fg)).toBe<string>(T.foregroundFaint);
  });

  test("a focused Textarea lifts its body onto the surface token (preview)", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(<Textarea id="note" value="alpha" height={3} focused />);
    await handle.render();
    const run = findRun(handle.capture(), "alpha");
    expect(run && extractRgb(run.bg)).toBe<string>(T.surface);
  });

  test("mounts and renders a frame with both handlers attached (no hang on teardown)", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(
      <Textarea id="note" value="alpha" height={3} onChange={() => {}} onSubmit={() => {}} />,
    );
    await handle.render();
    expect(handle.renderError()).toBeNull();
    expect(handle.capture().rows.length).toBeGreaterThan(0);
  });
});

// §6.3. The load-bearing one is the SECOND test: OpenTUI's `initialValue` is a one-shot latch,
// so without the export remount key a snapshot would keep painting whatever text the instance
// happened to be created with — the exact "internal state instead of props" §6.3 forbids.
describe("Textarea export determinism (spec §6.3)", () => {
  test("under export nothing is focused: the body never lifts, even with `focused`", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(<Textarea id="note" value="alpha" height={3} focused />);
    await handle.render();
    const run = findRun(handle.capture(), "alpha");
    expect(run && extractRgb(run.bg)).toBe<string>(T.background);
    expect(run && extractRgb(run.bg)).not.toBe<string>(T.surface);
  });

  test("under export the rendered text is the prop's on EVERY render, not only the first", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 20, h: 3 });
    open = handle;
    handle.mount(<Textarea id="note" value="alpha" height={3} />);
    await handle.render();
    expect(allText(handle.capture())).toContain("alpha");

    handle.mount(<Textarea id="note" value="bravo" height={3} />);
    await handle.render();
    const frame = handle.capture();
    expect(allText(frame)).toContain("bravo");
    expect(allText(frame)).not.toContain("alpha");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run scripts/run-tests.ts src/runtime/ui/textarea.test.tsx`
Expected: FAIL — `Cannot find module './textarea'`.

- [ ] **Step 3: Write the wrapper**

Create `src/runtime/ui/textarea.tsx`:

```tsx
import type { TextareaRenderable } from "@opentui/core";

import { isExport } from "../model/capabilities";
import { wrap } from "../model/reatom";
import { activeTokens } from "../model/tokens";

/** Props for the themed `Textarea` component. `id` is the mandatory stable id (§3.2). */
export interface TextareaProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  /**
   * The text the editor starts from. UNDER EXPORT this is exactly what renders, on every render
   * (§6.3). In preview it behaves like an HTML `defaultValue` — see the divergence note below.
   */
  readonly value?: string;
  /** Placeholder shown while the buffer is empty. */
  readonly placeholder?: string;
  /** Whether the editor holds keyboard focus. Always false under export (§6.3). */
  readonly focused?: boolean;
  readonly width?: number;
  /** Height in rows. An editor is a viewport, so give it one (or a growing parent). */
  readonly height?: number;
  /** Flex grow factor — a 0 keeps the editor at its height; ≥1 lets it expand. */
  readonly grow?: number;
  /** Soft-wrap mode for long lines. Defaults to `word`. */
  readonly wrap?: "none" | "char" | "word";
  /** Invoked with the whole buffer text on every edit (the intrinsic's `onContentChange`). */
  readonly onChange?: (value: string) => void;
  /** Invoked when the editor's submit binding fires. */
  readonly onSubmit?: () => void;
}

/**
 * Themed multi-line text editor (design-system §3.2, spec §6.1). Renders one OpenTUI
 * `<textarea>` with token-resolved text/placeholder/selection colours, so a theme swap re-colours
 * it without editing sources. A focused editor lifts its body from `background` onto `surface` —
 * the role its own definition calls the "lifted input body" fill; the design ships no screen of
 * an authored page's focused editor, so that is a MAPPING onto existing vocabulary, recorded
 * here rather than invented as a new hue.
 *
 * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED. `@opentui/core@0.4.5`'s `TextareaOptions`
 * has no `value`; it has `initialValue`, whose setter is a ONE-SHOT LATCH — it applies the first
 * time and ignores every later write. In PREVIEW this wrapper therefore behaves like an HTML
 * `defaultValue`: a `value` change after mount does not re-apply, because keying the element on
 * the text would remount the editor (losing cursor and undo) on every keystroke once the phase-7
 * input path lands. UNDER EXPORT that trade is not available — §6.3 requires the value to come
 * from props rather than internal state — so the element IS keyed on the text there, and a
 * changed `value` produces a fresh instance whose latch fires again.
 *
 * `onChange` reads the buffer through a ref this component owns and never exposes (no
 * passthrough, spec §6): upstream's `ContentChangeEvent` is an EMPTY interface, so the event
 * carries no text and `plainText` off the instance is the only source. It is a CALLBACK ref
 * rather than `useRef` because this repository installs no `@types/react` (see
 * `host/render/model/error-capture.ts`), which makes any `react` import a TS7016.
 */
export function Textarea(props: TextareaProps) {
  const tokens = activeTokens();
  const exporting = isExport();
  const value = props.value ?? "";
  // Per-render slot + per-render callback ref: the callback's identity changes every render, so
  // React re-attaches it on every commit and the handler created in the SAME render always
  // closes over a populated slot.
  const slot: { current: TextareaRenderable | null } = { current: null };
  const attach = (node: TextareaRenderable | null): void => {
    slot.current = node;
  };
  const onChange = props.onChange;
  const onSubmit = props.onSubmit;
  // `wrap` restores the Reatom frame the terminal event loop drops (spec §6, RTM-C02).
  const handleContentChange =
    onChange === undefined
      ? undefined
      : wrap((): void => {
          const node = slot.current;
          if (node === null) return;
          onChange(node.plainText);
        });
  const handleSubmit =
    onSubmit === undefined
      ? undefined
      : wrap((): void => {
          onSubmit();
        });
  return (
    <textarea
      // §6.3's "value taken from props rather than internal state", enforced: under export a
      // changed `value` changes the key, React remounts, and `initialValue`'s one-shot latch
      // fires on the fresh instance. In preview the key is stable so editing survives.
      key={exporting ? `${props.id}:${value}` : props.id}
      id={props.id}
      ref={attach}
      initialValue={value}
      placeholder={props.placeholder}
      width={props.width}
      height={props.height}
      flexGrow={props.grow}
      wrapMode={props.wrap ?? "word"}
      // §6.3: no cursor and no focus under export.
      showCursor={exporting ? false : props.focused === true}
      focused={exporting ? false : props.focused}
      backgroundColor={tokens.background}
      textColor={tokens.foreground}
      focusedBackgroundColor={exporting ? tokens.background : tokens.surface}
      focusedTextColor={tokens.foreground}
      placeholderColor={tokens.foregroundFaint}
      cursorColor={tokens.accent}
      selectionBg={tokens.selection}
      selectionFg={tokens.selectionFg}
      onContentChange={handleContentChange}
      onSubmit={handleSubmit}
    />
  );
}
```

- [ ] **Step 4: Export it from the facade**

In `src/runtime/index.ts`, APPEND after Task 1's `Select` lines:

```ts
export { Textarea } from "./ui/textarea";
export type { TextareaProps } from "./ui/textarea";
```

- [ ] **Step 5: Grow the facade roster test**

In `src/runtime/index.test.ts`, add `"Textarea"` after `"Select"` in the roster list and change
the title to `"exports the full 15-component design-system catalog + the low-level Box escape hatch"`.

- [ ] **Step 6: Bump the corpus canary**

`src/gate/model/lexer.test.ts`: extend the sentence added in Task 1 and change the number:

```ts
    // The project-design-systems P7 plan (input/scroll wrappers) adds `runtime/ui/select.tsx`
    // and its own `select.test.tsx`, then `runtime/ui/textarea.tsx` and its own
    // `textarea.test.tsx`, taking it to 953.
```
```ts
    expect(files.length).toBe(953);
```

`src/gate/model/lexer.oracle.test.ts`: the test title becomes `"the repository's own 953 sources: zero under-scans and zero refusals"`.

- [ ] **Step 7: Regenerate the declaration**

Run: `bun run gen:runtime-dts`

- [ ] **Step 8: Run the tests to verify they pass**

```bash
bun x tsc --noEmit
bun run scripts/run-tests.ts src/runtime
bun run scripts/run-tests.ts src/gate/model/lexer.test.ts
bun run scripts/run-tests.ts src/gate/model/lexer.oracle.test.ts
```

Expected: `tsc` silent; all suites PASS.

Two failures are plausible here and neither is licence to weaken an assertion:

1. **The body-fill assertions (`surface` / `background`) find the wrong `bg`.** The editor draws
   its glyphs over its own fill, but if the captured run's `bg` reports the terminal fill instead,
   assert on a cell inside the widget's own rectangle rather than on the text run: use
   `handle.rectOf("note")` and read `frame.rows[rect.y]`, keeping BOTH the positive
   (`preview + focused → surface`) and the negative (`export + focused → background`) halves.
2. **The export re-render test still shows `alpha`.** That means the remount key is not taking
   effect. Verify `key` is on the intrinsic (not on a wrapping element) and that `exporting` is
   true — do NOT switch the test to two separate renderers, which would stop testing anything.

- [ ] **Step 9: Lint, format, commit**

```bash
bun run lint && bun run fmt:check
rtk git add src/runtime/ui/textarea.tsx src/runtime/ui/textarea.test.tsx src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts
rtk git commit -m "feat(runtime): add the Textarea wrapper with its export-determinism contract"
```

---

### Task 3: `ScrollBox`

**Files:**
- Create: `src/runtime/ui/scroll-box.tsx`
- Create: `src/runtime/ui/scroll-box.test.tsx`
- Modify: `src/runtime/index.ts` (append after Task 2's `Textarea` block)
- Modify: `src/runtime/index.test.ts` (roster)
- Modify: `src/gate/model/lexer.test.ts`, `src/gate/model/lexer.oracle.test.ts` (953 → 955)
- Regenerate: `src/runtime/generated/runtime-dts.ts`, `runtime.generated.d.ts`

**Interfaces:**
- Consumes: `activeTokens`, `isExport`, and `Color` from `../types`; `Text` from `./text` in the
  test only.
- Produces: `interface ScrollBoxProps { readonly id: string; readonly children?: unknown;
  readonly direction?: "row" | "column"; readonly gap?: number; readonly padding?: number;
  readonly grow?: number; readonly width?: number; readonly height?: number;
  readonly border?: boolean; readonly borderColor?: Color; readonly background?: Color;
  readonly focused?: boolean; readonly follow?: boolean }`;
  `function ScrollBox(props: ScrollBoxProps)`.
- Note: `ScrollBox` takes **no** handler props — `ScrollBoxOptions` surfaces no scroll callback
  at all (`ScrollBoxRenderable`'s constructor writes its own `onChange` onto both internal
  scrollbars after the caller's spread, so any supplied one is discarded). So this wrapper has no
  `wrap` call; the rule applies to the handlers a widget HAS.

- [ ] **Step 1: Write the failing test**

Create `src/runtime/ui/scroll-box.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { themeTokens } from "../model/tokens";
import { ScrollBox } from "./scroll-box";
import { Text } from "./text";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const T = themeTokens("dark-default");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const allText = (frame: { rows: StyledRun[][] }) =>
  allRuns(frame)
    .map((run) => run.text)
    .join("");

/** Six rows in a three-row viewport: the top half and the bottom half are disjoint. */
const rows = () =>
  ["r0", "r1", "r2", "r3", "r4", "r5"].map((label) => (
    <Text key={label} id={`row-${label}`}>
      {label}
    </Text>
  ));

/** Two paints plus a real-time yield: sticky scroll is applied from a size-change callback. */
const settle = async (handle: RenderHandle) => {
  await handle.render();
  await tick();
  await handle.render();
};

describe("ScrollBox component (spec §6.1)", () => {
  test("renders the top of its content in a viewport shorter than the content", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 });
    open = handle;
    handle.mount(
      <ScrollBox id="log" height={3} width={12}>
        {rows()}
      </ScrollBox>,
    );
    await settle(handle);
    const text = allText(handle.capture());
    expect(text).toContain("r0");
    expect(text).not.toContain("r5");
  });

  test("`follow` pins the viewport to the newest content (preview)", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 });
    open = handle;
    handle.mount(
      <ScrollBox id="log" height={3} width={12} follow>
        {rows()}
      </ScrollBox>,
    );
    await settle(handle);
    const text = allText(handle.capture());
    expect(text).toContain("r5");
    expect(text).not.toContain("r0");
  });

  test("a focused ScrollBox draws the design's focus hue on its frame (preview)", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 5 });
    open = handle;
    handle.mount(
      <ScrollBox id="log" height={5} width={12} border focused>
        {rows()}
      </ScrollBox>,
    );
    await settle(handle);
    const frame = handle.capture();
    const border = allRuns(frame).find((run) => run.text.includes("─"));
    expect(border && extractRgb(border.fg)).toBe<string>(T.accentHi);
  });
});

// §6.3: "scroll offset 0" is literal here. `follow` is the one prop that moves the offset off
// zero, so it is exactly what the export contract has to override.
describe("ScrollBox export determinism (spec §6.3)", () => {
  test("under export the viewport is pinned to offset 0, even with `follow`", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 12, h: 3 });
    open = handle;
    handle.mount(
      <ScrollBox id="log" height={3} width={12} follow>
        {rows()}
      </ScrollBox>,
    );
    await settle(handle);
    const text = allText(handle.capture());
    expect(text).toContain("r0");
    expect(text).not.toContain("r5");
  });

  test("under export nothing is focused: the frame keeps the border token", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 12, h: 5 });
    open = handle;
    handle.mount(
      <ScrollBox id="log" height={5} width={12} border focused>
        {rows()}
      </ScrollBox>,
    );
    await settle(handle);
    const border = allRuns(handle.capture()).find((run) => run.text.includes("─"));
    expect(border && extractRgb(border.fg)).toBe<string>(T.border);
    expect(border && extractRgb(border.fg)).not.toBe<string>(T.accentHi);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run scripts/run-tests.ts src/runtime/ui/scroll-box.test.tsx`
Expected: FAIL — `Cannot find module './scroll-box'`.

- [ ] **Step 3: Write the wrapper**

Create `src/runtime/ui/scroll-box.tsx`:

```tsx
import { isExport } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/** Props for the `ScrollBox` scrolling viewport. `id` is the mandatory stable id (§3.2). */
export interface ScrollBoxProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  readonly children?: unknown;
  /** Content axis, and therefore the scrolling axis. Defaults to `column`. */
  readonly direction?: "row" | "column";
  /** Gap between the content's children. */
  readonly gap?: number;
  /** Inner padding around the content. */
  readonly padding?: number;
  /** Flex grow factor of the viewport itself. */
  readonly grow?: number;
  readonly width?: number;
  /** Viewport height in rows. A viewport shorter than its content is the point. */
  readonly height?: number;
  readonly border?: boolean;
  /** The frame hue; defaults to the theme's `border`. Read one off `useTokens()` (§4.5). */
  readonly borderColor?: Color;
  /** The viewport fill; defaults to the theme's `background`. Read one off `useTokens()`. */
  readonly background?: Color;
  /** Whether the viewport holds keyboard focus. Always false under export (§6.3). */
  readonly focused?: boolean;
  /**
   * Pin the viewport to the NEWEST content — the design's chat-scroll "following" state
   * (`design/termcraft-engine.js:1474-1495`, §28). IGNORED UNDER EXPORT (§6.3): a snapshot is
   * always taken at offset 0.
   */
  readonly follow?: boolean;
}

/**
 * A scrolling viewport (design-system §3.2, spec §6.1). Renders one OpenTUI `<scrollbox>`: a
 * fixed-size frame over content taller (or wider) than itself, with a proportional scrollbar
 * themed to the design's §28 recipe — a track in `line` and a thumb in `accentDim`, arrows off
 * (`design/termcraft-engine.js:1478-1483`). A focused frame is drawn in `accentHi`, the hue the
 * design's own palette legend labels `focus` (`design/termcraft-engine.js:1876`).
 *
 * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED: the design's thumb is `█` with `▀`/`▄` at
 * half-cell precision, drawn by the engine itself. OpenTUI's `SliderRenderable` draws its own
 * glyphs and exposes only two colours, so this wrapper reproduces the HUES and the arrows-off
 * rule and not the half-cell thumb.
 *
 * NO SCROLL-OFFSET PROP, AND NO SCROLL CALLBACK. `ScrollBoxOptions` carries neither: `scrollTop`
 * exists only as a class setter, and the scrollbars' own `onChange` is overwritten by
 * `ScrollBoxRenderable`'s constructor after the caller's spread. Position is therefore expressed
 * declaratively, through `follow`, which is the design's own vocabulary for it.
 *
 * EXPORT DETERMINISM (§6.3): under `hostMode === "export"` the viewport is pinned to the START
 * edge — offset 0 — whatever `follow` says, and the frame is blurred with its focused hue
 * collapsed onto the unfocused one.
 */
export function ScrollBox(props: ScrollBoxProps) {
  const tokens = activeTokens();
  const exporting = isExport();
  const horizontal = props.direction === "row";
  const frameColor = props.borderColor ?? tokens.border;
  // §6.3: sticky at the START edge under export pins the offset to 0 POSITIVELY, rather than
  // relying on a fresh instance happening to begin there.
  const startEdge = horizontal ? "left" : "top";
  const newestEdge = horizontal ? "right" : "bottom";
  const following = props.follow === true;
  return (
    <scrollbox
      id={props.id}
      width={props.width}
      height={props.height}
      flexGrow={props.grow}
      border={props.border}
      borderStyle="rounded"
      borderColor={frameColor}
      focusedBorderColor={exporting ? frameColor : tokens.accentHi}
      backgroundColor={props.background ?? tokens.background}
      focused={exporting ? false : props.focused}
      scrollX={horizontal}
      scrollY={!horizontal}
      stickyScroll={exporting ? true : following}
      stickyStart={exporting ? startEdge : following ? newestEdge : undefined}
      contentOptions={{
        flexDirection: props.direction ?? "column",
        gap: props.gap,
        padding: props.padding,
      }}
      scrollbarOptions={{
        showArrows: false,
        trackOptions: { backgroundColor: tokens.line, foregroundColor: tokens.accentDim },
      }}
    >
      {props.children}
    </scrollbox>
  );
}
```

- [ ] **Step 4: Export it from the facade**

In `src/runtime/index.ts`, APPEND after Task 2's `Textarea` lines:

```ts
export { ScrollBox } from "./ui/scroll-box";
export type { ScrollBoxProps } from "./ui/scroll-box";
```

- [ ] **Step 5: Grow the facade roster test**

In `src/runtime/index.test.ts`, add `"ScrollBox"` after `"Textarea"` and change the title to
`"exports the full 16-component design-system catalog + the low-level Box escape hatch"`.

- [ ] **Step 6: Bump the corpus canary**

`src/gate/model/lexer.test.ts`: extend the P7 sentence and change the number:

```ts
    // The project-design-systems P7 plan (input/scroll wrappers) adds `runtime/ui/select.tsx`,
    // `runtime/ui/textarea.tsx` and `runtime/ui/scroll-box.tsx` with a test file beside each,
    // taking it to 955.
```
```ts
    expect(files.length).toBe(955);
```

`src/gate/model/lexer.oracle.test.ts`: the test title becomes `"the repository's own 955 sources: zero under-scans and zero refusals"`.

- [ ] **Step 7: Regenerate the declaration**

Run: `bun run gen:runtime-dts`

- [ ] **Step 8: Run the tests to verify they pass**

```bash
bun x tsc --noEmit
bun run scripts/run-tests.ts src/runtime
bun run scripts/run-tests.ts src/gate/model/lexer.test.ts
bun run scripts/run-tests.ts src/gate/model/lexer.oracle.test.ts
```

Expected: `tsc` silent; all suites PASS.

The one plausible failure is the **`follow` preview test**: sticky scroll is applied from
`recalculateBarProps`, which runs off the viewport/content size-change callback, so the offset may
not have moved by the first paint. `settle()` already gives it two paints and a real-time yield
(the idiom `src/runtime/model/tokens.reactivity.test.tsx` uses). If that is still not enough, add
one more `await tick(); await handle.render();` inside `settle`. **Do not delete or weaken the
assertion, and do not delete the `follow` prop** — if the preview half genuinely cannot be made to
hold, stop and report it: it would mean the export guarantee is asserting against a state that
never differs, which is a test that measures nothing.

If the border-hue tests cannot find a `─` run, the rounded frame may draw a different horizontal
glyph — read the actual captured row and match the glyph the frame really carries rather than
dropping the assertion.

- [ ] **Step 9: Lint, format, commit**

```bash
bun run lint && bun run fmt:check
rtk git add src/runtime/ui/scroll-box.tsx src/runtime/ui/scroll-box.test.tsx src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts
rtk git commit -m "feat(runtime): add the ScrollBox wrapper with its export-determinism contract"
```

---

### Task 4: Architecture docs

**Files:**
- Modify: `docs/architecture/modules.md` (the `src/runtime/ui/` anchor line, currently line 233,
  and the Runtime facade table row, currently line 45)
- Modify: `docs/architecture/modules.ru.md` (the Runtime facade table row, currently line 45)

**Interfaces:** Consumes the three components Tasks 1-3 produced. Produces nothing code-facing.

- [ ] **Step 1: Update the `src/runtime/ui/` anchor**

In `docs/architecture/modules.md`, the line beginning `` - `src/runtime/ui/` (14 components — ``:
change the count to **17** and extend the file list with `select`, `textarea`, `scroll-box`, then
append this sentence to the same bullet, immediately after the existing `Separator` divergence
clause:

```
`Select`, `Textarea` and `ScrollBox` additionally carry the export-determinism contract of the
project-design-systems spec §6.3: each reads `isExport()` and, under `hostMode === "export"`,
renders a defined static state — nothing focused, `ScrollBox` pinned to scroll offset 0 whatever
`follow` says, and `Textarea`'s text re-derived from its `value` prop on every render rather than
from the edit buffer's own latched contents. Each carries a test asserting it rather than a note
asking for it. Three divergences are recorded in the components themselves: `Select`'s cursor
marker is OpenTUI's `▶` rather than the design's `▸` (the intrinsic exposes no marker character),
`ScrollBox`'s scrollbar reproduces the design's hues but not its half-cell thumb, and `Textarea`
behaves like an HTML `defaultValue` in preview because `initialValue` is a one-shot latch upstream.
```

- [ ] **Step 2: Update the Runtime facade row**

In the same file, the **Runtime facade** table row (line 45) lists the interactive props that are
"wired to the right handler but stay inert in the static render". Extend that list from
`` (`onPress`/`onChange`/`onSelect`) `` to
`` (`onPress`/`onChange`/`onSelect`/`onHighlight`/`onSubmit`) `` and, after "the full component
catalog", add `` including the §6.1 input/scrolling wrappers `Select`, `Textarea` and `ScrollBox` ``.

- [ ] **Step 3: Mirror it in the Russian doc**

In `docs/architecture/modules.ru.md`, the corresponding **Runtime facade** row (line 45) carries
the same two clauses in Russian. Make the same two edits there, matching the row's existing style
and keeping every code identifier (`onPress`, `onChange`, `onSelect`, `onHighlight`, `onSubmit`,
`Select`, `Textarea`, `ScrollBox`) untranslated. `modules.ru.md` carries no per-file anchor list,
so Step 1 has no Russian counterpart.

- [ ] **Step 4: Verify nothing else claims a component count**

Run: `rtk git grep -n "14 component\|13-component\|fourteen" -- docs src`
Expected: no remaining stale count outside this plan's own document and the plan documents in
`docs/superpowers/plans/` (historical records — do not edit those).

- [ ] **Step 5: Commit**

```bash
rtk git add docs/architecture/modules.md docs/architecture/modules.ru.md
rtk git commit -m "docs(architecture): describe the input/scrolling wrappers and their export contract"
```

---

## Final verification

Run every command below and read every output before reporting this plan complete. A crashed
`bun test` run prints no `(fail)` lines and reads as green — `scripts/run-tests.ts` exists to make
that a loud, distinct outcome, so never bypass it.

```bash
# 1. Types
bun x tsc --noEmit

# 2. The generated declaration is fresh (must produce NO working-tree change)
bun run gen:runtime-dts
rtk git status --porcelain

# 3. The runtime suite — the three wrappers, the facade roster, the declaration drift test
bun run scripts/run-tests.ts src/runtime

# 4. The corpus canary, both halves
bun run scripts/run-tests.ts src/gate/model/lexer.test.ts
bun run scripts/run-tests.ts src/gate/model/lexer.oracle.test.ts

# 5. The rest of the Gate and the agent prompt (the declaration is an input to both)
bun run scripts/run-tests.ts src/gate
bun run scripts/run-tests.ts src/agent

# 6. Render suites, SEPARATELY — a combined run fails randomly under load (spec §11)
bun run scripts/run-tests.ts src/ui
bun run scripts/run-tests.ts src/entrypoint

# 7. Lint and format
bun run lint
bun run fmt:check
```

Then:

- [ ] Run `/reatom-audit` (the change touches `wrap` at React event-handler boundaries, which is
  exactly the react-adapter domain the audit checks). Note the
  `reatom-audit-router-consumes-cache` behaviour: a second `--changed` run reports "already
  audited" even though no auditor ran, so audit once and read that run's findings.
- [ ] Confirm the canary reads **955** in `src/gate/model/lexer.test.ts` and **955** in the
  `lexer.oracle.test.ts` title, and that the running commentary explains the +6.
- [ ] Confirm `src/runtime/index.ts` only GAINED lines — the facade export list must merge
  trivially with the sibling B plans (spec §10.1 shared-file rule).
- [ ] Confirm `src/agent/prompt/model/runtime-authoring-guide.md` is untouched (`rtk git diff
  --stat` against the wave's base).

---

## Open risks and things the merge orchestrator must know

1. **The corpus canary is a fourth shared-file collision surface**, not named in spec §10.1's
   list (`src/runtime/index.ts`, the generated declaration, the agent docs). P5, P6, P7 and P9
   each add files and each bumps the same two numbers, so a textual merge will produce a wrong
   total. This plan's delta is **+6** (three wrappers, three test files), baseline 949 → 955. At
   each merge the orchestrator should let the walk report the real number rather than adding the
   deltas by hand.
2. **`src/runtime/index.test.ts`'s roster test collides the same way** — its title carries a
   count and its list carries every component name. Same resolution: keep the union, recount.
3. **`Textarea` is `defaultValue`-shaped in preview.** `initialValue` is a one-shot latch upstream,
   so a page that drives the editor's text from an atom will not see later writes applied in
   preview. This is documented in the component and is deliberately NOT papered over with a
   remount key outside export, because that key would destroy cursor and undo on every keystroke
   once the phase-7 input path lands. **It is a real limitation, not an acceptable end state**:
   whoever builds the interactive path owes this a controlled `value` (an instance `replaceText`
   guarded against cursor jumps) or an upstream fix.
4. **`Textarea.onChange`'s ref path cannot be exercised in P7.** Nothing delivers keystrokes to a
   page today (the host protocol's `forwardInput`/`key`/`click` are unbuilt), so the callback-ref
   slot and `plainText` read are covered only by "mounts and renders with handlers attached". The
   phase-7 input work must exercise it before relying on it.
5. **There is no focus model in termcraft pages today, and this plan does not invent one.**
   Verified across `src/runtime`, `src/host/render` and `src/host/session`: the only focus surface
   in the whole runtime is `Input.focused?: boolean`, a styling prop. OpenTUI's own model is a
   single global `currentFocusedRenderable` on the render context with **no tab order** — calling
   `.focus()` on any renderable silently blurs whatever held it. These three wrappers therefore
   expose `focused?: boolean` exactly as `Input` does and nothing more. **Flagged as a design gap
   per CLAUDE.md rather than filled by invention:** the design system covers focus for the SHELL
   (screen 15 `wsFocus`, the composer's `❯` gutter, the `focus #f6c163` palette swatch) but has no
   screen for focus moving between widgets inside an authored page, and no tab-order rule. Whoever
   owns the phase-7 interactive path needs that decision from the design before a real focus model
   can be built.
6. **Two colour mappings are reasoned, not drawn** (D4): the focused-input lift onto `surface` and
   the focused frame in `accentHi`. Both reuse existing design vocabulary and both are recorded in
   the components' doc comments. If a design screen ever covers an authored page's focused
   select/editor/scroll frame, they must be re-checked against it.
7. **`ScrollBox`'s `follow` preview assertion depends on sticky scroll settling within two paints.**
   If it proves flaky under load — the failure mode `opentui-render-tests-flaky-under-load`
   records for `src/ui` — the fix is more settle passes, never a weaker assertion: without the
   preview half moving off zero, the export half proves nothing.
8. **P9's `Diff`/`LineNumber` and P5's `ScrollBar` overlap conceptually with `ScrollBox`.** P5
   registers a standalone `ScrollBar` renderable via `extend()`. Nothing in this plan calls
   `extend()` or touches the `OpenTUIComponents` augmentation, so the two do not collide; but if
   P5 lands first, the scrollbar theming in `scroll-box.tsx` and P5's `ScrollBar` wrapper should
   be reviewed together so the design's §28 recipe is expressed once.
