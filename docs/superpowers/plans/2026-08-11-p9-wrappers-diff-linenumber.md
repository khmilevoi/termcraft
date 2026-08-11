# P9 — `Diff` and `LineNumber` wrappers (Track B, Wave 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Load `/reatom` and `/errore` before any code-related
> action (CLAUDE.md mandate). Every task ends green — `bun x tsc --noEmit` silent and the named
> suites passing — and is one commit.

**Goal:** Add the two "Documents and code" wrappers that do **not** need tree-sitter —
`LineNumber` and `Diff` — to the runtime's component catalog, per
`docs/superpowers/specs/2026-08-11-project-design-systems-design.md` §6.1's *Documents and code*
row, with the §6 wrapper rules (mandatory `id`, `Color`-typed colours, termcraft-declared prop
interfaces, no OpenTUI type or `Renderable` reaching authored source) and the §6.4 per-element
deliverables (wrapper, render test, export-determinism test, `.d.ts` regeneration, agent-doc
entry).

**Architecture:** Two layers, deliberately separated so this plan does not serialize behind P8.

- **Layer 1 (Tasks 1–3) — plain render. Depends on P1 only; lands independently of P8.**
  `LineNumber` wraps the `line-number` intrinsic and `Diff` wraps the `diff` intrinsic. Neither
  needs a `SyntaxStyle`: `DiffRenderable` falls back to `SyntaxStyle.create()` (zero registered
  styles) when `syntaxStyle` is absent and renders plain monochrome content — verified
  empirically, see D2. Every colour the two intrinsics accept is passed explicitly from the
  active theme, because leaving one unset paints a hard-coded vendor hue into the frame (D3).
- **Layer 2 (Task 4) — `Diff`'s OPTIONAL syntax highlighting. Depends on P8.** It consumes P8's
  theme→`SyntaxStyle` builder and P8's export-settle helper. It is written last, is **skippable
  and deferrable**, and carries an explicit interface assumption (§"P8 interface assumption")
  to be reconciled at whichever of P8/P9 merges second — spec §10.1 P9: *"its plain render lands
  independently, the highlight wiring joins at whichever merge comes second."*

**Tech Stack:** Bun 1.3.14, TypeScript 7 (`bun x tsc --noEmit`), Reatom v1001
(`@reatom/core@1001`, `@reatom/react@1001`), `@opentui/core@0.4.5` + `@opentui/react@0.4.5`,
`bun:test`, errore 0.14.1, oxlint 1.74 / oxfmt 0.59.

## Global Constraints

- **Scope fence.** Only `src/runtime/ui/**` (two new wrappers + their tests),
  `src/runtime/index.ts` (append-only), `src/runtime/index.test.ts`,
  `src/runtime/generated/**` (regenerated, never hand-edited), the two corpus-canary numbers in
  `src/gate/model/lexer.test.ts` / `src/gate/model/lexer.oracle.test.ts`, and
  `docs/architecture/modules.md` + `modules.ru.md`. **No** Gate production code, **no** host
  code, **no** `src/agent/prompt/model/runtime-authoring-guide.md` (P4 owns its rewrite — see
  "Deliberately left alone"), **no** `examples/**` (spec §9 forbids editing it).
- **Design is a source of truth (CLAUDE.md).** Every hex in this plan is a core theme role read
  off `activeTokens()`. **No hex literal is written into either wrapper.** The one place the
  design does not cover — a diff's added/removed row backgrounds — is resolved in D4 by
  *declining to paint a band the design never paints*, and flagged as an open gap rather than
  filled with an invented hue.
- **Module layout (CLAUDE.md).** Wrappers live in `src/runtime/ui/`; `src/runtime/types.ts`
  holds shared types; `src/runtime/index.ts` is the public entry point. Nothing new goes in
  `types.ts` — both prop interfaces live beside their component, exactly as `TextProps`,
  `PanelProps` and `SparklineProps` do.
- **Imports.** Relative inside `src/runtime` (`../model/tokens`, `../types`, `./text`); alias
  (`host/render/...`, `host/protocol`) from tests across the module boundary.
  `verbatimModuleSyntax: true` — every type-only import is `import type`.
- **No OpenTUI identity in the facade.** `src/runtime/index.test.ts` asserts `index.ts` contains
  no `from "@opentui…"`. Wrapper *implementation* files may import from `@opentui/core` (`text.tsx`
  already imports `TextAttributes`), but **no `@opentui/*` type may appear in an exported prop
  interface** — every union is spelled out in termcraft's own words (spec §6).
- **errore.** Neither wrapper performs I/O and neither can fail as a value; no error type is
  introduced. No `throw`, no `try`/`catch`, no `any`, no non-null assertion.
- **Reatom.** Neither wrapper creates an atom, computed or action. They call `activeTokens()`
  — the existing current-value read — exactly as `Text`, `Panel` and `Sparkline` do. Do **not**
  introduce a component-body atom (the `/reatom` skill's explicit anti-pattern).
- **Declaration regeneration.** Any change to `src/runtime`'s public surface invalidates
  `src/runtime/generated/runtime-dts.ts` and `runtime.generated.d.ts`, and
  `src/runtime/generated/runtime-dts.test.ts` fails on the drift. **Every task that touches
  `index.ts` runs `bun run gen:runtime-dts` before it runs its tests.**
- **Corpus canary.** `src/gate/model/lexer.test.ts` asserts the repository's exact `.ts`/`.tsx`
  file count and `src/gate/model/lexer.oracle.test.ts` quotes the same number in a test name.
  **The number was 949 when this plan was written.** Each task below that adds files states the
  delta, not the absolute — **re-read the current value first**, because P5–P8 bump the same two
  lines and one of them may already have merged.
- **Test-command split.** `src/ui` and `src/entrypoint` render tests run as SEPARATE `bun test`
  commands; a combined run produces random failures under load (spec §11). This plan touches
  neither, but the final verification honours the split.
- **Shared-file discipline (spec §10.1).** `src/runtime/index.ts` is **append-only** — add new
  exports at the END of the component-catalog block, never re-sort it. Generated artifacts are
  never text-merged; the orchestrator reruns the generator after every merge.
- **Commits.** One commit per task, conventional-commit subject. Use `rtk git …`. Multi-line
  messages go to a scratch file passed with `-F <path>` (`rtk git commit` swallows heredoc stdin).

---

## Decisions made here, with their reasons

Everything the spec leaves to the implementation, settled once so no task re-litigates it. Every
"verified" below was measured against the real headless harness on this branch, not inferred.

**D1 — the intrinsic tags are `diff` and `line-number` (kebab-case), and both already
type-check.** From `node_modules/@opentui/react/jsx-namespace.d.ts`'s `IntrinsicElements`:
`diff: DiffProps` and `"line-number": LineNumberProps`. There is no camelCase variant. Unlike
P5's `Slider`/`ScrollBar`/`TextTable`/`FrameBuffer`, **neither needs `extend()` and neither needs
a `declare module` augmentation** — they are built-in tags in `baseComponents`. P9 therefore has
**no dependency on P5**.

**D2 — `Diff` renders correctly with NO `syntaxStyle`, so layer 1 is genuinely independent of
P8.** `DiffRenderable` builds its internal `CodeRenderable` pair with `SyntaxStyle.create()`
(zero registered styles) when no `syntaxStyle` is supplied; it does not throw and does not warn.
Verified: a unified patch rendered `1 / 2 - / 2 + / 3` rows with correct signs and gutter in a
60×10 headless frame, `renderError()` `null`. This is why the highlight wiring is Task 4 and not
a prerequisite.

**D3 — every colour is passed explicitly; omitting one leaks a vendor hue into the page.**
Verified by rendering `<diff diff={patch} showLineNumbers />` with no colour props: the frame came
back carrying `#888888` (gutter fg), `#ef4444` (removed sign), `#22c55e` (added sign), `#4d1a1a`
(removed bg) and `#1a4d1a` (added bg) — five hard-coded hues from
`@opentui/core`'s constructor defaults, none of them in this project's palette. A wrapper that
"just passes through" would put an off-theme green band in an authored page. Both wrappers
therefore resolve **every** colour the intrinsic accepts from `activeTokens()`, and each carries
a test asserting the vendor hues do not appear in the frame.

**D4 — added/removed rows get NO background band, and that is a design finding, not a
placeholder.** `design/termcraft-engine.js` and all 27 `design/*.dc.html` screens contain **no
diff view at all** — the word never appears in a rendering sense. The one banded row the design
does draw is the *failure* band, `pal.red` text on `pal.redDim`
(`termcraft-engine.js:119`, `:741`) — an error strip, not a diff row. The design draws **no green
band anywhere**: `pal.green` appears only as foreground on `●` live, `✓` resolved, and sparkline
bars (`:62`, `:282`, `:586`, `:636`).

So the mapping that is genuinely 1:1 with the design is **sign-carried semantics**: `+` in
`success`, `-` in `danger`, both rows on the ordinary `background`. Painting `dangerDim` behind a
removed line would reuse the *failure* band for a non-failure meaning; inventing a green
counterpart to it would be exactly the guess CLAUDE.md forbids. The wrapper therefore passes
`background` for `addedBg`/`removedBg`/`contextBg` (which is what suppresses D3's vendor bands)
and exposes `addedBackground`/`removedBackground` as optional `Color` props so a project whose
design system declares its own diff hues can supply them — the spec's own resolution route
(§6.1: *"to be resolved from the project's design system and never invented ad hoc"*).

**This is recorded as an OPEN DESIGN GAP** in "Open gaps" below and in the wrapper's own doc
comment. It is not resolved by this plan and must not be closed by an implementer picking a hue.

**D5 — the gutter is `foregroundFaint` on `background`.** `foregroundFaint`'s own role doc is
"placeholders, disabled/ghost rows, hints, **column headers**" (engine `pal.faint`); a line-number
gutter is chrome of exactly that weight, and the design paints no gutter fill anywhere. This is
the closest faithful mapping, stated rather than silently substituted (CLAUDE.md). `lineNumberBg`
is `background` for the same reason `addedBg` is: to suppress D3's vendor default, not to paint
something.

**D6 — `LineNumber` takes a child and never a `target`.** `LineNumberOptions.target` is
`Renderable & LineInfoProvider` — an OpenTUI `Renderable`, which spec §6 forbids passing through.
It does not need to be exposed: `LineNumberRenderable.add()` duck-types the first child that
carries `lineInfo`/`lineCount`/`virtualLineCount`/`scrollY` and calls `setTarget()` itself.
Verified: `<line-number id="ln"><Text id="t">{"aa\nbb\ncc"}</Text></line-number>` rendered
`1 aa / 2 bb / 3 cc`. Two consequences the wrapper documents and tests:

- **Exactly one numbered child.** Once a target is set, further `add()` calls return `-1` and the
  extra children are **silently dropped**. `LineNumber` documents "one text-like child" and a
  test asserts the drop, so the behaviour is recorded rather than discovered in a live page.
- **A non-text child yields no gutter at all.** With no target, `renderSelf` draws nothing — the
  gutter is only constructed inside `setTarget`. A test asserts that `<LineNumber><Row/></LineNumber>`
  degrades to an empty frame rather than throwing.

The classes that qualify as targets are `TextRenderable`, `TextBufferRenderable`,
`CodeRenderable`, and `EditBufferRenderable` (which `textarea`/`input` inherit). In today's
catalog that is `Text` and `Input`; P7's `Textarea` and P8's `Code` join later with no change
here. **`DiffRenderable` does NOT implement `LineInfoProvider`** — `<Diff>` can never be a
`<LineNumber>` child, which is fine because `Diff` has its own `showLineNumbers`.

**D7 — `Diff`'s content prop is named `patch`, and it is a unified diff string.**
`DiffRenderableOptions.diff` is a single unified-patch string parsed with jsdiff's `parsePatch`
(first patch only). There is no `oldText`/`newText` pair. `patch` says what the value is; `diff`
would name the component after itself. It is **required** on the termcraft interface even though
OpenTUI's is optional — a `Diff` with no patch renders an empty box, which is a page bug the type
system can prevent.

**D8 — `startAt` is `lineNumberOffset + 1`.** Verified: `lineNumberOffset={10}` renders the first
line as `11`. A page author means "this excerpt starts at line 42", so the wrapper exposes
`startAt?: number` (default `1`) and passes `startAt - 1`. Mapping ergonomic prop vocabulary onto
the vendor's is the established pattern (`Row`'s `align`/`justify` → Yoga's
`alignItems`/`justifyContent`).

**D9 — the export-determinism test is a new pattern; here is its shape.** No per-wrapper export
test exists in the repository today (the only determinism test,
`src/host/render/model/determinism.test.ts`, spawns two host processes for a whole page). §6.3
asks for a per-wrapper one, and for these two wrappers the property is: *nothing about the frame
depends on `hostMode`, and two independent renders are byte-identical.* Neither wrapper exposes
scroll or focus, so "scroll offset 0, nothing focused" is satisfied structurally rather than
asserted through a prop. The concrete test is written out in full in Tasks 1 and 2.

**D10 — deliberately NOT exposed.** `syncScroll` and `conceal` (interactive/editor concerns);
`selectionBg`/`selectionFg` on `Diff` (selection is host-driven chrome, not page styling — they
are still passed from `selection`/`selectionFg` so no vendor default leaks, just not
configurable); `addedContentBg`/`removedContentBg`/`contextContentBg` (they default to `null` and
fall back to the row backgrounds this plan already sets — no vendor hue reaches the frame through
them); `lineColors`/`lineSigns`/`hideLineNumbers`/`lineNumbers` on `LineNumber` (`Map`/`Set`
prop values in an authored page are a poor contract, and nothing in the spec asks for them);
`treeSitterClient`, `style`, `ref`, `renderBefore`/`renderAfter`, `buffered`/`live`, and every
`on*` handler (spec §6 forbids all of them).

## P8 interface assumption

Task 4 — and **only** Task 4 — consumes P8. P8's plan does not exist in
`docs/superpowers/plans/` as of this writing, so the following is an **assumption to reconcile at
whichever of P8/P9 merges second**, not a fact:

```ts
// ASSUMED — src/runtime/model/syntax-style.ts, exported by P8, NOT on the facade
import type { SyntaxStyle } from "@opentui/core";
import type { TokenMap } from "../types";

/**
 * Build an OpenTUI `SyntaxStyle` from the active theme's tokens (spec §6.1): the ~14 base
 * capture scopes plus the `"default"` fallback key, via `SyntaxStyle.fromStyles`.
 */
export function buildSyntaxStyle(tokens: TokenMap): SyntaxStyle;
```

and, for the export-settle problem:

```ts
// ASSUMED — a settle helper P8 must build for `Markdown`, which exposes no done-signal.
// The MODULE PATH is assumed too; Task 4's test imports it from `host/render/model/settle`,
// which is a guess at where P8 puts an export-path helper. It may equally land as a method on
// `RenderHandle` or in a runtime test util — adapt the import, do not add a second helper.
export async function renderSettled(handle: RenderHandle, budgetMs?: number): Promise<void>;
```

**Reconciliation rule for the executor.** Task 4 must adapt to P8's real names and signatures;
it must **not** re-implement either helper. If P8 named the builder differently, or made it take
the whole theme rather than a `TokenMap`, or put the settle helper on `RenderHandle` instead of
in a test util, change Task 4's two call sites and nothing else. If P8 has not merged when P9 is
otherwise done, **stop after Task 3, merge layers 1's three tasks, and leave Task 4 unchecked** —
the plan is designed to be complete and shippable at that point.

**Why `Diff` needs the settle helper and cannot use `Code`'s signal.** `CodeRenderable` exposes
`highlightingDone: Promise<void>`; `DiffRenderable` does **not** — its highlight state lives on
two *private* internal `CodeRenderable`s (`_waitingForHighlight`, `handleLineInfoChange`,
`attachLineInfoListeners` are all private) and no public promise or event surfaces it. So `Diff`
is in `Markdown`'s situation, not `Code`'s: its highlighted-frame assertion needs the
quiet-frames settle loop that yields real time (spec §6.1's ~350 ms budget), which is P8's to
build.

## File structure

| File | Change | Responsibility after this plan |
| --- | --- | --- |
| `src/runtime/ui/line-number.tsx` | **create** | `LineNumberProps` + `LineNumber` — the themed gutter around one text-like child |
| `src/runtime/ui/line-number.test.tsx` | **create** | Render behaviour + export determinism + the two D6 degradations |
| `src/runtime/ui/diff.tsx` | **create** | `DiffProps` + `Diff` — the themed unified/split patch view |
| `src/runtime/ui/diff.test.tsx` | **create** | Render behaviour + export determinism + the D3 no-vendor-hue guard |
| `src/runtime/index.ts` | modify (append) | Adds `LineNumber`/`LineNumberProps` and `Diff`/`DiffProps` at the END of the catalog block |
| `src/runtime/index.test.ts` | modify | Catalog contract covers the two new names |
| `src/runtime/generated/runtime-dts.ts`, `runtime.generated.d.ts` | regenerate | Never hand-edited; this is the agent-facing doc entry (see below) |
| `src/gate/model/lexer.test.ts`, `src/gate/model/lexer.oracle.test.ts` | modify (canary) | File-count bump + one history line each task |
| `docs/architecture/modules.md` | modify | The `src/runtime/ui/` bullet grows from 14 components to 16 |
| `docs/architecture/modules.ru.md` | verify only | The Russian file is a 61-line summary with no per-file bullets — expected to need no edit (Task 3 Step 2) |

**Where the "agent-doc entry" actually lives.** There is no prose component table served to the
agent. The agent-facing documentation is `src/runtime/generated/runtime.generated.d.ts`, staged
into every turn workspace as `runtime.d.ts` by
`src/agent/prompt/model/runtime-docs.ts`'s `buildRuntimeDocs()`. **JSDoc on the wrapper and on
every prop field is carried verbatim into that file** — verified against `Sparkline`, whose
per-field comments appear at `runtime.generated.d.ts:543-557`. So "one entry in the agent-facing
documentation" (§6.4) is discharged by writing the doc comments in the exact register the existing
fourteen use — a summary paragraph naming the design-system section, the default token for each
colour, and any divergence — and then regenerating. Each task below has a step that reads the
regenerated file to confirm the entry landed.

---

### Task 1: `LineNumber`

**Files:**
- Create: `src/runtime/ui/line-number.tsx`
- Create: `src/runtime/ui/line-number.test.tsx`
- Modify: `src/runtime/index.ts` (append two lines at the end of the catalog block)
- Modify: `src/runtime/index.test.ts` (the catalog name list and its test title)
- Modify: `src/gate/model/lexer.test.ts`, `src/gate/model/lexer.oracle.test.ts` (canary +2)
- Regenerate: `src/runtime/generated/runtime-dts.ts`, `src/runtime/generated/runtime.generated.d.ts`

**Interfaces:**
- Consumes: `activeTokens(): TokenMap` from `../model/tokens` (returns the active theme's core
  roles — `foregroundFaint`, `background`, … — as `Color` values); `Color` from `../types`;
  `Text` from `./text` (tests only).
- Produces: `export interface LineNumberProps` and `export function LineNumber(props:
  LineNumberProps): React.ReactNode`, both re-exported from `src/runtime/index.ts`. Task 2 does
  not depend on either; Task 3 documents both.

- [ ] **Step 1: Write the failing test**

Create `src/runtime/ui/line-number.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { themeTokens } from "../model/tokens";
import { LineNumber } from "./line-number";
import { Row } from "./row";
import { Text } from "./text";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  // The atom is process-wide; a test that switches it must put it back or it leaks into
  // every later test file in the same `bun test` process.
  hostModeAtom.set("preview");
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame).find((run) => run.text.includes(needle));
const lines = (frame: { rows: StyledRun[][] }): string[] =>
  frame.rows.map((row) => row.map((run) => run.text).join(""));

// `@opentui/core@0.4.5` paints these when a colour prop is left unset (plan D3). None of them
// is in this project's palette, so seeing one in a frame means the wrapper stopped resolving
// that colour from the theme.
const VENDOR_HUES = ["#888888", "#ef4444", "#22c55e", "#4d1a1a", "#1a4d1a"];

describe("LineNumber component (design-system §6.1)", () => {
  test("numbers the lines of its one text-like child", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 4 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter">
        <Text id="body">{"alpha\nbeta\ngamma"}</Text>
      </LineNumber>,
    );
    await handle.render();
    const painted = lines(handle.capture());
    expect(painted[0]).toContain("1");
    expect(painted[0]).toContain("alpha");
    expect(painted[1]).toContain("2");
    expect(painted[1]).toContain("beta");
    expect(painted[2]).toContain("3");
    expect(painted[2]).toContain("gamma");
  });

  test("paints the gutter in foregroundFaint on background, never a vendor default", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 3 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter">
        <Text id="body">{"one\ntwo"}</Text>
      </LineNumber>,
    );
    await handle.render();
    const frame = handle.capture();
    const number = findRun(frame, "1");
    expect(number && extractRgb(number.fg)).toBe<string>(
      themeTokens("dark-default").foregroundFaint,
    );
    expect(number && extractRgb(number.bg)).toBe<string>(themeTokens("dark-default").background);
    for (const run of allRuns(frame)) {
      expect(VENDOR_HUES).not.toContain(extractRgb(run.fg) ?? "");
      expect(VENDOR_HUES).not.toContain(extractRgb(run.bg) ?? "");
    }
  });

  test("startAt shifts the first number (plan D8)", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 3 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter" startAt={42}>
        <Text id="body">{"one\ntwo"}</Text>
      </LineNumber>,
    );
    await handle.render();
    const painted = lines(handle.capture());
    expect(painted[0]).toContain("42");
    expect(painted[1]).toContain("43");
  });

  test("an explicit color overrides the theme default", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 2 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter" color="#e6a23c">
        <Text id="body">{"one"}</Text>
      </LineNumber>,
    );
    await handle.render();
    const number = findRun(handle.capture(), "1");
    expect(number && extractRgb(number.fg)).toBe<string>("#e6a23c");
  });

  test("the mandatory id reaches the element for host geometry", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 3 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter">
        <Text id="body">{"one\ntwo"}</Text>
      </LineNumber>,
    );
    await handle.render();
    expect(handle.rectOf("gutter")).not.toBeNull();
  });

  // Plan D6: `LineNumberRenderable.add()` duck-types the FIRST child carrying line info and
  // silently refuses every later child. Recorded as a test so the behaviour is documented
  // rather than discovered inside a live page.
  test("a second child is silently dropped, and the frame still renders", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 4 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter">
        <Text id="first">{"one\ntwo"}</Text>
        <Text id="second">{"dropped"}</Text>
      </LineNumber>,
    );
    await handle.render();
    const painted = lines(handle.capture()).join("\n");
    expect(handle.renderError()).toBeNull();
    expect(painted).toContain("one");
    expect(painted).not.toContain("dropped");
  });

  // Plan D6: with no line-info-providing child there is no target, and `renderSelf` draws
  // nothing at all — an empty frame, not a throw.
  test("a non-text child degrades to an empty frame instead of throwing", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 3 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter">
        <Row id="inner" />
      </LineNumber>,
    );
    await handle.render();
    expect(handle.renderError()).toBeNull();
    expect(lines(handle.capture()).join("").trim()).toBe("");
  });
});

// §6.3: an export snapshot is deterministic by contract. `LineNumber` exposes no scroll and no
// focus, so the property to assert is that the frame depends on nothing but its props.
describe("LineNumber export determinism (§6.3)", () => {
  const mounted = (
    <LineNumber id="gutter" startAt={7}>
      <Text id="body">{"alpha\nbeta\ngamma"}</Text>
    </LineNumber>
  );

  const renderOnce = async (): Promise<string> => {
    const handle = await createHeadlessRenderer({ w: 24, h: 5 });
    handle.mount(mounted);
    await handle.render();
    const captured = JSON.stringify(handle.capture());
    handle.destroy();
    return captured;
  };

  test("two independent renders in export mode produce identical frames", async () => {
    hostModeAtom.set("export");
    const first = await renderOnce();
    const second = await renderOnce();
    expect(first).toBe(second);
  });

  test("the export frame equals the preview frame — no host-mode-dependent state", async () => {
    hostModeAtom.set("preview");
    const preview = await renderOnce();
    hostModeAtom.set("export");
    const exported = await renderOnce();
    expect(exported).toBe(preview);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/runtime/ui/line-number.test.tsx`
Expected: FAIL — `Cannot find module './line-number'`.

- [ ] **Step 3: Write the wrapper**

Create `src/runtime/ui/line-number.tsx`:

```tsx
import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/** Props for the themed `LineNumber` gutter. `id` is the mandatory stable id (§3.2). */
export interface LineNumberProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string;
  /**
   * The content whose lines are numbered — EXACTLY ONE text-like child (`Text` today; `Input`,
   * and later `Textarea`/`Code`, qualify too). A second child is silently dropped and a child
   * that is not text-like leaves the gutter unbuilt, so nothing renders at all. See the
   * component's own note.
   */
  readonly children?: unknown;
  /** The gutter digits' hue; defaults to the theme's `foregroundFaint`. */
  readonly color?: Color;
  /** The gutter's fill; defaults to the theme's `background` (the design paints no gutter fill). */
  readonly background?: Color;
  /** The number the first line carries; defaults to `1`. */
  readonly startAt?: number;
  /** Minimum gutter width in cells, so a growing file does not shift the content sideways. */
  readonly minWidth?: number;
  /** Cells of space between the digits and the content. */
  readonly gap?: number;
}

/**
 * A themed line-number gutter around one text-like child (design-system §6.1, the "Documents and
 * code" group). Renders an OpenTUI `<line-number>` whose numbering target is wired from the child
 * itself — the underlying `target` is a renderer object and is deliberately never a prop (spec
 * §6). The mandatory `id` flows to the element so the host can answer geometry queries and the
 * shell can select/pin it.
 *
 * ONE CHILD, AND IT MUST BE TEXT-LIKE. The renderable adopts the FIRST child that reports line
 * information (`Text`, `Input`, and later `Textarea`/`Code`) as its numbering target; every later
 * child is refused and never appears. A child that reports no line information — a `Row`, a
 * `Panel`, a `Box` — leaves the gutter unbuilt and the whole component draws nothing. Neither
 * case throws; both are covered by tests beside this file.
 *
 * `Diff` can NOT be a child: it carries no line information of its own (it composes its own
 * internal gutters). Use `Diff`'s `showLineNumbers` instead.
 *
 * COLOURS. `color` defaults to `foregroundFaint` — the role the design gives placeholders, ghost
 * rows and column headers, which is the weight a gutter reads at; the design draws no gutter of
 * its own, so this is the closest faithful mapping rather than a quoted value. `background`
 * defaults to the theme's `background`: the design paints no gutter fill, and passing the value
 * explicitly is what stops `@opentui/core`'s own `#888888` default from reaching the frame.
 */
export function LineNumber(props: LineNumberProps) {
  const tokens = activeTokens();
  return (
    <line-number
      id={props.id}
      fg={props.color ?? tokens.foregroundFaint}
      bg={props.background ?? tokens.background}
      // The vendor counts from `lineNumberOffset + 1`; a page author means "this excerpt starts
      // at line N", so the ergonomic prop is `startAt` and the offset is derived. Same shape as
      // `Row`'s align/justify vocabulary over Yoga's.
      lineNumberOffset={props.startAt === undefined ? undefined : props.startAt - 1}
      minWidth={props.minWidth}
      paddingRight={props.gap}
    >
      {props.children}
    </line-number>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/runtime/ui/line-number.test.tsx`
Expected: PASS — 9 tests.

If the `startAt` test fails by one, re-measure rather than adjusting the assertion: mount
`<line-number lineNumberOffset={10}>` directly in a scratch test and read the first painted
number. It was `11` when this plan was written.

- [ ] **Step 5: Export from the facade (append-only)**

In `src/runtime/index.ts`, append at the very END of the component-catalog block, after the
`Sparkline` pair:

```ts
export { LineNumber } from "./ui/line-number";
export type { LineNumberProps } from "./ui/line-number";
```

Do not re-sort or reformat the block — P5–P8 append to the same lines and a re-sort turns a
trivial merge into a conflict.

- [ ] **Step 6: Update the facade contract test**

In `src/runtime/index.test.ts`, add `"LineNumber"` to the end of the catalog name array and
change the test title from `exports the full 13-component design-system catalog + the low-level
Box escape hatch` to `exports the full 14-component design-system catalog + the low-level Box
escape hatch`.

- [ ] **Step 7: Regenerate the declaration and confirm the agent-doc entry**

```bash
rtk bun run gen:runtime-dts
```

Then read `src/runtime/generated/runtime.generated.d.ts` and confirm it now contains
`interface LineNumberProps`, `function LineNumber`, and the per-field JSDoc from Step 3 — this
file is what is staged into the agent's turn workspace as `runtime.d.ts`, so its presence there
IS the §6.4 documentation entry.

- [ ] **Step 8: Bump the corpus canary**

This task adds **2** files (`line-number.tsx`, `line-number.test.tsx`).

Read the current number first — it was `949` when this plan was written, but P5–P8 bump the same
lines:

```bash
rtk git grep -n "expect(files.length).toBe(" -- src/gate/model/lexer.test.ts
rtk git grep -n "the repository's own" -- src/gate/model/lexer.oracle.test.ts
```

Then in `src/gate/model/lexer.test.ts`, raise `expect(files.length).toBe(N)` to `N + 2` and append
to the history comment directly above it:

```
    // The project-design-systems P9 plan (Diff/LineNumber wrappers) adds
    // `runtime/ui/line-number.tsx` and its own `line-number.test.tsx`, taking it to <N+2>.
```

And in `src/gate/model/lexer.oracle.test.ts`, update the same number inside the test name
`the repository's own <N> sources: zero under-scans and zero refusals`.

- [ ] **Step 9: Run the affected suites**

```bash
rtk bun x tsc --noEmit
rtk bun test src/runtime/
rtk bun test src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts
rtk bun run lint && rtk bun run fmt:check
```

Expected: `tsc` silent; all suites pass. `src/runtime/generated/runtime-dts.test.ts` passing is
the proof that Step 7's regeneration was actually committed rather than skipped.

- [ ] **Step 10: Commit**

```bash
rtk git add src/runtime/ui/line-number.tsx src/runtime/ui/line-number.test.tsx \
  src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated \
  src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts
rtk git commit -m "feat(runtime): add the LineNumber gutter wrapper"
```

---

### Task 2: `Diff` (plain render)

**Files:**
- Create: `src/runtime/ui/diff.tsx`
- Create: `src/runtime/ui/diff.test.tsx`
- Modify: `src/runtime/index.ts` (append two lines at the end of the catalog block)
- Modify: `src/runtime/index.test.ts` (the catalog name list and its test title)
- Modify: `src/gate/model/lexer.test.ts`, `src/gate/model/lexer.oracle.test.ts` (canary +2)
- Regenerate: `src/runtime/generated/runtime-dts.ts`, `src/runtime/generated/runtime.generated.d.ts`

**Interfaces:**
- Consumes: `activeTokens(): TokenMap` from `../model/tokens`; `Color` from `../types`. Nothing
  from Task 1.
- Produces: `export interface DiffProps` and `export function Diff(props: DiffProps):
  React.ReactNode`, re-exported from `src/runtime/index.ts`. **Task 4 modifies both** — it adds a
  `language?: string` prop and an internally-built `syntaxStyle`.

- [ ] **Step 1: Write the failing test**

Create `src/runtime/ui/diff.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { themeTokens } from "../model/tokens";
import { Diff } from "./diff";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame).find((run) => run.text.includes(needle));
const lines = (frame: { rows: StyledRun[][] }): string[] =>
  frame.rows.map((row) => row.map((run) => run.text).join(""));

// See plan D3. `@opentui/core@0.4.5` paints these when the matching colour prop is unset; none
// belongs to this project's palette, so one appearing in a frame means the wrapper stopped
// resolving that colour from the theme.
const VENDOR_HUES = ["#888888", "#ef4444", "#22c55e", "#4d1a1a", "#1a4d1a"];

const PATCH = `--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 const a = 1
-const b = 2
+const b = 3
 const c = 4
`;

describe("Diff component (design-system §6.1)", () => {
  test("renders the unified view with signs and line numbers", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Diff id="patch" patch={PATCH} showLineNumbers />);
    await handle.render();
    const painted = lines(handle.capture());
    expect(painted[0]).toContain("const a = 1");
    expect(painted[1]).toContain("-");
    expect(painted[1]).toContain("const b = 2");
    expect(painted[2]).toContain("+");
    expect(painted[2]).toContain("const b = 3");
    expect(painted[3]).toContain("const c = 4");
  });

  test("the added sign is the success token and the removed sign is danger", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Diff id="patch" patch={PATCH} showLineNumbers />);
    await handle.render();
    const frame = handle.capture();
    const added = findRun(frame, "+");
    const removed = findRun(frame, "-");
    expect(added && extractRgb(added.fg)).toBe<string>(themeTokens("dark-default").success);
    expect(removed && extractRgb(removed.fg)).toBe<string>(themeTokens("dark-default").danger);
  });

  // Plan D4: the design paints no diff band, so neither does the wrapper — and passing the
  // theme background explicitly is exactly what keeps the vendor's green/red bands out.
  test("added and removed rows sit on the theme background, with no vendor band", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Diff id="patch" patch={PATCH} showLineNumbers />);
    await handle.render();
    const frame = handle.capture();
    const addedContent = findRun(frame, "const b = 3");
    expect(addedContent && extractRgb(addedContent.bg)).toBe<string>(
      themeTokens("dark-default").background,
    );
    for (const run of allRuns(frame)) {
      expect(VENDOR_HUES).not.toContain(extractRgb(run.fg) ?? "");
      expect(VENDOR_HUES).not.toContain(extractRgb(run.bg) ?? "");
    }
  });

  test("a project may supply its own added/removed backgrounds", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(
      <Diff
        id="patch"
        patch={PATCH}
        showLineNumbers
        addedBackground="#0d2818"
        removedBackground="#4d2a20"
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const added = findRun(frame, "const b = 3");
    const removed = findRun(frame, "const b = 2");
    expect(added && extractRgb(added.bg)).toBe<string>("#0d2818");
    expect(removed && extractRgb(removed.bg)).toBe<string>("#4d2a20");
  });

  test("the split view lays the two sides out side by side", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 8 });
    open = handle;
    handle.mount(<Diff id="patch" patch={PATCH} view="split" showLineNumbers />);
    await handle.render();
    const painted = lines(handle.capture());
    // Both sides of a context line appear on one row in split view.
    expect(painted[0]?.match(/const a = 1/g)?.length).toBe(2);
  });

  test("the mandatory id reaches the element for host geometry", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Diff id="patch" patch={PATCH} />);
    await handle.render();
    expect(handle.rectOf("patch")).not.toBeNull();
  });

  test("an empty patch renders an empty frame instead of throwing", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 3 });
    open = handle;
    handle.mount(<Diff id="patch" patch="" />);
    await handle.render();
    expect(handle.renderError()).toBeNull();
    expect(lines(handle.capture()).join("").trim()).toBe("");
  });

  test("a non-patch string renders an empty frame instead of throwing", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 3 });
    open = handle;
    handle.mount(<Diff id="patch" patch="not a patch at all" />);
    await handle.render();
    expect(handle.renderError()).toBeNull();
    expect(lines(handle.capture()).join("").trim()).toBe("");
  });
});

// §6.3. `Diff` exposes no scroll and no focus, and layer 1 runs no async highlight pass, so the
// property is that the frame depends on nothing but its props. Task 4 REPLACES the first test
// here with a highlighted-frame assertion once P8's settle helper exists.
describe("Diff export determinism (§6.3)", () => {
  const renderOnce = async (): Promise<string> => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    handle.mount(<Diff id="patch" patch={PATCH} view="unified" showLineNumbers />);
    await handle.render();
    const captured = JSON.stringify(handle.capture());
    handle.destroy();
    return captured;
  };

  test("two independent renders in export mode produce identical frames", async () => {
    hostModeAtom.set("export");
    const first = await renderOnce();
    const second = await renderOnce();
    expect(first).toBe(second);
  });

  test("the export frame equals the preview frame — no host-mode-dependent state", async () => {
    hostModeAtom.set("preview");
    const preview = await renderOnce();
    hostModeAtom.set("export");
    const exported = await renderOnce();
    expect(exported).toBe(preview);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/runtime/ui/diff.test.tsx`
Expected: FAIL — `Cannot find module './diff'`.

- [ ] **Step 3: Write the wrapper**

Create `src/runtime/ui/diff.tsx`:

```tsx
import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/** Props for the themed `Diff` view. `id` is the mandatory stable id (§3.2). */
export interface DiffProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string;
  /**
   * The change to render, as ONE unified diff (a `--- / +++ / @@` patch). Only the first patch
   * in the string is rendered. An empty or unparseable value renders nothing rather than failing.
   */
  readonly patch: string;
  /** `unified` stacks the two sides, `split` puts them side by side. Defaults to `unified`. */
  readonly view?: "unified" | "split";
  /** Whether to draw the line-number gutters. Defaults to off. */
  readonly showLineNumbers?: boolean;
  /** How over-long lines break; defaults to the renderer's own wrapping. */
  readonly wrap?: "word" | "char" | "none";
  /** The content hue; defaults to the theme's `foreground`. */
  readonly color?: Color;
  /** The gutter digits' hue; defaults to the theme's `foregroundFaint`. */
  readonly lineNumberColor?: Color;
  /** The `+` sign's hue; defaults to the theme's `success`. */
  readonly addedColor?: Color;
  /** The `-` sign's hue; defaults to the theme's `danger`. */
  readonly removedColor?: Color;
  /**
   * The band behind an added line. Defaults to the theme's `background` — i.e. NO band; see the
   * component's own note on why, and supply a project token here to paint one.
   */
  readonly addedBackground?: Color;
  /** The band behind a removed line. Defaults to the theme's `background` — i.e. NO band. */
  readonly removedBackground?: Color;
}

/**
 * A themed unified/split diff view (design-system §6.1, the "Documents and code" group). Takes
 * one unified `patch` string and renders it with `+`/`-` signs, optional line-number gutters, and
 * every colour resolved from the active theme. The mandatory `id` flows to the element so the
 * host can answer geometry queries and the shell can select/pin it.
 *
 * DEGRADATION, NOT FAILURE. An empty patch, or a string that is not a patch at all, renders an
 * empty frame; nothing throws. A patch whose hunk header disagrees with its body renders the
 * renderer's own parse-error message instead of the diff — a divergence recorded here because the
 * message is drawn in the renderer's own red, which is not a theme colour and cannot be
 * overridden through any prop.
 *
 * COLOURS, AND THE ONE GAP. `color`/`lineNumberColor`/`addedColor`/`removedColor` default to the
 * theme's `foreground`/`foregroundFaint`/`success`/`danger` — the design's own vocabulary, where
 * green marks the live/resolved/positive and red the failed/negative.
 *
 * The row BACKGROUNDS are the gap. The design system carries no diff view at all: it paints no
 * green band anywhere, and the only red band it paints is the failure strip (`danger` on
 * `dangerDim`), which means something else. Rather than invent a diff palette, this component
 * carries the semantics on the signs and leaves both rows on the ordinary `background` — and
 * exposes `addedBackground`/`removedBackground` so a project whose own design system declares
 * diff hues can supply them. Passing the theme background EXPLICITLY is also what keeps
 * `@opentui/core`'s hard-coded `#1a4d1a`/`#4d1a1a` bands out of an authored page.
 *
 * Selection colours are passed from the theme but are not props: selection is host-driven chrome,
 * not page styling. The syntax-highlighting client is never exposed (spec §6).
 */
export function Diff(props: DiffProps) {
  const tokens = activeTokens();
  // EVERY colour is passed. A prop left undefined is not "inherit" — `@opentui/core` substitutes
  // a hard-coded hue of its own (#888888 gutter, #22c55e/#ef4444 signs, #1a4d1a/#4d1a1a bands),
  // which would put an off-palette colour into an authored page. Tests beside this file assert
  // none of those five reaches a frame.
  const background = tokens.background;
  return (
    <diff
      id={props.id}
      diff={props.patch}
      view={props.view ?? "unified"}
      showLineNumbers={props.showLineNumbers}
      wrapMode={props.wrap}
      fg={props.color ?? tokens.foreground}
      lineNumberFg={props.lineNumberColor ?? tokens.foregroundFaint}
      lineNumberBg={background}
      addedSignColor={props.addedColor ?? tokens.success}
      removedSignColor={props.removedColor ?? tokens.danger}
      addedBg={props.addedBackground ?? background}
      removedBg={props.removedBackground ?? background}
      contextBg={background}
      addedLineNumberBg={background}
      removedLineNumberBg={background}
      selectionBg={tokens.selection}
      selectionFg={tokens.selectionFg}
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/runtime/ui/diff.test.tsx`
Expected: PASS — 10 tests.

If the split-view assertion fails, widen the renderer rather than weakening the assertion — a
60-column frame fit both sides when this plan was written; a narrower one truncates them.

- [ ] **Step 5: Export from the facade (append-only)**

In `src/runtime/index.ts`, append after the `LineNumber` pair from Task 1:

```ts
export { Diff } from "./ui/diff";
export type { DiffProps } from "./ui/diff";
```

- [ ] **Step 6: Update the facade contract test**

In `src/runtime/index.test.ts`, add `"Diff"` to the end of the catalog name array and raise the
count in the test title from `14-component` to `15-component`.

- [ ] **Step 7: Regenerate the declaration and confirm the agent-doc entry**

```bash
rtk bun run gen:runtime-dts
```

Read `src/runtime/generated/runtime.generated.d.ts` and confirm `interface DiffProps`,
`function Diff`, and the per-field JSDoc all landed — that file is the agent-facing documentation.

- [ ] **Step 8: Bump the corpus canary**

This task adds **2** files (`diff.tsx`, `diff.test.tsx`). Re-read the current number (Task 1
already moved it), raise it by 2 in `src/gate/model/lexer.test.ts`, append the history line:

```
    // The same plan's second task adds `runtime/ui/diff.tsx` and its own `diff.test.tsx`,
    // taking it to <N+2>.
```

and update the matching number in `src/gate/model/lexer.oracle.test.ts`'s test name.

- [ ] **Step 9: Run the affected suites**

```bash
rtk bun x tsc --noEmit
rtk bun test src/runtime/
rtk bun test src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts
rtk bun run lint && rtk bun run fmt:check
```

Expected: `tsc` silent; all suites pass.

- [ ] **Step 10: Commit**

```bash
rtk git add src/runtime/ui/diff.tsx src/runtime/ui/diff.test.tsx \
  src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated \
  src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts
rtk git commit -m "feat(runtime): add the Diff patch-view wrapper"
```

---

### Task 3: Architecture docs

**Files:**
- Modify: `docs/architecture/modules.md:233` (the `src/runtime/ui/` bullet)
- Verify only: `docs/architecture/modules.ru.md` (expected to need no edit — see Step 2)

**Interfaces:**
- Consumes: the two wrappers from Tasks 1 and 2 and their exported names.
- Produces: nothing code-facing. This is the CLAUDE.md "Architecture docs maintenance" obligation
  and spec §10.1's "architecture-doc updates for a plan's own modules happen inside that plan".

- [ ] **Step 1: Update the English bullet**

`docs/architecture/modules.md:233` currently opens:

```
- `src/runtime/ui/` (14 components — primitive, row, column, panel, separator, spacer, text, button, input, tabs, list, table, gauge, sparkline) — the themed component catalog; …
```

Change the count and the list to include the two new names, and append one clause recording the
two facts a reader of this doc needs — the `LineNumber` single-child rule and the `Diff`
background gap. Replace the parenthetical and append to the sentence so it reads:

```
- `src/runtime/ui/` (16 components — primitive, row, column, panel, separator, spacer, text, button, input, tabs, list, table, gauge, sparkline, line-number, diff) — the themed component catalog; every colour prop (`borderColor`, `titleColor`, `background`, …) is typed as `Color`, and every component's own default resolves against the active theme's core roles (`activeTokens()`'s `border`, `foreground`, `accent`, …), not a compiled-in constant; every component is real, but `Button.onPress`/`Input.onChange`/`Tabs.onSelect`/`List.onSelect` are wired to the correct OpenTUI handler and stay inert in the current static render, and `Separator` renders a plain color band where the design specifies glyph rules with weld tees (documented in-file as a divergence pending the phase-7 UI pass). Two wrapper-specific contracts live in-file rather than here: `LineNumber` numbers exactly ONE text-like child, because the underlying renderable adopts the first child reporting line information as its target and silently refuses the rest (its `target` is a renderer object and is deliberately not a prop), and a non-text child leaves it drawing nothing; and `Diff` paints NO background band behind added/removed rows, because the design system carries no diff view to take one from — the `+`/`-` signs carry the semantics in `success`/`danger`, and `addedBackground`/`removedBackground` are open for a project design system that declares its own diff hues. Every colour both wrappers accept is passed to the intrinsic explicitly: a prop left unset makes `@opentui/core` substitute a hard-coded hue of its own (`#888888`, `#22c55e`, `#1a4d1a`, …), which is off-palette in every project.
```

**Do not touch** the `src/runtime/model/tokens.ts` or `src/runtime/index.ts` bullets — no other
plan's rows either.

- [ ] **Step 2: Confirm the Russian mirror needs no change**

`docs/architecture/modules.ru.md` is a 61-line summary of the 304-line English document: it
carries the seven-component table and the numbered runtime-loop prose, and **no per-file bullets
at all**. Its Runtime-facade row (line 45) says "полный компонент каталог" without a count, so it
does not go stale when the catalog grows.

```bash
rtk git grep -n "src/runtime/ui\|sparkline" -- docs/architecture/modules.ru.md
```

Expected: no hit for `src/runtime/ui`. **If that changes** — i.e. someone has since expanded the
Russian file to mirror the per-file section — add the same bullet there in Russian, matching that
file's register, keeping every identifier, hex value and file path in Latin script. Otherwise
leave the file untouched and record in the commit body that no mirror edit was required.

- [ ] **Step 3: Verify no other anchor went stale**

```bash
rtk git grep -n "14 components" -- docs/
rtk git grep -n "13-component" -- src/ docs/
```

Expected: no hits outside historical plan documents under `docs/superpowers/plans/` (those are
dated records and are never rewritten).

- [ ] **Step 4: Commit**

```bash
rtk git add docs/architecture/modules.md
rtk git commit -m "docs(architecture): record the Diff and LineNumber wrappers"
```

(Add `docs/architecture/modules.ru.md` to the `add` list only if Step 2 found a mirror to update.)

---

### Task 4 (LAYER 2 — DEFERRABLE): `Diff` syntax highlighting through P8's `SyntaxStyle` builder

> **Read this before starting.** This task consumes P8 (`wrappers-code-markdown`). **If P8 has
> not merged into the feature branch, SKIP this task entirely, leave it unchecked, and finish the
> plan at Task 3.** Layer 1 is complete and shippable without it — spec §10.1: *"its plain render
> lands independently, the highlight wiring joins at whichever merge comes second."* If P9 merges
> first, this task is executed later, on the feature branch, as a small follow-up commit.
>
> Before writing a line, verify the two assumed signatures in the "P8 interface assumption"
> section against P8's merged code and adapt the call sites. **Do not re-implement either helper.**

**Files:**
- Modify: `src/runtime/ui/diff.tsx` (add `language`, build and pass `syntaxStyle`)
- Modify: `src/runtime/ui/diff.test.tsx` (add a highlight render test; replace the first export
  test with a highlighted-frame assertion)
- Regenerate: `src/runtime/generated/runtime-dts.ts`, `src/runtime/generated/runtime.generated.d.ts`

**Interfaces:**
- Consumes: P8's `buildSyntaxStyle(tokens: TokenMap): SyntaxStyle` from
  `../model/syntax-style` (ASSUMED name/path/signature) and P8's `renderSettled(handle, budgetMs?)`
  export-settle helper (ASSUMED). Also `DiffProps`/`Diff` from Task 2.
- Produces: `DiffProps.language?: string`. No later task depends on it.

- [ ] **Step 1: Confirm the P8 surface before writing anything**

```bash
rtk git grep -n "SyntaxStyle" -- src/runtime
rtk git grep -rn "renderSettled\|settle" -- src/runtime src/host/render
```

Write down the real exported names and signatures. If the builder does not exist, **stop and
report** — do not write a second one. Only the two call sites below change to match.

- [ ] **Step 2: Write the failing test**

Append to `src/runtime/ui/diff.test.tsx` (adjusting the `renderSettled` import to P8's real
export):

```tsx
import { renderSettled } from "host/render/model/settle";

const TS_PATCH = `--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-const answer = 41
+const answer = 42
`;

// §6.1/§6.3: highlighting runs through tree-sitter and is ASYNCHRONOUS, and `DiffRenderable`
// exposes no public completion signal (unlike `CodeRenderable.highlightingDone`). So the frame
// is settled with P8's quiet-frames loop, and the snapshot asserts highlight PRESENCE — a
// silently failed worker degrades to plain text with no error surfaced, and a test that
// tolerated the absence would pass on a broken binary.
describe("Diff syntax highlighting (§6.1)", () => {
  test("a typescript patch paints a keyword in a hue other than the content foreground", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 5 });
    open = handle;
    handle.mount(<Diff id="patch" patch={TS_PATCH} language="typescript" />);
    await renderSettled(handle);
    const keyword = findRun(handle.capture(), "const");
    expect(keyword).toBeDefined();
    expect(keyword && extractRgb(keyword.fg)).not.toBe(themeTokens("dark-default").foreground);
  });

  test("an unhighlighted patch keeps the content foreground", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 5 });
    open = handle;
    handle.mount(<Diff id="patch" patch={TS_PATCH} />);
    await renderSettled(handle);
    const content = findRun(handle.capture(), "answer");
    expect(content && extractRgb(content.fg)).toBe<string>(themeTokens("dark-default").foreground);
  });
});
```

Then **replace** the body of the existing
`"two independent renders in export mode produce identical frames"` test so its `renderOnce`
mounts `<Diff id="patch" patch={TS_PATCH} language="typescript" />`, awaits `renderSettled(handle)`
instead of `handle.render()`, and — before comparing — asserts the captured frame carries a
highlighted run (the same `not.toBe(foreground)` check). Leave the second export test
(`export frame equals preview frame`) as it is.

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/runtime/ui/diff.test.tsx`
Expected: FAIL — `language` is not a prop of `DiffProps`.

- [ ] **Step 4: Wire the builder into the wrapper**

In `src/runtime/ui/diff.tsx`, add the import and the prop, and pass both through:

```tsx
import { buildSyntaxStyle } from "../model/syntax-style";
```

```tsx
  /**
   * The language whose grammar highlights the patch body — `typescript`, `javascript`,
   * `markdown`, `zig`. Omit it for plain text. Only the grammars `@opentui/core` embeds are
   * available; any other value renders plain rather than failing.
   */
  readonly language?: string;
```

and, inside the element:

```tsx
      filetype={props.language}
      // The style is BUILT from the active theme, never accepted as a prop: `SyntaxStyle` is a
      // renderer object and spec §6 keeps OpenTUI identities out of authored source. With no
      // `language` there is nothing to highlight, so the style is not built either — the
      // renderable falls back to an empty one on its own.
      syntaxStyle={props.language === undefined ? undefined : buildSyntaxStyle(tokens)}
```

Extend the component's doc comment with one paragraph: highlighting is asynchronous, the first
painted frame is unhighlighted, the export path settles before snapshotting, and a highlight
failure degrades to plain text with the diagnostic routed to `infrastructure/debug-log` by P8.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/runtime/ui/diff.test.tsx`
Expected: PASS.

If the highlight assertion fails while `Code`'s own P8 tests pass, do **not** loosen it — that is
the failure mode §6.1 says must stay loud. Check first whether `renderSettled`'s budget is long
enough for a two-`CodeRenderable` diff (it settles two highlight passes, not one); raising the
budget at this call site is a legitimate fix, tolerating an unhighlighted frame is not.

- [ ] **Step 6: Regenerate and verify**

```bash
rtk bun run gen:runtime-dts
rtk bun x tsc --noEmit
rtk bun test src/runtime/
rtk bun run lint && rtk bun run fmt:check
```

No corpus-canary change — this task adds no files.

- [ ] **Step 7: Commit**

```bash
rtk git add src/runtime/ui/diff.tsx src/runtime/ui/diff.test.tsx src/runtime/generated
rtk git commit -m "feat(runtime): highlight Diff through the theme's SyntaxStyle"
```

---

## Final verification

Run each of these and read the actual output before claiming the plan complete
(`superpowers:verification-before-completion`). The suites are separate commands on purpose:
`src/ui` and `src/entrypoint` render tests produce random failures when combined under load
(spec §11), and a bare `bun test` can die inside `Bun.Transpiler` without printing a single
`(fail)` line — `scripts/run-tests.ts` is the whole-suite gate that turns that into a loud third
outcome.

- [ ] **Type check.** `bun x tsc --noEmit` → silent.
- [ ] **Declaration is fresh.** `bun run gen:runtime-dts`, then
      `rtk git status --short src/runtime/generated` → no modification. A dirty file here means a
      task skipped its regeneration step.
- [ ] **The agent-doc entries exist.** `rtk git grep -n "function Diff\|function LineNumber" --
      src/runtime/generated/runtime.generated.d.ts` → both present, each preceded by its JSDoc.
- [ ] **Runtime.** `bun test src/runtime/` → pass.
- [ ] **Gate** (the corpus canary, plus fixtures compiling against the regenerated declaration):
      `bun test src/gate/` → pass. A canary failure names the exact expected/actual count — fix
      the number, never the walk.
- [ ] **Host** (the harness these tests drive): `bun test src/host/` → pass.
- [ ] **Shell render tests, separately:** `bun test src/ui/` → pass. Then
      `bun test src/entrypoint/` → pass. **Never as one command.**
- [ ] **Whole suite through the crash gate:** `bun run test` → exits 0. Exit 2 is a CRASH, never a
      pass; re-run once to get a verdict.
- [ ] **Lint and format:** `bun run lint && bun run fmt:check` → clean.
- [ ] **Reatom audit.** This plan adds no atom, computed or action — only two components that call
      the existing `activeTokens()`. Run `/reatom-audit` anyway (it is incremental and cheap); the
      expected result is no findings. If it flags a component-body atom, something was written
      that this plan does not describe.
- [ ] **No hex literal escaped into a wrapper.**
      `rtk git grep -nE "#[0-9a-f]{6}" -- src/runtime/ui/diff.tsx src/runtime/ui/line-number.tsx`
      → **no hits**. Hex belongs only in the tests (as expected values) and in the theme.
- [ ] **Code review:** `superpowers:requesting-code-review` before offering the worktree for merge.

## Deliberately left alone

Each is another plan's scope. Listed so the executor does not pull them in and so the reviewer can
check them off.

1. **`src/agent/prompt/model/runtime-authoring-guide.md` is not touched.** It still teaches
   "Colors are semantic token names from one closed set — never raw hex", which the new colour
   model inverts. Rewriting it is **P4**'s (spec §10 Track A). Adding two component paragraphs to a
   document that is about to be rewritten wholesale would only create a merge conflict.
2. **No `Code`, `Markdown`, `Textarea`, `Slider`, `ScrollBox` — and no `extend()` call.** P5–P8.
   `Diff` and `LineNumber` are built-in intrinsics and need none of P5's registration machinery.
3. **`Diff`'s parse-error frame is not intercepted.** A patch whose hunk header disagrees with its
   body paints `@opentui/core`'s own error message in its own hard-coded red. Catching that would
   mean parsing the patch in the wrapper — a second parser that must agree with jsdiff forever.
   Recorded in the component's doc comment and in "Open gaps" below.
4. **`examples/clock` is never edited** (spec §9): the migration is exercised by *opening* the
   project, in the closeout.

## Open gaps — for the human, not for an implementer to close

1. **The diff palette is a real design gap (D4).** The design system has no diff view, no green
   band, and its only red band means "failure". This plan resolves it by declining to paint a band
   and exposing `addedBackground`/`removedBackground` for a project to fill. **If diff rows should
   carry bands, the design owner must name the hues** — most naturally as project tokens
   (`diffAddedBg`, `diffRemovedBg`) in the design-system manifest, which §4.1 explicitly permits
   beyond the core seventeen. No implementer should pick them.
2. **The gutter's role assignment (D5) is a mapping, not a quotation.** `foregroundFaint` on
   `background` is the closest faithful reading of the design's own vocabulary, because the design
   draws no gutter at all. Worth a design-owner confirmation, non-blocking.
3. **`Diff` has no public highlight-completion signal.** Layer 2 therefore depends on P8's
   quiet-frames settle loop rather than on a promise. If a future `@opentui/core` exposes one on
   `DiffRenderable`, the settle loop at that call site should be replaced by it.
4. **`LineNumber`'s silent child drop is a vendor behaviour, not a wrapper choice.** The wrapper
   documents and tests it; it cannot prevent it without inspecting children, which React props
   do not usefully allow here. If it proves to be a real authoring trap in live turns, the fix
   belongs in the agent-facing docs, not in the wrapper.
