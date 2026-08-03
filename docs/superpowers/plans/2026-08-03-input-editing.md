# Input Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shell's append-only text inputs with one shared editable buffer — cursor navigation, word operations, multi-line entry with word wrap and bounded growth, and cursor-following scroll — behind the Workspace composer, the Home prompt, the pin-input popup and the slash-menu filter.

**Architecture:** OpenTUI's `TextareaRenderable`/`InputRenderable` own the buffer and the terminal's hardware cursor; the existing `Atom<string>` becomes a downstream mirror written by the editor's `onContentChange`. `App.tsx`'s global `useKeyboard` stays the top-level router and claims a key by calling `preventDefault()` exactly when `resolveKey` returned an intent other than `none` — everything else falls through to the focused editor. External writes (post-accept clear, F6 repair fill, slash open/submit) go through one named action that writes the atom and the editor handle together.

**Tech Stack:** Bun 1.3.14+, TypeScript 7.0.2 (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), React 19 via `@opentui/react@0.4.5` (`jsxImportSource`), `@opentui/core@0.4.5`, `@reatom/core@1001` + `@reatom/react@1001`, `bun:test`.

**Source spec:** `docs/superpowers/specs/2026-08-02-input-editing-design.md`. Every `§` reference below points into it.

---

## Global Constraints

- **No change outside `src/ui/`.** `core`, `store`, `host`, `agent`, `gate`, `runtime`, `entrypoint` and the wire protocol are untouched. `turn.start`'s payload stays `{ text }` and merely gains the ability to carry `\n`.
- **Module shape.** Every module is `module/{model/,ui/,types.ts,index.ts}`. `types.ts` holds shared types, `index.ts` is the public entry point. Code never sits loose at a module root.
- **Imports.** Cross-module imports use the `tsconfig.json` path aliases (`ui/...`, `core/...`, `infrastructure/...`). Relative imports (`./`, `../`) only inside one module. Never alias under `@termcraft/*`.
- **Design is the source of truth.** Colours come from `SHELL_PALETTE` (`ui/theme`, mirroring `design/termcraft-engine.js`'s `pal`). The one approved divergence is the composer/prompt growth ceiling (§3), recorded in the code comments this plan specifies verbatim.
- **Reatom.** Callbacks invoked later from outside Reatom (`onContentChange`, `ref`) are created with `bind(...)` inside `createUiDeps` (RTM-A06). React event handlers that touch atoms use `useWrap` (RTM-C02). Every atom and action is named (RTM-S05). No atoms in component bodies.
- **errore.** No new throwing paths are introduced; nothing in this feature returns `Error`. The existing `errore` conventions in `deps.ts` are left as they are.
- **No React hooks from `react`.** The repo ships no `@types/react`, so `import { useRef } from "react"` is a TS7016 error (see `host/render/model/error-capture.ts:28`). Only `@opentui/react`'s and `@reatom/react`'s own hooks are available. Every "stable across renders" requirement in this plan is met by putting the callback on `deps` (created once by `createUiDeps`), never by memoising in a component.
- **Test commands.** `bun test src/ui` and `bun test src/entrypoint` are run as **separate** commands — OpenTUI render tests flake under load when both run in one process. A crashed run prints no `(fail)` lines and reads as clean, so re-run before calling anything a regression.
- **Typecheck.** `bunx tsc --noEmit` must exit 0 at the end of every task.
- **Lint/format.** `bun run lint` (oxlint) and `bun run fmt` (oxfmt) before each commit.
- **Commits.** One commit per task, on branch `worktree-input-editing`. Use `rtk git ...` for git commands; write commit messages to a file and pass `-F <path>` (heredoc stdin is swallowed by the wrapper).

---

## Spec Gaps Resolved Before Writing This Plan

Each of these was measured against the installed `@opentui/core@0.4.5` while writing the plan. The spec asserts something that does not hold; the resolution is stated once here and is assumed by every task below.

**G1 — `Ctrl+←`/`Ctrl+→` are already bound to page stepping.** §6.4 and §9.2 promise that `Ctrl+←`/`Ctrl+→` reach the editor as word movement, with no degradation in either keyboard mode. But `ui/actions/model/registry.ts` registers them as **aliases** of `ctrl+b`/`ctrl+n` (`page.prev`/`page.next`), and `resolveHotkey` runs before every input branch, so the App would claim them forever. **Resolution: drop the two aliases** (Task 7). `ctrl+b`/`ctrl+n` stay the page-step keys — the registry's own comment already names them the reliable primary ("one byte, no encoding to get wrong") and the arrows merely "still work wherever it IS encoded". Nothing on screen names the arrows: both entries carry `hint: false`, so `Workspace.tsx`'s key row never drew them. Keeping them would ship a text editor whose `Ctrl+←` switches pages instead of moving by word — the exact "advertised but wrong" trap this codebase has already fixed twice.

**G2 — `mergeKeyBindings` / `buildKeyBindingsMap` / `getKeyBindingAction` are not importable.** §10.1 asserts the binding table "through OpenTUI's own lookup". Those helpers live in `lib/keybinding.internal.js`, which is neither re-exported from the package index nor reachable by deep import (`package.json`'s `exports` map has no wildcard). **Resolution:** assert the table by driving a real `TextareaRenderable` with `createTestRenderer` + `createMockKeys` in both keyboard modes. That is still OpenTUI's own resolution path, exercised end to end rather than through internals.

**G3 — `mergeKeyBindings` is not needed at all.** Measured: passing a two-row `keyBindings` array to `TextareaRenderable` leaves every default binding working (`backspace` still deleted). The renderable merges our table over the defaults internally. **Resolution:** pass our rows and nothing else.

**G4 — `stringWidth` is not exported.** §6.3 specifies `stringWidth` from `@opentui/core`; it is declared in `platform/runtime.d.ts` but the index re-exports only `resolveBundledFilePath` from that file. **Resolution:** use `Bun.stringWidth`, the same measurement, already covered by the project's only ambient type set (`"types": ["bun"]`).

**G5 — the lingering-cursor open item is closed, and `captureCharFrame()` cannot test it.** §11.1 leaves "does a focused editor with `showCursor` false leave a cursor behind" open, and §10.2 proposes asserting it from `captureCharFrame()`. The cursor is the terminal's hardware cursor and never enters the character frame, so that assertion would be vacuous. Measured through `renderer.getCursorState()`: `showCursor = false` on a focused editor reports `visible: false`, and flipping back reports `visible: true` at the right column. **Resolution:** no fallback is needed; the test asserts `getCursorState().visible`.

**G6 — the editor's text cannot be a prop.** §7.2 wants the mirror to seed the editor at mount. A `value`/`initialValue` prop that tracks the atom would be re-applied on every keystroke (`InputRenderable.value` is a live setter), moving the cursor to the end mid-edit; and pinning the seed with `useRef` is impossible (see Global Constraints). **Resolution:** `TextEditor` receives no text at all. The parent seeds it from the mirror inside the ref sink (`EditorBridge.attach`), which runs exactly once per mount because the sink is created once by `createUiDeps`.

**G7 — spec §10.4's manual step cannot be automated.** `infrastructure/debug-log`'s sink is disabled whenever `NODE_ENV=test` unless an explicit `TERMCRAFT_DEBUG_LOG` path is set, so a test cannot observe `trace("ui.onKey", …)`. Task 1 therefore ships the diagnostic and a **manual** verification, exactly as §10.4 asks.

### Measured reference data

These numbers came from `TextareaRenderable.virtualLineCount` with `wrapMode: "word"` and are the expected values the tests below assert.

| text | width | rows |
| --- | --- | --- |
| `""` | 10 | 1 |
| `"abc"` | 10 | 1 |
| `"abcdefghij"` | 10 | 1 |
| `"abcdefghijk"` | 10 | 2 |
| `"hello world again"` | 10 | 3 |
| `"a\nb"` | 10 | 2 |
| `"abc\n"` | 10 | 2 |
| `"a\n\nb"` | 10 | 3 |
| `"supercalifragilisticexpialidocious"` | 10 | 4 |
| `"日本語日本語日本語"` | 10 | 2 |
| `"hello world"` | 11 | 1 |
| `"hello world"` | 10 | 2 |
| `"aaaa bbbb"` | 4 | 3 |
| `"abcdefghijkl mn"` | 10 | 2 |
| `"hello "` | 6 | 1 |
| `"hello "` | 5 | 2 |
| `"  ab"` | 4 | 1 |
| `"a  b"` | 3 | 2 |
| `"abc"` | 1 | 3 |
| `"ab cdefghijklmnopqr"` | 10 | 3 |
| `"ab 日本語日本語"` | 10 | 3 |

Chord parsing, re-verified through `parseKeypress` in both modes (§4.4's table holds exactly):

| chord | legacy | kitty |
| --- | --- | --- |
| `Shift+Enter` (`CSI 13;2u`) | no name at all | `return` + shift, `source: "kitty"` |
| `Ctrl+J` (`\n`) | `linefeed` | `linefeed` |
| `Alt+Enter` (`ESC \r`) | `return` + meta | `return` + meta |
| `Ctrl+Backspace` (`0x08`) | `backspace`, **no ctrl** | `backspace`, **no ctrl** |
| `Ctrl+Backspace` (`CSI 127;5u`) | no name at all | `backspace` + ctrl |
| `Ctrl+Shift+Z` (`CSI 122;6u`) | no name at all | `z` + ctrl + shift |
| numpad Enter (`CSI 57414u`) | no name at all | `kpenter` |
| `Ctrl+W` / `Ctrl+Z` / `Ctrl+Y` / `Ctrl+A` | `w`/`z`/`y`/`a` + ctrl | same |

Relevant OpenTUI defaults (`defaultTextareaKeyBindings`, 64 rows): `return`/`kpenter`/`linefeed` → `newline`; `meta+return` → `submit`; `ctrl+a` → `line-home`; `ctrl+e` → `line-end`; `ctrl+b` → `move-left`; `ctrl+w` and `ctrl+backspace` → `delete-word-backward`; `ctrl+delete` → `delete-word-forward`; `ctrl+left`/`ctrl+right` → `word-backward`/`word-forward`; undo/redo only on `ctrl+-`, `ctrl+.`, `super+z`, `shift+super+z`. No `ctrl+n`/`ctrl+p` default exists, so those two registry hotkeys collide with nothing.

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `src/ui/text-input/model/editor-height.ts` | `editorMaxRows`, `wrappedLineCount`, `editorRowCount` — the growth ceiling and visual-line counting |
| `src/ui/text-input/model/editor-height.test.ts` | its unit tests, incl. the early-exit equivalence |
| `src/ui/text-input/model/key-bindings.ts` | `TEXT_EDITOR_KEY_BINDINGS` — our rows over OpenTUI's defaults |
| `src/ui/text-input/model/key-bindings.test.ts` | behavioural assertion of the table in both keyboard modes |
| `src/ui/text-input/ui/TextEditor.tsx` | the caret run plus `<textarea>` (multiline) or `<input>` (single-line) |
| `src/ui/text-input/ui/TextEditor.test.tsx` | seeding, mirroring, focus/cursor split, growth, newline stripping |
| `src/ui/app/model/primary-input.ts` | `setPrimaryInput` / `mirrorPrimaryInput` / `createEditorBridge` — the two directions and the slash-closing rule |
| `src/ui/app/model/primary-input.test.ts` | both directions, the missing-handle path, the three slash-closing rules |
| `src/ui/text-input/ui/input-editing.test.tsx` | the cross-cutting integration tests (two-mode run, scroll, budget, conformance, cursor) |

**Modified**

| File | Change |
| --- | --- |
| `src/ui/text-input/types.ts` | `TextInputProps` → `TextEditorHandle`, `EditorBridge`, `TextEditorProps` |
| `src/ui/text-input/index.ts` | new public surface |
| `src/ui/app/model/deps.ts` | three handle atoms on `UiLocalState`, `editors` on `UiDeps` |
| `src/ui/app/model/keymap.ts` | `KeyLike` gains `shift`/`meta`; seven editing intent kinds removed; the claim rule |
| `src/ui/app/model/intent.ts` | external writes route through `setPrimaryInput`; dead arms deleted |
| `src/ui/app/ui/App.tsx` | `preventDefault()` on a claimed key, `source` in the key trace, `activeOverlay` to `Workspace`, editor props for Home and the pin popup |
| `src/ui/actions/model/registry.ts` | drop the `ctrl+left`/`ctrl+right` aliases (G1) |
| `src/ui/workspace/types.ts` | `WorkspaceLocalState.composerEditor`, `WorkspaceDeps.editors`, `WorkspaceProps.activeOverlay` |
| `src/ui/workspace/ui/Workspace.tsx` | composer editor wiring, row budget from the real editor height |
| `src/ui/workspace/model/agent-block-budget.ts` | `composerRowCount(hasAttach, editorRows)` |
| `src/ui/chat/ui/Composer.tsx` | renders `TextEditor` |
| `src/ui/home/ui/Home.tsx` | renders `TextEditor`, prompt box grows |
| `src/ui/popups/ui/PinInputPopup.tsx` | renders `TextEditor` |
| `docs/architecture/modules.md`, `docs/architecture/code-structure.md`, `docs/architecture/flows/interactive-prototype.md` | the three lines naming `TextInput` / the keymap / the arrow aliases |

**Deleted**

- `src/ui/text-input/ui/TextInput.tsx`
- `src/ui/text-input/ui/TextInput.test.tsx`

---

### Task 1: Keyboard-mode diagnostic and the manual reading (§10.4)

Nothing downstream depends on the answer, but §10.4 asks for it first, and it is the only way to know which chords this machine's terminal can deliver at all.

**Files:**
- Modify: `src/ui/app/ui/App.tsx:206-215`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. Produces one recorded fact — whether this terminal reports `source: "kitty"` — written into the task's commit message.

- [ ] **Step 1: Add `source` to the key trace**

In `src/ui/app/ui/App.tsx`, inside `trace("ui.onKey", …)`'s `key` object, add one field after `eventType`:

```tsx
      key: {
        name: key.name,
        sequence: key.sequence,
        raw: key.raw,
        ctrl: key.ctrl,
        shift: key.shift,
        meta: key.meta,
        option: key.option,
        eventType: key.eventType,
        // Which parser produced this key: "kitty" only when the terminal actually answered the
        // extended-protocol request `createCliRenderer` makes by default (§4.3). This is the ONLY
        // honest signal — `renderer.useKittyKeyboard` reports what we REQUESTED, not what the
        // terminal implements — and it is deliberately after-the-fact: adequate for diagnosis,
        // inadequate for driving UI, which is why the fallback chords (§4.4) are always bound
        // rather than gated on detection.
        source: key.source,
      },
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Read the keyboard mode from a real run**

Run the app in a scratch directory and press the three chords in the Home prompt:

```bash
mkdir -p /tmp/tc-keyprobe && cd /tmp/tc-keyprobe
TERMCRAFT_DEBUG_LOG=1 bun run <repo>/src/main.tsx
```

Press, in order: `Shift+Enter`, `Ctrl+Backspace`, `Ctrl+Shift+Z`, then `Ctrl+C` to quit. Then read the run file:

```bash
cat termcraft-debug/run-*.jsonl | grep '"ui.onKey"' | tail -20
```

Expected, on a Kitty-protocol terminal: three lines whose `key.source` is `"kitty"`, with `name: "return", shift: true`, `name: "backspace", ctrl: true`, and `name: "z", ctrl: true, shift: true`. On a legacy terminal: `Shift+Enter` and `Ctrl+Shift+Z` produce **no line at all** (the bytes do not exist), and `Ctrl+Backspace` produces `name: "backspace", ctrl: false, source: "raw"`.

- [ ] **Step 4: Commit, recording the answer**

```bash
printf '%s\n' \
  'feat(ui): trace the keyboard parser source on every key' \
  '' \
  'Records whether the terminal answered the extended (kitty) keyboard request,' \
  'which decides whether Shift+Enter / Ctrl+Backspace / Ctrl+Shift+Z can be' \
  'delivered at all (spec 4.4). Manual reading on this machine: <kitty|legacy>.' \
  > /tmp/tc-commit-msg.txt
rtk git add src/ui/app/ui/App.tsx && rtk git commit -F /tmp/tc-commit-msg.txt
```

Replace `<kitty|legacy>` with what Step 3 actually showed. Do not guess it.

---

### Task 2: `editor-height.ts` — the growth ceiling and the visual-line counter

**Files:**
- Create: `src/ui/text-input/model/editor-height.ts`
- Test: `src/ui/text-input/model/editor-height.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `editorMaxRows(frameH: number): number`
  - `wrappedLineCount(text: string, width: number, maxRows?: number): number`
  - `editorRowCount(input: { text: string; width: number; frameH: number }): number`

- [ ] **Step 1: Write the failing test**

Create `src/ui/text-input/model/editor-height.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { editorMaxRows, editorRowCount, wrappedLineCount } from "./editor-height";

/**
 * Every expectation below was read off `TextareaRenderable.virtualLineCount` with
 * `wrapMode: "word"` at `@opentui/core@0.4.5` — measured, not derived. `input-editing.test.tsx`'s
 * conformance test re-checks a subset against the live renderable so this table cannot silently
 * drift away from the layout it is mirroring.
 */
const WRAP_CASES: ReadonlyArray<readonly [string, number, number]> = [
  ["", 10, 1],
  ["abc", 10, 1],
  ["abcdefghij", 10, 1],
  ["abcdefghijk", 10, 2],
  ["hello world again", 10, 3],
  ["a\nb", 10, 2],
  ["abc\n", 10, 2],
  ["a\n\nb", 10, 3],
  ["supercalifragilisticexpialidocious", 10, 4],
  ["日本語日本語日本語", 10, 2],
  ["hello world", 11, 1],
  ["hello world", 10, 2],
  ["aaaa bbbb", 4, 3],
  ["abcdefghijkl mn", 10, 2],
  ["hello ", 6, 1],
  ["hello ", 5, 2],
  ["  ab", 4, 1],
  ["a  b", 3, 2],
  ["abc", 1, 3],
  ["ab cdefghijklmnopqr", 10, 3],
  ["ab 日本語日本語", 10, 3],
];

describe("editorMaxRows — the approved growth ceiling (spec §3)", () => {
  test("is a proportion of the frame, clamped to [1, 6]", () => {
    expect(editorMaxRows(4)).toBe(1);
    expect(editorMaxRows(8)).toBe(2);
    expect(editorMaxRows(22)).toBe(5);
    expect(editorMaxRows(24)).toBe(6);
    expect(editorMaxRows(100)).toBe(6);
  });

  test("never yields zero, however small the frame", () => {
    expect(editorMaxRows(0)).toBe(1);
    expect(editorMaxRows(3)).toBe(1);
  });
});

describe("wrappedLineCount — word wrap with a character-break fallback (spec §4.2)", () => {
  for (const [text, width, rows] of WRAP_CASES) {
    test(`${JSON.stringify(text)} at width ${width} occupies ${rows} row(s)`, () => {
      expect(wrappedLineCount(text, width)).toBe(rows);
    });
  }

  test("measures display width, not code units — a CJK line is twice as wide", () => {
    expect(wrappedLineCount("日本語日本語日本語", 10)).toBe(2);
    expect(wrappedLineCount("abcdefghi", 10)).toBe(1);
  });

  test("the early exit agrees with the untruncated count everywhere the caller clamps", () => {
    // The contract: with a cap, the answer is min(true count, cap + 1). Since `editorRowCount`
    // clamps to the cap, every value the caller can observe is identical either way — which is
    // what makes the exit free rather than a behaviour change (§9.4).
    for (const [text, width] of WRAP_CASES) {
      const full = wrappedLineCount(text, width);
      for (let cap = 1; cap <= 6; cap += 1) {
        expect(wrappedLineCount(text, width, cap)).toBe(Math.min(full, cap + 1));
      }
    }
  });

  test("a megabyte of text is counted without scanning all of it", () => {
    const huge = "word ".repeat(200_000);
    expect(wrappedLineCount(huge, 40, 6)).toBe(7);
  });
});

describe("editorRowCount — what the composer and the prompt actually render", () => {
  test("one row while the text fits one row — the design's own composer, unchanged", () => {
    expect(editorRowCount({ text: "", width: 40, frameH: 35 })).toBe(1);
    expect(editorRowCount({ text: "Ask for changes", width: 40, frameH: 35 })).toBe(1);
  });

  test("grows with the text up to the ceiling, then stops", () => {
    expect(editorRowCount({ text: "a\nb\nc", width: 40, frameH: 35 })).toBe(3);
    expect(editorRowCount({ text: "a\nb\nc\nd\ne\nf\ng\nh", width: 40, frameH: 35 })).toBe(6);
  });

  test("the ceiling follows the frame, so a small terminal grows less", () => {
    expect(editorRowCount({ text: "a\nb\nc\nd\ne\nf\ng", width: 40, frameH: 23 })).toBe(5);
    expect(editorRowCount({ text: "a\nb\nc\nd\ne\nf\ng", width: 40, frameH: 8 })).toBe(2);
  });

  test("a zero or negative width still reports at least one row", () => {
    expect(editorRowCount({ text: "abc", width: 0, frameH: 35 })).toBe(3);
    expect(editorRowCount({ text: "", width: -5, frameH: 35 })).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/ui/text-input/model/editor-height.test.ts`
Expected: FAIL — `Cannot find module './editor-height'`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/text-input/model/editor-height.ts`:

```ts
/**
 * The editor's vertical budget: how tall the composer / Home prompt may grow, and how many
 * visual rows a given string occupies inside a given width.
 *
 * APPROVED DESIGN DIVERGENCE (spec §3 — recorded, not assumed). `design/termcraft-engine.js`
 * draws the composer as a fixed four-row block anchored at `frameH - 4` (`drawChat` `:222`,
 * `workspace` `:570`) with the input on exactly ONE row (`composerTop + 2`, `:256`, `:594`), and
 * none of the 27 `design/*.dc.html` frames shows a multi-row, grown, or scrolled input. The
 * divergence: the editor takes one row while the text fits one row, grows downward to
 * {@link editorMaxRows}, and scrolls internally past it. The ceiling is a PROPORTION rather than
 * a bare constant because at `MIN_FRAME` (80×24) a fixed six rows would squeeze the scrollback to
 * nothing while `agentStatusMaxRows` sat on its floor of 3. At one row every derived value
 * reduces to today's numbers exactly, so the single-row case stays pixel-identical to the design.
 */

/** The largest number of rows the editor may occupy in a frame `frameH` rows tall. */
export function editorMaxRows(frameH: number): number {
  return Math.min(6, Math.max(1, Math.floor(frameH / 4)));
}

/**
 * Display width in terminal cells.
 *
 * `Bun.stringWidth`, not `String.length`: a CJK or emoji line is twice as wide as its code-unit
 * count and would desynchronise this counter from the native layout. `@opentui/core` has its own
 * `stringWidth` but does not export it — it is declared in `platform/runtime.d.ts` while the
 * package index re-exports only `resolveBundledFilePath` from that file, and `package.json`'s
 * `exports` map has no wildcard, so a deep import cannot reach it either. Bun's built-in is the
 * same measurement and is already this project's only ambient type set (`tsconfig.json`'s
 * `"types": ["bun"]`).
 */
function cellWidth(value: string): number {
  return Bun.stringWidth(value);
}

/**
 * One logical line's tokens: maximal runs of non-space characters, and each space on its own.
 *
 * A space is its own token because that is what the native layout does with one carried past a
 * wrap — `"aaaa bbbb"` at width 4 measures THREE rows, not two, because the space that no longer
 * fits after `aaaa` occupies the first cell of the next row rather than being swallowed.
 */
function tokenize(line: string): readonly string[] {
  return line.match(/ |[^ ]+/g) ?? [];
}

/** Visual rows for ONE logical line, stopping as soon as `budget` rows have been reached. */
function wrapRows(line: string, width: number, budget: number): number {
  if (line === "") return 1;
  let rows = 1;
  let used = 0;
  for (const token of tokenize(line)) {
    if (rows >= budget) return rows;
    const tokenWidth = cellWidth(token);
    if (used + tokenWidth <= width) {
      used += tokenWidth;
      continue;
    }
    if (tokenWidth <= width) {
      rows += 1;
      used = tokenWidth;
      continue;
    }
    // Wider than the whole viewport: the native layout moves it to a fresh row first and only
    // then breaks it by display width (measured: `"ab cdefghijklmnopqr"` at width 10 is 3 rows,
    // not the 2 a continue-filling model would give).
    if (used > 0) {
      rows += 1;
      used = 0;
    }
    for (const char of token) {
      if (rows >= budget) return rows;
      const charWidth = cellWidth(char);
      if (used + charWidth > width) {
        rows += 1;
        used = 0;
      }
      used += charWidth;
    }
  }
  return rows;
}

/**
 * How many visual rows `text` occupies in a `width`-cell editor: `\n` splits, then each logical
 * line wraps at word boundaries with a character break for a word wider than the viewport.
 *
 * `maxRows` is an EARLY EXIT, not a clamp. The result is `min(true count, maxRows + 1)`, which
 * every caller that clamps to `maxRows` cannot tell apart from the untruncated count — so the
 * cost of counting stops depending on text length, which is what keeps a megabyte paste (§9.4)
 * from being rescanned every frame to produce a number that was going to be clamped to 6 anyway.
 */
export function wrappedLineCount(
  text: string,
  width: number,
  maxRows: number = Number.MAX_SAFE_INTEGER,
): number {
  const limit = Math.max(1, maxRows) + 1;
  const safeWidth = Math.max(1, width);
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += wrapRows(line, safeWidth, limit - rows);
    if (rows >= limit) return limit;
  }
  return rows;
}

/** The row count the editor actually renders at: its wrapped height, clamped to the ceiling. */
export function editorRowCount(input: {
  readonly text: string;
  readonly width: number;
  readonly frameH: number;
}): number {
  const ceiling = editorMaxRows(input.frameH);
  return Math.min(ceiling, wrappedLineCount(input.text, input.width, ceiling));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/ui/text-input/model/editor-height.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Typecheck, lint, format**

Run: `bunx tsc --noEmit && bun run lint && bun run fmt`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
printf '%s\n' 'feat(ui): add the editor height model — growth ceiling and visual line counting' > /tmp/tc-commit-msg.txt
rtk git add src/ui/text-input/model/editor-height.ts src/ui/text-input/model/editor-height.test.ts && rtk git commit -F /tmp/tc-commit-msg.txt
```

---

### Task 3: `key-bindings.ts` — our rows over OpenTUI's defaults

**Files:**
- Create: `src/ui/text-input/model/key-bindings.ts`
- Test: `src/ui/text-input/model/key-bindings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TEXT_EDITOR_KEY_BINDINGS: readonly KeyBinding[]` (`KeyBinding` is `@opentui/core`'s `KeyBinding<TextareaAction>`).

- [ ] **Step 1: Write the failing test**

Create `src/ui/text-input/model/key-bindings.test.ts`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import { TextareaRenderable } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createTestRenderer } from "@opentui/core/testing";

import { TEXT_EDITOR_KEY_BINDINGS } from "./key-bindings";

/**
 * The table is asserted THROUGH OPENTUI'S OWN RESOLUTION, by pressing real keys at a real
 * `TextareaRenderable`, not by reading the array back. Its internal lookup helpers
 * (`mergeKeyBindings`, `buildKeyBindingsMap`, `getKeyBindingAction`) live in
 * `lib/keybinding.internal.js`, which the package neither re-exports nor makes reachable by deep
 * import — `package.json`'s `exports` map has no wildcard entry. Driving the renderable is the
 * same resolution path, exercised end to end.
 */
let open: TestRendererSetup | null = null;
let editor: TextareaRenderable | null = null;

afterEach(() => {
  open?.renderer.destroy();
  open = null;
  editor = null;
});

async function mount(kittyKeyboard: boolean, initialValue = ""): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard });
  open = setup;
  const textarea = new TextareaRenderable(setup.renderer, {
    id: "kb-editor",
    width: 30,
    height: 6,
    wrapMode: "word",
    keyBindings: [...TEXT_EDITOR_KEY_BINDINGS],
    initialValue,
  });
  setup.renderer.root.add(textarea);
  textarea.focus();
  editor = textarea;
  await setup.renderOnce();
  return setup;
}

const text = (): string => editor?.plainText ?? "<no editor>";

describe("TEXT_EDITOR_KEY_BINDINGS — with the extended keyboard protocol", () => {
  test("Enter submits rather than inserting a line break (onSubmit is deliberately unwired)", async () => {
    const setup = await mount(true, "hello");
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    // `submit()` with no listener is a no-op. If the App ever fails to claim Enter the editor
    // refuses rather than silently breaking the line — a refusal beats a wrong action (§6.2).
    expect(text()).toBe("hello");
  });

  test("numpad Enter submits too — alias resolution is single-hop, so it needs its own row", async () => {
    const setup = await mount(true, "hello");
    setup.mockInput.pressKey("\u001b[57414u");
    await setup.renderOnce();
    expect(text()).toBe("hello");
  });

  test("Shift+Enter, Alt+Enter and Ctrl+J all insert a newline", async () => {
    const setup = await mount(true, "a");
    setup.mockInput.pressEnter({ shift: true });
    setup.mockInput.typeText("b");
    setup.mockInput.pressEnter({ meta: true });
    setup.mockInput.typeText("c");
    setup.mockInput.pressKey("\n");
    setup.mockInput.typeText("d");
    await setup.renderOnce();
    expect(text()).toBe("a\nb\nc\nd");
  });

  test("Shift+numpad-Enter inserts a newline", async () => {
    const setup = await mount(true, "a");
    setup.mockInput.pressKey("\u001b[57414;2u");
    setup.mockInput.typeText("b");
    await setup.renderOnce();
    expect(text()).toBe("a\nb");
  });

  test("Ctrl+Backspace and Ctrl+W both delete the word behind the cursor", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("alpha beta gamma");
    setup.mockInput.pressBackspace({ ctrl: true });
    await setup.renderOnce();
    expect(text()).toBe("alpha beta ");
    setup.mockInput.pressKey("\u0017");
    await setup.renderOnce();
    expect(text()).toBe("alpha ");
  });

  test("Ctrl+Delete deletes the word ahead of the cursor", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("alpha beta");
    setup.mockInput.pressKey("\u001b[1;5D");
    setup.mockInput.pressKey("\u001b[3;5~");
    await setup.renderOnce();
    expect(text()).toBe("alpha ");
  });

  test("Ctrl+Left and Ctrl+Right move by word", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("alpha beta");
    setup.mockInput.pressKey("\u001b[1;5D");
    setup.mockInput.typeText("X");
    await setup.renderOnce();
    expect(text()).toBe("alpha Xbeta");
    setup.mockInput.pressKey("\u001b[1;5C");
    setup.mockInput.typeText("Y");
    await setup.renderOnce();
    expect(text()).toBe("alpha XbetaY");
  });

  test("Ctrl+Z undoes and Ctrl+Shift+Z / Ctrl+Y redo — nothing usable exists in the defaults", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("abc");
    await setup.renderOnce();
    setup.mockInput.pressKey("\u001a");
    await setup.renderOnce();
    expect(text()).not.toBe("abc");
    setup.mockInput.pressKey("\u001b[122;6u");
    await setup.renderOnce();
    expect(text()).toBe("abc");
    setup.mockInput.pressKey("\u001a");
    await setup.renderOnce();
    setup.mockInput.pressKey("\u0019");
    await setup.renderOnce();
    expect(text()).toBe("abc");
  });

  test("Ctrl+A selects all rather than jumping to line start — the default is not removable", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("abcdef");
    setup.mockInput.pressKey("\u0001");
    setup.mockInput.typeText("Z");
    await setup.renderOnce();
    // select-all then a printable replaces the selection; line-home would have prefixed it.
    expect(text()).toBe("Z");
  });
});

describe("TEXT_EDITOR_KEY_BINDINGS — the universal fallbacks on a legacy terminal", () => {
  test("Ctrl+J still breaks the line where Shift+Enter cannot be encoded at all", async () => {
    const setup = await mount(false, "a");
    setup.mockInput.pressEnter({ shift: true });
    await setup.renderOnce();
    // The byte for Shift+Enter does not exist outside the extended protocol, so nothing arrives.
    expect(text()).toBe("a");
    setup.mockInput.pressKey("\n");
    setup.mockInput.typeText("b");
    await setup.renderOnce();
    expect(text()).toBe("a\nb");
  });

  test("Ctrl+W still deletes a word where Ctrl+Backspace collapses to a plain backspace", async () => {
    const setup = await mount(false, "");
    setup.mockInput.typeText("alpha beta");
    setup.mockInput.pressBackspace({ ctrl: true });
    await setup.renderOnce();
    // The parser reports `backspace` with NO ctrl for 0x08, so the word binding cannot fire.
    expect(text()).toBe("alpha bet");
    setup.mockInput.pressKey("\u0017");
    await setup.renderOnce();
    expect(text()).toBe("alpha ");
  });

  test("Ctrl+Y still redoes where Ctrl+Shift+Z cannot be encoded", async () => {
    const setup = await mount(false, "");
    setup.mockInput.typeText("abc");
    await setup.renderOnce();
    setup.mockInput.pressKey("\u001a");
    await setup.renderOnce();
    expect(text()).not.toBe("abc");
    setup.mockInput.pressKey("\u0019");
    await setup.renderOnce();
    expect(text()).toBe("abc");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/ui/text-input/model/key-bindings.test.ts`
Expected: FAIL — `Cannot find module './key-bindings'`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/text-input/model/key-bindings.ts`:

```ts
import type { KeyBinding } from "@opentui/core";

/**
 * The editor's key table — OUR rows only. `TextareaRenderable` merges them over
 * `defaultTextareaKeyBindings` internally (measured: a two-row custom table leaves `backspace`,
 * the arrows and every other default working), so nothing here needs to restate a default it is
 * happy with. The merge keys on `name:ctrl:shift:meta:super`, which means a row can SHADOW a
 * default but never remove one — the reason for two decisions below.
 *
 * The fallbacks are always bound, never gated on protocol detection, because no reliable
 * detection exists (§9.2): `renderer.useKittyKeyboard` reports what we REQUESTED, not what the
 * terminal implements, and `KeyEvent.source` is an after-the-fact observation. So each affected
 * action carries a primary chord plus a universal fallback and both stay live everywhere.
 */
export const TEXT_EDITOR_KEY_BINDINGS: readonly KeyBinding[] = [
  // ENTER SUBMITS, shadowing the default `return -> newline`. `onSubmit` is deliberately left
  // unwired: the App owns Enter and submits through the existing `composer-submit` path, which
  // carries the accept-then-clear semantics. `submit()` with no listener is a no-op, so if the
  // App ever fails to claim Enter the editor does NOTHING — whereas the default would silently
  // insert a line break instead of sending. A refusal beats a silent wrong action.
  { name: "return", action: "submit" },
  // NUMPAD ENTER NEEDS ITS OWN ROWS. Alias resolution is single-hop and applied to bindings, not
  // to incoming keys: `defaultKeyAliases` has `kpenter -> enter` and `enter -> return`, but the
  // chain is not walked and the lookup uses the incoming key's literal name. Without these the
  // numpad Enter would fall through to the default `newline` and break the line where the main
  // Enter sends.
  { name: "kpenter", action: "submit" },

  // NEWLINE — three routes, two of which need no extended keyboard protocol (§4.4).
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" }, // Alt+Enter; the default here was `submit`
  { name: "linefeed", action: "newline" }, // Ctrl+J; also a default, pinned explicitly
  { name: "kpenter", shift: true, action: "newline" },

  // UNDO/REDO — nothing usable exists in the defaults (§4.5). They bind `super+z` (Cmd+Z, absent
  // on this platform) and `ctrl+-`, which is dead: physical Ctrl+- parses as `name: "_"` and the
  // alias table has no `_ -> -` entry. Undo is unreachable out of the box, so these are required.
  { name: "z", ctrl: true, action: "undo" },
  { name: "z", ctrl: true, shift: true, action: "redo" },
  { name: "y", ctrl: true, action: "redo" },

  // CTRL+A IS REMAPPED, NOT REMOVED, because removal is not expressible through the merge.
  // Mapping it to `select-all` both kills the default `line-home` and gives the behaviour most
  // users expect. `ctrl+b` (`move-left`) and `ctrl+e` (`line-end`) need no remap: the App claims
  // both ahead of the editor through the action registry, so their defaults are unreachable —
  // asserted by the dead-binding guard in `ui/app/model/keymap.test.ts`, not assumed.
  { name: "a", ctrl: true, action: "select-all" },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/ui/text-input/model/key-bindings.test.ts`
Expected: PASS, all tests green.

If the `kpenter` rows fail, print the parsed key first — `parseKeypress("\u001b[57414u", { useKittyKeyboard: true })` must report `name: "kpenter"` — before changing the table.

- [ ] **Step 5: Typecheck, lint, format**

Run: `bunx tsc --noEmit && bun run lint && bun run fmt`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
printf '%s\n' 'feat(ui): add the editor key-binding table with universal fallbacks' > /tmp/tc-commit-msg.txt
rtk git add src/ui/text-input/model/key-bindings.ts src/ui/text-input/model/key-bindings.test.ts && rtk git commit -F /tmp/tc-commit-msg.txt
```

---

### Task 4: `TextEditor` — the component, its handle, and its bridge

`TextInput` stays in place for this task; nothing consumes `TextEditor` yet.

**Files:**
- Create: `src/ui/text-input/ui/TextEditor.tsx`
- Test: `src/ui/text-input/ui/TextEditor.test.tsx`
- Modify: `src/ui/text-input/types.ts`, `src/ui/text-input/index.ts`

**Interfaces:**
- Consumes: `TEXT_EDITOR_KEY_BINDINGS` (Task 3).
- Produces:
  - `interface TextEditorHandle { setText(text: string): void; clear(): void; deleteCharBackward(): void; focus(): void; blur(): void; }`
  - `interface EditorBridge { attach(handle: TextEditorHandle | null): void; mirror(text: string): void; }`
  - `interface TextEditorProps` (see Step 3)
  - `function TextEditor(props: TextEditorProps)`

- [ ] **Step 1: Write the failing test**

Create `src/ui/text-input/ui/TextEditor.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import { type ReactTestRenderer, createReactTestRenderer } from "ui/testing";
import { SHELL_PALETTE } from "ui/theme";

import type { EditorBridge, TextEditorHandle } from "../types";
import { TextEditor } from "./TextEditor";

let open: ReactTestRenderer | null = null;
afterEach(async () => {
  await open?.destroy();
  open = null;
});

interface Probe {
  readonly bridge: EditorBridge;
  readonly seen: string[];
  handle: TextEditorHandle | null;
}

/**
 * A bridge shaped exactly like the one `createUiDeps` builds: it seeds the editor from a caller
 * -owned mirror on attach and records every projection back out. Created ONCE per test so its
 * `attach` identity is stable, which is the contract `TextEditor` documents.
 */
function probe(seed: string): Probe {
  const state: Probe = {
    seen: [],
    handle: null,
    bridge: {
      attach: (handle) => {
        state.handle = handle;
        if (handle !== null) handle.setText(seed);
      },
      mirror: (text) => {
        state.seen.push(text);
      },
    },
  };
  return state;
}

const STYLE = {
  caret: "❯ ",
  caretFg: SHELL_PALETTE.amber,
  valueFg: SHELL_PALETTE.fg,
  placeholderFg: SHELL_PALETTE.faint,
  cursorFg: SHELL_PALETTE.amber,
} as const;

describe("TextEditor — the shared editable buffer", () => {
  test("draws the caret run and the placeholder while empty", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="Ask for changes…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    expect(renderer.captureCharFrame()).toContain("❯ Ask for changes…");
  });

  test("seeds itself from the mirror at mount, through the bridge", async () => {
    const state = probe("carried over");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    expect(renderer.captureCharFrame()).toContain("carried over");
  });

  test("projects every buffer change back through the bridge", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    await renderer.act(() => renderer.mockInput.typeText("abc"));
    expect(state.seen.at(-1)).toBe("abc");
  });

  test("receives nothing at all while unfocused", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused={false}
        showCursor={false}
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    await renderer.act(() => renderer.mockInput.typeText("abc"));
    expect(state.seen).toEqual([]);
  });

  test("paints no cursor while showCursor is false, even though keys still arrive (§7.5)", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor={false}
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    // The cursor is the TERMINAL's own hardware cursor, never a painted glyph, so it cannot be
    // read out of `captureCharFrame()` — `getCursorState()` is the only honest assertion.
    expect(renderer.renderer.getCursorState().visible).toBe(false);
    await renderer.act(() => renderer.mockInput.typeText("typed anyway"));
    expect(state.seen.at(-1)).toBe("typed anyway");
  });

  test("paints the cursor while focused and showCursor is true", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    expect(renderer.renderer.getCursorState().visible).toBe(true);
  });

  test("wraps and grows to the row count it is given", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <box id="wrap" width={20} height={6} flexDirection="column">
        <TextEditor
          id="ed"
          {...STYLE}
          placeholder="…"
          multiline
          rows={3}
          width={14}
          focused
          showCursor
          bridge={state.bridge}
        />
        <text id="below">{"---"}</text>
      </box>,
      { width: 20, height: 6 },
    );
    open = renderer;
    await renderer.act(() => renderer.mockInput.typeText("hello world again"));
    const frame = renderer.captureCharFrame();
    expect(frame).toContain("❯ hello world");
    expect(frame.split("\n")[1]).toContain("again");
    // The sibling below is pushed down by the editor's full height, never overdrawn.
    expect(frame.split("\n")[3]).toContain("---");
  });

  test("the single-line variant refuses a newline outright", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline={false}
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    await renderer.act(() => {
      renderer.mockInput.typeText("a");
      renderer.mockInput.pressEnter({ shift: true });
      renderer.mockInput.typeText("b");
    });
    expect(state.seen.at(-1)).toBe("ab");
  });

  test("clears the handle when it unmounts, so nothing writes into a dead editor", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    expect(state.handle).not.toBeNull();
    await renderer.destroy();
    open = null;
    expect(state.handle).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/ui/text-input/ui/TextEditor.test.tsx`
Expected: FAIL — `Cannot find module './TextEditor'`.

- [ ] **Step 3: Rewrite `types.ts`**

Replace the whole contents of `src/ui/text-input/types.ts` with exactly this:

```ts
/**
 * `ui/text-input`'s contracts: the imperative handle an external write reaches a mounted editor
 * through, the two-way bridge that wires one editor to one mirror atom, and the component props.
 */

/**
 * A mounted editor, reduced to the five operations something outside it actually performs.
 * Nothing speculative — one method per existing external write, plus the focus pair.
 */
export interface TextEditorHandle {
  /** Replace the whole content, cursor to the end. Used by the F6 repair fill and by seeding. */
  setText(text: string): void;
  /** Empty it, cursor to zero. Used by the post-accept clear. */
  clear(): void;
  /**
   * Delete the character left of the cursor.
   *
   * This exists to preserve an already-documented escape route. While `homeHealth.kind` is
   * `"blocked"` the Home prompt is non-typeable, `q` quits only while the prompt is EMPTY, and
   * backspace is the only thing that can empty it — `ui/app/model/keymap.ts` records the full
   * reasoning as a fix-round-3 correction. In `blocked` the editor is blurred and receives no
   * keys, so the `home-backspace` intent survives and drives this instead.
   *
   * Unlike the other four this needs no paired mirror write: it mutates the buffer, and the
   * buffer's own content-change listener is registered against the edit buffer rather than
   * against focus, so the mirror updates exactly as it does for a typed key. It is an edit routed
   * through the handle, not an external write.
   */
  deleteCharBackward(): void;
  focus(): void;
  blur(): void;
}

/**
 * One editor's two wiring points, in the two directions §5 keeps deliberately separate.
 *
 * Both MUST be stable across renders. `attach` is used as a React ref sink, and a ref whose
 * identity changes is detached and re-attached on every render — which would re-seed the buffer
 * and throw the cursor back to the end while the user is typing. `createUiDeps` builds both once,
 * with `bind`, which satisfies stability and the Reatom context requirement at the same time.
 */
export interface EditorBridge {
  /**
   * Called with the handle when the editor mounts and with `null` when it unmounts. The
   * implementation records the handle AND seeds the buffer from the mirror — the mirror is the
   * seed at mount, the buffer is the truth while mounted (§7.2).
   */
  attach(handle: TextEditorHandle | null): void;
  /** Called with the editor's full text on every buffer change — the downstream projection. */
  mirror(text: string): void;
}

/**
 * Props for {@link TextEditor}.
 *
 * There is deliberately NO text prop. A prop tracking the mirror atom would be re-applied on
 * every keystroke — `InputRenderable.value` is a live setter — moving the cursor to the end
 * mid-edit, and pinning a mount-time seed with `useRef` is not available here (the repo ships no
 * `@types/react`, so importing React's own hooks is a TS7016 error). The seed travels through
 * {@link EditorBridge.attach} instead, which runs exactly once per mount.
 */
export interface TextEditorProps {
  readonly id: string;
  /** The caret run drawn before the editor, e.g. `"❯ "`. Rendered on the first row only. */
  readonly caret: string;
  readonly caretFg: `#${string}`;
  readonly placeholder: string;
  readonly placeholderFg: `#${string}`;
  readonly valueFg: `#${string}`;
  readonly cursorFg: `#${string}`;
  /** `true` renders a growing `<textarea>`; `false` a single-row `<input>`. */
  readonly multiline: boolean;
  /** Visible rows — always 1 when {@link multiline} is false. */
  readonly rows: number;
  /** The editor's own width in cells, EXCLUDING the caret run. */
  readonly width: number;
  /** Whether keys reach this editor at all. */
  readonly focused: boolean;
  /**
   * Whether the terminal cursor is painted. Independent of {@link focused} on purpose (§7.5):
   * a running turn with an empty draft keeps typing live while the design draws no cursor.
   */
  readonly showCursor: boolean;
  /** See {@link EditorBridge} — must be stable across renders. */
  readonly bridge: EditorBridge;
}
```

- [ ] **Step 4: Write `TextEditor.tsx`**

Create `src/ui/text-input/ui/TextEditor.tsx`:

```tsx
import type { InputRenderable, TextareaRenderable } from "@opentui/core";

import { TEXT_EDITOR_KEY_BINDINGS } from "../model/key-bindings";
import type { EditorBridge, TextEditorHandle, TextEditorProps } from "../types";

type EditorRenderable = TextareaRenderable | InputRenderable;

const KEY_BINDINGS = [...TEXT_EDITOR_KEY_BINDINGS];

/**
 * Stable ref sinks, one per bridge.
 *
 * React re-invokes a ref callback whenever its identity changes — with `null` for the old one,
 * then the instance for the new one. An inline callback would therefore tear the editor's handle
 * down and re-seed the buffer on EVERY render, snapping the cursor back to the end while the user
 * types. Caching by the bridge (which `createUiDeps` creates once) makes the sink as stable as the
 * bridge it wraps. A `WeakMap` so a bridge belonging to a destroyed deps graph is collectable.
 */
interface Sink {
  /** The React ref callback — one identity per bridge, for the lifetime of the bridge. */
  readonly ref: (renderable: EditorRenderable | null) => void;
  /**
   * The live renderable. Kept here because `onContentChange`'s event object is empty
   * (`ContentChangeEvent` is `{}`), so the handler has to read `plainText` off the renderable
   * itself — and this is the only reference to it the component has.
   */
  current: EditorRenderable | null;
}

const REF_SINKS = new WeakMap<EditorBridge, Sink>();

function createHandle(renderable: EditorRenderable): TextEditorHandle {
  return {
    setText: (text) => renderable.setText(text),
    clear: () => renderable.clear(),
    deleteCharBackward: () => {
      renderable.deleteCharBackward();
    },
    focus: () => renderable.focus(),
    blur: () => renderable.blur(),
  };
}

function sinkFor(bridge: EditorBridge): Sink {
  const cached = REF_SINKS.get(bridge);
  if (cached !== undefined) return cached;
  const sink: Sink = {
    current: null,
    ref: (renderable) => {
      sink.current = renderable;
      bridge.attach(renderable === null ? null : createHandle(renderable));
    },
  };
  REF_SINKS.set(bridge, sink);
  return sink;
}

/**
 * The one editable text surface in the shell: the Workspace composer, the Home prompt, the
 * pin-input popup, and — because the slash filter IS the composer/prompt buffer — the slash menu.
 *
 * REPLACES `TextInput`, and carries its design citations forward. The placeholder-overlap rule
 * that component emulated came from `put`-over-`text` at the same column in
 * `design/termcraft-engine.js` — Home's `home()` `:145-146`
 * (`this.text(b,ix+4,iy+1,'Describe the TUI you want to design…',{fg:P.faint});
 * this.put(b,ix+4,iy+1,'█',{fg:P.amber,blink:true});`) and the composer's own placeholder branch,
 * `drawChat()` `:652` (`this.ctext(b,chatX+3,composerTop+2,…'Ask for changes…'…);` then
 * `this.put(b,chatX+3,composerTop+2,'█',…)` at the SAME column). Here the rule stops needing
 * emulation and starts holding by construction: the placeholder comes from the renderable's own
 * `placeholder` option and the cursor is the terminal's real cursor, which physically occupies
 * the first cell of the placeholder. `wsGenTyping()` `:270-274`'s "one column past the text once
 * a draft is held" falls out of the same mechanism.
 *
 * `multiline` selects the intrinsic. `<input>` is used for the single-line case rather than a
 * constrained `<textarea>` because `InputRenderable` already enforces height 1, no wrapping, and
 * newline stripping — including from paste. Both expose the same {@link TextEditorHandle}, so no
 * caller ever learns the difference. `runtime/ui/input.tsx` already renders the `<input>`
 * intrinsic for generated pages, so this is an established pattern in the repo.
 */
export function TextEditor(props: TextEditorProps) {
  const sink = sinkFor(props.bridge);
  const onContentChange = (): void => {
    if (sink.current === null) return;
    props.bridge.mirror(sink.current.plainText);
  };

  return (
    <box
      id={props.id}
      flexDirection="row"
      // The caret is one row tall and must stay on the FIRST row of a grown editor, exactly where
      // the design draws it. Yoga's default `stretch` would size it to the whole column.
      alignItems="flex-start"
      height={props.multiline ? props.rows : 1}
    >
      <text id={`${props.id}-caret`} fg={props.caretFg}>
        {props.caret}
      </text>
      {props.multiline ? (
        <textarea
          id={`${props.id}-editor`}
          ref={sink.ref}
          width={props.width}
          height={props.rows}
          // Word wrap with a character-break fallback for a word wider than the viewport
          // (measured, §4.2). Nothing is clipped and nothing overflows horizontally, so URLs and
          // paths need no separate policy.
          wrapMode="word"
          keyBindings={KEY_BINDINGS}
          placeholder={props.placeholder}
          placeholderColor={props.placeholderFg}
          textColor={props.valueFg}
          cursorColor={props.cursorFg}
          focused={props.focused}
          showCursor={props.showCursor}
          onContentChange={onContentChange}
        />
      ) : (
        <input
          id={`${props.id}-editor`}
          ref={sink.ref}
          width={props.width}
          keyBindings={KEY_BINDINGS}
          placeholder={props.placeholder}
          placeholderColor={props.placeholderFg}
          textColor={props.valueFg}
          cursorColor={props.cursorFg}
          focused={props.focused}
          showCursor={props.showCursor}
          onContentChange={onContentChange}
        />
      )}
    </box>
  );
}
```

- [ ] **Step 5: Update the module entry point**

Replace `src/ui/text-input/index.ts`:

```ts
/**
 * `ui/text-input` — the one editable text surface in the shell. The Workspace composer, the Home
 * prompt and the pin-input popup all render through {@link TextEditor}, so the caret run, the
 * placeholder, the cursor and the whole editing key table come from a single source. The buffer
 * lives in OpenTUI's native `EditBuffer`; the UI-local `Atom<string>` is its downstream mirror.
 */
export { editorMaxRows, editorRowCount, wrappedLineCount } from "./model/editor-height";
export { TEXT_EDITOR_KEY_BINDINGS } from "./model/key-bindings";
export type { EditorBridge, TextEditorHandle, TextEditorProps } from "./types";
export { TextEditor } from "./ui/TextEditor";
export type { TextInputProps } from "./types";
export { TextInput } from "./ui/TextInput";
```

The last two lines keep `TextInput` exported until its consumers move (Tasks 8 and 9); `TextInputProps` must therefore stay in `types.ts` for now. Re-add it verbatim at the bottom of `types.ts`:

```ts
/**
 * Props for the outgoing {@link TextInput}. Deleted with the component in Task 9, once Home and
 * the composer both render {@link TextEditor}.
 */
export interface TextInputProps {
  readonly id: string;
  readonly value: string;
  readonly placeholder: string;
  /** The caret run drawn before the text, e.g. `"❯ "`. */
  readonly caret: string;
  readonly caretFg: `#${string}`;
  readonly valueFg: `#${string}`;
  readonly placeholderFg: `#${string}`;
  /** `false` renders no cursor at all — the design's faint, cursor-less disabled input. */
  readonly showCursor: boolean;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/ui/text-input`
Expected: PASS — `TextEditor.test.tsx`, `TextInput.test.tsx`, `editor-height.test.ts`, `key-bindings.test.ts` all green.

- [ ] **Step 7: Typecheck, lint, format**

Run: `bunx tsc --noEmit && bun run lint && bun run fmt`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
printf '%s\n' 'feat(ui): add TextEditor — the shared editable buffer behind every text input' > /tmp/tc-commit-msg.txt
rtk git add src/ui/text-input && rtk git commit -F /tmp/tc-commit-msg.txt
```

---

### Task 5: The handle atoms, the editor bridges, and the two named directions

**Files:**
- Create: `src/ui/app/model/primary-input.ts`
- Test: `src/ui/app/model/primary-input.test.ts`
- Modify: `src/ui/app/model/deps.ts`

**Interfaces:**
- Consumes: `TextEditorHandle`, `EditorBridge` (Task 4).
- Produces:
  - `UiLocalState.composerEditor` / `.promptEditor` / `.pinEditor`: `Atom<TextEditorHandle | null>`
  - `UiDeps.editors: UiEditors` where `interface UiEditors { readonly composer: EditorBridge; readonly prompt: EditorBridge; readonly pin: EditorBridge; }`
  - `setPrimaryInput(deps: UiDeps, text: string): void`
  - `mirrorPrimaryInput(deps: UiDeps, text: string): void`
  - `primaryInputAtom(deps: UiDeps): Atom<string>`

- [ ] **Step 1: Write the failing test**

Create `src/ui/app/model/primary-input.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";
import type { TextEditorHandle } from "ui/text-input";
import { createFakeKernel, snapshot } from "ui/testing";

import { createUiDeps } from "./deps";
import { mirrorPrimaryInput, primaryInputAtom, setPrimaryInput } from "./primary-input";

/** A handle that records what was done to it, standing in for a mounted editor. */
function fakeHandle(): TextEditorHandle & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setText: (text) => calls.push(`setText:${text}`),
    clear: () => calls.push("clear"),
    deleteCharBackward: () => calls.push("deleteCharBackward"),
    focus: () => calls.push("focus"),
    blur: () => calls.push("blur"),
  };
}

/**
 * Deps whose screen is `workspace`, so the primary input is the composer. The snapshot is not
 * optional decoration: `deriveScreen` holds Home until a `projectId` lands, and on Home
 * `primaryInputAtom` selects the PROMPT.
 */
const workspaceDeps = () => {
  const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
  deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
  return deps;
};

describe("setPrimaryInput — the one upstream write (§7.2)", () => {
  test("writes the mirror AND the mounted editor", () => {
    const deps = workspaceDeps();
    const handle = fakeHandle();
    deps.local.composerEditor.set(handle);
    setPrimaryInput(deps, "repair this page");
    expect(deps.local.composer()).toBe("repair this page");
    expect(handle.calls).toEqual(["setText:repair this page"]);
  });

  test("writes the mirror even with no editor mounted — the unmount race (§7.2)", () => {
    const deps = workspaceDeps();
    deps.local.composerEditor.set(null);
    deps.local.composer.set("already sent");
    // The composer can unmount between `turn.start` and its accepted continuation. If the clear
    // only reached the handle, the mirror would still hold the sent text and a later remount
    // would seed the editor from it — the sent message reappearing in the composer.
    expect(() => setPrimaryInput(deps, "")).not.toThrow();
    expect(deps.local.composer()).toBe("");
  });

  test("targets the Home prompt while Home is the screen", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const handle = fakeHandle();
    deps.local.promptEditor.set(handle);
    expect(deps.screen()).toBe("home");
    setPrimaryInput(deps, "/");
    expect(deps.local.prompt()).toBe("/");
    expect(deps.local.composer()).toBe("");
    expect(handle.calls).toEqual(["setText:/"]);
  });
});

describe("primaryInputAtom — the screen's own primary input", () => {
  test("is the prompt on Home and the composer elsewhere", () => {
    const home = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    expect(primaryInputAtom(home)).toBe(home.local.prompt);
  });
});

describe("mirrorPrimaryInput — the one downstream projection (§7.3)", () => {
  test("writes the mirror and leaves a closed menu closed", () => {
    const deps = workspaceDeps();
    mirrorPrimaryInput(deps, "hello");
    expect(deps.local.composer()).toBe("hello");
    expect(deps.local.overlay()).toBeNull();
  });

  test("closes the menu once the filter is erased to empty", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("/ex");
    deps.local.overlay.set("slash-menu");
    mirrorPrimaryInput(deps, "");
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.composer()).toBe("");
  });

  test("closes the menu once the leading slash itself is deleted", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("/export");
    deps.local.overlay.set("slash-menu");
    // Reachable only now that the cursor can move into the string — a menu left open over text
    // with no leading slash draws as nothing, so Enter would go into silence.
    mirrorPrimaryInput(deps, "export");
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.composer()).toBe("export");
  });

  test("closes the menu once the filter matches no row", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("/exp");
    deps.local.overlay.set("slash-menu");
    mirrorPrimaryInput(deps, "/nothing-matches-this");
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.composer()).toBe("/nothing-matches-this");
  });

  test("keeps the menu open while the prefix still matches", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("/");
    deps.local.overlay.set("slash-menu");
    mirrorPrimaryInput(deps, "/e");
    expect(deps.local.overlay()).toBe("slash-menu");
  });
});

describe("the editor bridges createUiDeps exposes", () => {
  test("attach records the handle and seeds it from the mirror", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("draft in flight");
    const handle = fakeHandle();
    deps.editors.composer.attach(handle);
    expect(deps.local.composerEditor()).toBe(handle);
    expect(handle.calls).toEqual(["setText:draft in flight"]);
  });

  test("attach(null) clears the handle without touching the mirror", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("kept");
    deps.editors.composer.attach(fakeHandle());
    deps.editors.composer.attach(null);
    expect(deps.local.composerEditor()).toBeNull();
    expect(deps.local.composer()).toBe("kept");
  });

  test("the bridge functions keep one identity for the whole deps lifetime", () => {
    const deps = workspaceDeps();
    // A ref sink whose identity changes is detached and re-attached on every render, which would
    // re-seed the buffer mid-edit. Stability is the contract `TextEditor` documents.
    expect(deps.editors.composer.attach).toBe(deps.editors.composer.attach);
    expect(deps.editors.prompt.mirror).toBe(deps.editors.prompt.mirror);
  });

  test("the pin bridge writes only the pin draft", () => {
    const deps = workspaceDeps();
    deps.editors.pin.mirror("why is this always on top?");
    expect(deps.local.pinDraft()).toBe("why is this always on top?");
    expect(deps.local.composer()).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/ui/app/model/primary-input.test.ts`
Expected: FAIL — `Cannot find module './primary-input'`.

- [ ] **Step 3: Write `primary-input.ts`**

Create `src/ui/app/model/primary-input.ts`:

```ts
import { type Atom, bind } from "@reatom/core";

import { trace } from "infrastructure/debug-log";
import { filterSlashRows } from "ui/actions";
import type { EditorBridge, TextEditorHandle } from "ui/text-input";

import type { UiDeps } from "./deps";

/**
 * The two directions §5 keeps deliberately un-interchangeable.
 *
 * `mirrorPrimaryInput` runs DOWNSTREAM — the editor changed, project it into the atom.
 * `setPrimaryInput` runs UPSTREAM — something outside the editor decided the text, put it into
 * both. Editing flows one way only, buffer to mirror; external writes are the one bidirectional
 * point and they write both sides from a single call site, which is what closes the unmount race
 * (§7.2): the composer can unmount between `turn.start` and its accepted continuation, and a
 * clear that reached only the handle would leave the mirror holding the sent text for a later
 * remount to seed from.
 *
 * "Primary input" keeps the meaning `intent.ts` already gives it: the Home prompt on `home`, the
 * Workspace composer everywhere else. The pin popup is not a primary input — it owns its own
 * `pinDraft`/`pinEditor` pair.
 */

/** The mirror atom for the current screen's primary input. Selects between two atoms; never creates one. */
export function primaryInputAtom(deps: UiDeps): Atom<string> {
  return deps.screen() === "home" ? deps.local.prompt : deps.local.composer;
}

/** The handle atom for the current screen's primary input. */
export function primaryEditorAtom(deps: UiDeps): Atom<TextEditorHandle | null> {
  return deps.screen() === "home" ? deps.local.promptEditor : deps.local.composerEditor;
}

/**
 * Applies `apply` to a mounted editor, or records that there was none.
 *
 * The atom always exists; the handle does not — the component may be unmounted, or belong to
 * another screen. A silent return is not acceptable here: this codebase has already paid for one,
 * when `dispatchAndReport` swallowed Kernel refusals and the fix was to add exactly this kind of
 * trace (§9.1).
 */
function withEditor(
  handleAtom: Atom<TextEditorHandle | null>,
  reason: string,
  apply: (handle: TextEditorHandle) => void,
): void {
  const handle = handleAtom();
  if (handle === null) {
    trace("ui.editor.missing", { intent: reason });
    return;
  }
  apply(handle);
}

/** UPSTREAM: something outside the editor decided the text. Writes the atom ALWAYS, the handle when one exists. */
export function setPrimaryInput(deps: UiDeps, text: string): void {
  primaryInputAtom(deps).set(text);
  withEditor(primaryEditorAtom(deps), "setPrimaryInput", (handle) => handle.setText(text));
}

/** UPSTREAM, for the pin popup's own draft. */
export function setPinInput(deps: UiDeps, text: string): void {
  deps.local.pinDraft.set(text);
  withEditor(deps.local.pinEditor, "setPinInput", (handle) => handle.setText(text));
}

/** Deletes the character behind the cursor in the current primary input, through its handle. */
export function deletePrimaryInputChar(deps: UiDeps): void {
  withEditor(primaryEditorAtom(deps), "home-backspace", (handle) => handle.deleteCharBackward());
}

/**
 * DOWNSTREAM: the editor's buffer changed, project it into the mirror.
 *
 * The slash menu's closing rule lives here rather than in a key handler, because the editor now
 * does the editing and this is the one place that sees every edit. Three cases close it: the
 * filter erased to empty, the leading `/` itself deleted (newly reachable, now that the cursor
 * can move into the string), and a filter that matches no row. Leaving the menu open over text
 * with no leading slash would recreate exactly the invisible dead end `intent.ts` already fixed
 * once — a menu with no rows draws as nothing, so the user presses Enter into silence (§7.3).
 */
export function mirrorPrimaryInput(deps: UiDeps, text: string): void {
  primaryInputAtom(deps).set(text);
  if (deps.local.overlay() !== "slash-menu") return;
  const screen = deps.screen();
  if (screen !== "workspace" && screen !== "home") return;
  if (!text.startsWith("/")) {
    deps.local.overlay.set(null);
    return;
  }
  if (filterSlashRows(text, deps.actionContext()).length === 0) deps.local.overlay.set(null);
}

/**
 * Builds one editor's bridge.
 *
 * `bind` (RTM-A06) because both halves are callbacks invoked later from outside Reatom — the
 * renderable's content-change listener and React's ref sink — and both write atoms. Binding here,
 * once, is also what gives them the stable identity `TextEditor`'s ref sink requires.
 */
export function createEditorBridge(input: {
  readonly handleAtom: Atom<TextEditorHandle | null>;
  readonly readSeed: () => string;
  readonly mirror: (text: string) => void;
}): EditorBridge {
  return {
    attach: bind((handle: TextEditorHandle | null) => {
      input.handleAtom.set(handle);
      // The mirror is the seed at mount; the buffer is the truth while mounted (§7.2). Seeding
      // here rather than through a prop is what keeps a re-render from snapping the cursor to the
      // end of the text mid-edit.
      if (handle !== null) handle.setText(input.readSeed());
    }),
    mirror: bind(input.mirror),
  };
}
```

- [ ] **Step 4: Wire the atoms and the bridges into `deps.ts`**

In `src/ui/app/model/deps.ts`:

1. Add the imports (alphabetical within the `ui/*` group):

```ts
import type { EditorBridge, TextEditorHandle } from "ui/text-input";
```

and, from the local group:

```ts
import { createEditorBridge, mirrorPrimaryInput } from "./primary-input";
```

2. Add to `UiLocalState`, after `pinDraft`:

```ts
  /**
   * The mounted composer / Home-prompt / pin editors, or `null` when none is mounted.
   *
   * The mirror atoms above are the downstream projection of these buffers; these are how an
   * EXTERNAL write (the post-accept clear, the F6 repair fill, `slash-open`'s `"/"`) reaches the
   * buffer that is actually on screen. Every use goes through `primary-input.ts`, which records a
   * `ui.editor.missing` trace rather than returning silently when nothing is mounted (§9.1).
   */
  readonly composerEditor: Atom<TextEditorHandle | null>;
  readonly promptEditor: Atom<TextEditorHandle | null>;
  readonly pinEditor: Atom<TextEditorHandle | null>;
```

3. Add the `UiEditors` interface above `UiDeps`:

```ts
/**
 * The bridges each mounted editor wires itself to — one per text surface. Built once by
 * {@link createUiDeps} so both halves keep a single identity for the whole deps lifetime, which
 * is what `TextEditor`'s ref sink depends on (a ref whose identity changes is detached and
 * re-attached on every render, re-seeding the buffer mid-edit).
 */
export interface UiEditors {
  readonly composer: EditorBridge;
  readonly prompt: EditorBridge;
  readonly pin: EditorBridge;
}
```

4. Add to `UiDeps`, after `local`:

```ts
  /** See {@link UiEditors}. Passed straight to the `TextEditor` each surface renders. */
  readonly editors: UiEditors;
```

5. In `createUiDeps`, replace the `local` object literal so the three atoms are declared and then build the bridges. The three handle atoms are declared as locals first because `createEditorBridge` needs them by reference:

```ts
  const composerEditor = atom<TextEditorHandle | null>(null, "ui.local.composerEditor");
  const promptEditor = atom<TextEditorHandle | null>(null, "ui.local.promptEditor");
  const pinEditor = atom<TextEditorHandle | null>(null, "ui.local.pinEditor");
  const pinDraft = atom("", "ui.local.pinDraft");

  const local: UiLocalState = {
    prompt,
    composer,
    focus: atom<FocusTarget>("composer", "ui.local.focus"),
    fullscreen,
    overlay: atom<OverlayKind | null>(null, "ui.local.overlay"),
    slashSelection,
    chatSelection: atom(0, "ui.local.chatSelection"),
    pinDraft,
    composerEditor,
    promptEditor,
    pinEditor,
    pageOverride,
    exportDismissed: atom<UUIDv7 | null>(null, "ui.local.exportDismissed"),
    homeHealth: atom<HomeAgentHealth>(DEFAULT_HOME_HEALTH, "ui.local.homeHealth"),
    agentSelection: atom<HomeAgentSelection | null>(agentSelection, "ui.local.agentSelection"),
  };

  // Declared BEFORE `deps` and closing over it: both halves run later — on mount and on every
  // buffer change — long after the assignment below, so the reference is always resolved. The
  // same shape `applyEnvelope` above already uses to reach `deps` from a subscriber.
  const editors: UiEditors = {
    composer: createEditorBridge({
      handleAtom: composerEditor,
      readSeed: () => composer(),
      mirror: (text) => mirrorPrimaryInput(deps, text),
    }),
    prompt: createEditorBridge({
      handleAtom: promptEditor,
      readSeed: () => prompt(),
      mirror: (text) => mirrorPrimaryInput(deps, text),
    }),
    pin: createEditorBridge({
      handleAtom: pinEditor,
      readSeed: () => pinDraft(),
      // The pin draft has no slash menu and no screen selection of its own, so its projection is
      // the plain mirror write.
      mirror: (text) => pinDraft.set(text),
    }),
  };
```

6. Add `editors` to the returned `deps` object, after `local`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/ui/app/model/primary-input.test.ts src/ui/app/model/deps.test.ts`
Expected: PASS.

Note on the missing-handle test: `trace()` is a no-op under `bun test` (the sink refuses to write when `NODE_ENV=test` and no explicit `TERMCRAFT_DEBUG_LOG` path is set), so the assertion is "does not throw, and still writes the atom" rather than an observed log line.

- [ ] **Step 6: Typecheck, lint, format**

Run: `bunx tsc --noEmit && bun run lint && bun run fmt`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
printf '%s\n' 'feat(ui): add editor handles and the two named input directions' > /tmp/tc-commit-msg.txt
rtk git add src/ui/app/model/primary-input.ts src/ui/app/model/primary-input.test.ts src/ui/app/model/deps.ts && rtk git commit -F /tmp/tc-commit-msg.txt
```

---

### Task 6: `intent.ts` routes every external write through the named actions

The key table is untouched here, so every existing test still applies. This is the compile-safe half of the intent change.

**Files:**
- Modify: `src/ui/app/model/intent.ts`
- Test: `src/ui/app/model/intent.test.ts`

**Interfaces:**
- Consumes: `setPrimaryInput`, `setPinInput`, `deletePrimaryInputChar`, `primaryInputAtom` (Task 5).
- Produces: no new exports. `applyIntent`'s behaviour is unchanged; only where the writes go changes.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/app/model/intent.test.ts`, at the end of the `describe("applyIntent — text inputs", …)` block:

```ts
  test("the post-accept clear reaches the mounted editor, not only the mirror", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    // A `projectId` is what moves `deriveScreen` off Home, which is what makes the COMPOSER the
    // primary input rather than the prompt.
    deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
    const calls: string[] = [];
    deps.local.composerEditor.set({
      setText: (text) => calls.push(`setText:${text}`),
      clear: () => calls.push("clear"),
      deleteCharBackward: () => calls.push("deleteCharBackward"),
      focus: () => calls.push("focus"),
      blur: () => calls.push("blur"),
    });
    deps.local.composer.set("send me");
    applyIntent({ kind: "composer-submit" }, deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.local.composer()).toBe("");
    expect(calls).toEqual(["setText:"]);
  });

  test("slash-open writes the '/' into both sides, so there is one writer for that transition", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
    const calls: string[] = [];
    deps.local.composerEditor.set({
      setText: (text) => calls.push(`setText:${text}`),
      clear: () => calls.push("clear"),
      deleteCharBackward: () => calls.push("deleteCharBackward"),
      focus: () => calls.push("focus"),
      blur: () => calls.push("blur"),
    });
    applyIntent({ kind: "slash-open" }, deps);
    expect(deps.local.composer()).toBe("/");
    expect(calls).toEqual(["setText:/"]);
  });

  test("home-backspace drives the editor handle rather than slicing the mirror", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const calls: string[] = [];
    deps.local.promptEditor.set({
      setText: (text) => calls.push(`setText:${text}`),
      clear: () => calls.push("clear"),
      deleteCharBackward: () => calls.push("deleteCharBackward"),
      focus: () => calls.push("focus"),
      blur: () => calls.push("blur"),
    });
    applyIntent({ kind: "home-backspace" }, deps);
    // In `blocked` the editor is blurred and receives no keys, so this intent is the ONLY route
    // that can empty the prompt — and `q` stays inert until it is empty (keymap.ts, fix round 3).
    expect(calls).toEqual(["deleteCharBackward"]);
  });
```

Adjust the existing `home-input / backspace edit the prompt atom` test to drop its `home-backspace` half — that behaviour now lives in the test above. Keep the `home-input` half unchanged for this task.

Also extend the existing `describe("applyIntent — F6 compose-repair")` block's two filling tests (`fills an empty composer…` and `appends below a blank line…`): register a recording handle on `deps.local.composerEditor` the same way, and assert the handle received a `setText` carrying the identical text the mirror ends up with. That is §7.4's whole point — the repair fill is an external write and must land on both sides.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/ui/app/model/intent.test.ts`
Expected: FAIL — the new tests see empty `calls` arrays, because the writes still go straight to the atoms.

- [ ] **Step 3: Route the writes**

In `src/ui/app/model/intent.ts`:

1. Add the import:

```ts
import {
  deletePrimaryInputChar,
  primaryInputAtom,
  setPinInput,
  setPrimaryInput,
} from "./primary-input";
```

2. Delete the private `primaryInput(deps)` helper at the bottom of the file and replace its two call sites in `slashRows` and elsewhere with `primaryInputAtom(deps)`.

3. Replace each arm's write:

```ts
    case "home-input":
      setPrimaryInput(deps, local.prompt() + intent.ch);
      return;
    case "home-backspace":
      // Only reachable while `homeHealth.kind === "blocked"`, where the editor is blurred and
      // receives no keys of its own (keymap.ts's fix-round-3 escape route). It mutates the buffer
      // through the handle; the buffer's own content-change listener projects the result into the
      // mirror, exactly as a typed key would — so there is no paired atom write here.
      deletePrimaryInputChar(deps);
      return;
```

```ts
    case "composer-input":
      setPrimaryInput(deps, local.composer() + intent.ch);
      return;
    case "composer-backspace":
      setPrimaryInput(deps, local.composer().slice(0, -1));
      return;
```

In `composer-submit`'s accepted continuation:

```ts
          if (result.status === "accepted") setPrimaryInput(deps, "");
```

In `dispatchHomeSubmit`, the same — which means the helper needs `deps` rather than `local`. Change its signature to `(promise, kind, deps: UiDeps)`, update the two call sites, and replace `local.prompt.set("")` with `setPrimaryInput(deps, "")`.

In `slash-open`:

```ts
      setPrimaryInput(deps, "/");
      local.overlay.set("slash-menu");
```

In `slash-input` / `slash-backspace` (still present for this task):

```ts
    case "slash-input": {
      if (!slashMenuActive(deps)) return closeStaleSlash(deps);
      setPrimaryInput(deps, primaryInputAtom(deps)() + intent.ch);
      if (filterSlashRows(primaryInputAtom(deps)(), deps.actionContext()).length === 0)
        local.overlay.set(null);
      return;
    }
    case "slash-backspace": {
      if (!slashMenuActive(deps)) return closeStaleSlash(deps);
      const next = primaryInputAtom(deps)().slice(0, -1);
      setPrimaryInput(deps, next);
      if (next.length === 0) local.overlay.set(null);
      return;
    }
```

In `slash-submit`:

```ts
      setPrimaryInput(deps, "");
```

In `pin-input` / `pin-backspace` / `pin-save`:

```ts
    case "pin-input":
      if (deps.screen() === "read-only") return;
      setPinInput(deps, local.pinDraft() + intent.ch);
      return;
    case "pin-backspace":
      if (deps.screen() === "read-only") return;
      setPinInput(deps, local.pinDraft().slice(0, -1));
      return;
```

and in `pin-save` and `overlay-dismiss`, replace `local.pinDraft.set("")` with `setPinInput(deps, "")`.

In `executeAction`'s `compose-repair` branch:

```ts
    // NEVER overwrite a draft: this codebase already carries two defect fixes built on that
    // principle. An empty composer is filled; a non-empty one keeps every character. This has
    // been writing `\n\n` since 2026-07-27 with nothing able to render it — the existing proof
    // that multi-line composer content is normal (§7.4).
    const draft = deps.local.composer();
    setPrimaryInput(deps, draft.length === 0 ? text : `${draft}\n\n${text}`);
    deps.local.focus.set("composer");
    return;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/ui/app`
Expected: PASS — the whole existing intent suite plus the three new tests.

- [ ] **Step 5: Typecheck, lint, format**

Run: `bunx tsc --noEmit && bun run lint && bun run fmt`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
printf '%s\n' 'refactor(ui): route every external input write through setPrimaryInput' > /tmp/tc-commit-msg.txt
rtk git add src/ui/app/model/intent.ts src/ui/app/model/intent.test.ts && rtk git commit -F /tmp/tc-commit-msg.txt
```

---

### Task 7: The claim rule — the keymap stops owning text editing

After this task the shell is deliberately **not typeable by hand** until Task 8 mounts the composer editor. Unit tests and typecheck stay green throughout; only the interactive app is mid-transition.

**Files:**
- Modify: `src/ui/app/model/keymap.ts`, `src/ui/app/model/intent.ts`, `src/ui/app/ui/App.tsx`, `src/ui/actions/model/registry.ts`
- Test: `src/ui/app/model/keymap.test.ts`, `src/ui/app/model/intent.test.ts`, `src/ui/actions/model/registry.test.ts`, `src/ui/app/ui/App.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `KeyLike` gains `readonly shift: boolean` and `readonly meta: boolean`.
  - `KeyIntent` loses `composer-input`, `composer-backspace`, `home-input`, `slash-input`, `slash-backspace`, `pin-input`, `pin-backspace`. It keeps `home-backspace`.
  - `isClaimedKey(intent: KeyIntent): boolean` — exported from `keymap.ts`, the single predicate `App.tsx` calls `preventDefault()` on.

- [ ] **Step 1: Write the failing test**

Replace the editing-intent cases in `src/ui/app/model/keymap.test.ts`. First widen the import to bring in the new predicate:

```ts
import { isClaimedKey, resolveActiveOverlay, resolveKey } from "./keymap";
```

Then update the `key` factory:

```ts
const key = (over: Partial<KeyLike>): KeyLike => ({
  name: "",
  ctrl: false,
  shift: false,
  meta: false,
  sequence: "",
  ...over,
});
```

Then delete every test that asserts `composer-input`, `composer-backspace`, `home-input`, `slash-input`, `slash-backspace`, `pin-input` or `pin-backspace`, and add these blocks:

```ts
describe("the claim rule — preventDefault iff resolveKey returned something other than none (§6.4)", () => {
  test("isClaimedKey is exactly 'the intent is not none'", () => {
    expect(isClaimedKey({ kind: "none" })).toBe(false);
    expect(isClaimedKey({ kind: "composer-submit" })).toBe(true);
    expect(isClaimedKey({ kind: "esc" })).toBe(true);
    expect(isClaimedKey({ kind: "action-execute", actionId: "preview.fullscreen" })).toBe(true);
  });

  const reachesTheEditor: ReadonlyArray<readonly [string, KeyLike, Partial<KeyContext>]> = [
    ["a printable in the composer", key({ name: "a", sequence: "a" }), {}],
    ["Backspace in the composer", key({ name: "backspace" }), {}],
    ["Left with no menu open", key({ name: "left" }), {}],
    ["Right with no menu open", key({ name: "right" }), {}],
    ["Ctrl+Left (word back)", key({ name: "left", ctrl: true }), {}],
    ["Ctrl+Right (word forward)", key({ name: "right", ctrl: true }), {}],
    ["Ctrl+W (delete word back)", key({ name: "w", ctrl: true, sequence: "\u0017" }), {}],
    ["Ctrl+Backspace", key({ name: "backspace", ctrl: true }), {}],
    ["Ctrl+Delete", key({ name: "delete", ctrl: true }), {}],
    ["Shift+Enter", key({ name: "return", shift: true }), {}],
    ["Alt+Enter", key({ name: "return", meta: true }), {}],
    ["Ctrl+J", key({ name: "linefeed", sequence: "\n" }), {}],
    ["Ctrl+Z (undo)", key({ name: "z", ctrl: true, sequence: "\u001a" }), {}],
    ["Ctrl+Y (redo)", key({ name: "y", ctrl: true, sequence: "\u0019" }), {}],
    ["Ctrl+A (select all)", key({ name: "a", ctrl: true, sequence: "\u0001" }), {}],
    ["Home", key({ name: "home" }), {}],
    ["End", key({ name: "end" }), {}],
    ["a printable in the Home prompt", key({ name: "x", sequence: "x" }), { screen: "home" }],
    ["Backspace in the Home prompt", key({ name: "backspace" }), { screen: "home" }],
    [
      "a printable while the slash menu is open",
      key({ name: "e", sequence: "e" }),
      { overlay: "slash-menu", composerValue: "/" },
    ],
    [
      "Backspace while the slash menu is open",
      key({ name: "backspace" }),
      { overlay: "slash-menu", composerValue: "/e" },
    ],
    [
      "Ctrl+Left while the slash menu is open",
      key({ name: "left", ctrl: true }),
      { overlay: "slash-menu", composerValue: "/e" },
    ],
    [
      "a printable in the pin input",
      key({ name: "p", sequence: "p" }),
      { overlay: "pin-input" },
    ],
    ["Backspace in the pin input", key({ name: "backspace" }), { overlay: "pin-input" }],
  ];

  for (const [label, pressed, context] of reachesTheEditor) {
    test(`${label} resolves to none and falls through`, () => {
      expect(resolveKey(pressed, ctx(context))).toEqual({ kind: "none" });
    });
  }

  const claimed: ReadonlyArray<readonly [string, KeyLike, Partial<KeyContext>]> = [
    ["Enter in the composer", key({ name: "return" }), {}],
    ["numpad Enter in the composer", key({ name: "kpenter" }), {}],
    ["Escape", key({ name: "escape" }), {}],
    ["Tab", key({ name: "tab" }), {}],
    ["F2", key({ name: "f2" }), {}],
    ["Ctrl+E", key({ name: "e", ctrl: true, sequence: "\u0005" }), {}],
    ["Ctrl+B", key({ name: "b", ctrl: true, sequence: "\u0002" }), {}],
    ["/ on an empty composer", key({ name: "/", sequence: "/" }), {}],
    ["Up while the slash menu is open", key({ name: "up" }), { overlay: "slash-menu" }],
    ["Down while the slash menu is open", key({ name: "down" }), { overlay: "slash-menu" }],
    ["Enter while the slash menu is open", key({ name: "return" }), { overlay: "slash-menu" }],
    ["Enter in the pin input", key({ name: "return" }), { overlay: "pin-input" }],
  ];

  for (const [label, pressed, context] of claimed) {
    test(`${label} is claimed by the App`, () => {
      expect(isClaimedKey(resolveKey(pressed, ctx(context)))).toBe(true);
    });
  }
});

describe("dead-binding guard — the two editor defaults the App shadows (§4.7)", () => {
  test("Ctrl+B and Ctrl+E resolve to registry actions, so the editor's defaults are unreachable", () => {
    // PAIRED with `key-bindings.test.ts`: the editor's own map still resolves ctrl+b to move-left
    // and ctrl+e to line-end, because `mergeKeyBindings` can shadow but never remove. Together
    // the two assertions mean "unreachable by construction". If someone later drops ctrl+e from
    // the registry, THIS assertion fails and points straight at the collision instead of letting
    // export silently become "go to end of line".
    expect(resolveKey(key({ name: "b", ctrl: true, sequence: "\u0002" }), ctx({}))).toEqual({
      kind: "action-execute",
      actionId: "page.prev",
    });
    expect(resolveKey(key({ name: "e", ctrl: true, sequence: "\u0005" }), ctx({}))).toEqual({
      kind: "action-execute",
      actionId: "export.start",
    });
  });
});

describe("Home while the agent is blocked — the one surviving editing intent", () => {
  test("backspace still resolves to home-backspace, the only way to empty a non-empty prompt", () => {
    const blocked: HomeAgentHealth = {
      kind: "blocked",
      agent: "claude",
      panel: "login",
      detail: "not signed in",
    };
    expect(
      resolveKey(key({ name: "backspace" }), ctx({ screen: "home", homeHealth: blocked, homePrompt: "typed" })),
    ).toEqual({ kind: "home-backspace" });
  });

  test("a printable is still inert there — the editor is blurred and the intent is gone", () => {
    const blocked: HomeAgentHealth = {
      kind: "blocked",
      agent: "claude",
      panel: "login",
      detail: "not signed in",
    };
    expect(
      resolveKey(key({ name: "d", sequence: "d" }), ctx({ screen: "home", homeHealth: blocked })),
    ).toEqual({ kind: "none" });
  });
});
```

Replace the existing `"Ctrl+Left / Ctrl+Right still step pages where the terminal encodes the chord"` test with:

```ts
  test("Ctrl+Left / Ctrl+Right are NOT page steps — they move the cursor by word (G1)", () => {
    // The aliases were dropped when the composer became a real editor: `ctrl+b`/`ctrl+n` are the
    // page-step keys (the registry's own comment already names them the reliable primary, "one
    // byte, no encoding to get wrong"), and neither arrow chord is drawn anywhere — both entries
    // carry `hint: false`. Keeping them would have made Ctrl+Left switch pages inside a text
    // editor, which is the "advertised but wrong" trap this codebase has already fixed twice.
    expect(resolveKey(key({ name: "left", ctrl: true }), ctx({ focus: "composer" }))).toEqual({
      kind: "none",
    });
    expect(resolveKey(key({ name: "right", ctrl: true }), ctx({ focus: "composer" }))).toEqual({
      kind: "none",
    });
  });
```

Add to `src/ui/actions/model/registry.test.ts`:

```ts
  test("the page steps are ctrl+b / ctrl+n only — the arrow aliases belong to the editor now", () => {
    expect(resolveHotkey("ctrl+b")?.id).toBe("page.prev");
    expect(resolveHotkey("ctrl+n")?.id).toBe("page.next");
    expect(resolveHotkey("ctrl+left")).toBeNull();
    expect(resolveHotkey("ctrl+right")).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/ui/app/model/keymap.test.ts src/ui/actions`
Expected: FAIL — `isClaimedKey` is not exported; the arrow-alias assertions fail; several claim-rule cases still return editing intents.

- [ ] **Step 3: Rewrite the keymap**

In `src/ui/app/model/keymap.ts`:

1. Extend `KeyLike`:

```ts
/** The minimal key-event shape this resolver reads (a subset of OpenTUI's `KeyEvent`). */
export interface KeyLike {
  readonly name: string;
  readonly ctrl: boolean;
  /**
   * Read so a MODIFIED Enter is never claimed as a submit: `Shift+Enter` and `Alt+Enter` are the
   * editor's newline chords (§4.4), and claiming them here would make the composer un-breakable
   * on every terminal.
   */
  readonly shift: boolean;
  readonly meta: boolean;
  readonly sequence: string;
}
```

2. Delete the seven editing members from `KeyIntent` — `home-input`, `composer-input`, `composer-backspace`, `slash-input`, `slash-backspace`, `pin-input`, `pin-backspace` — leaving `home-backspace` with an amended comment. Replace the whole union with exactly this:

```ts
export type KeyIntent =
  | {
      /**
       * The ONE surviving editing intent (§6.1/§6.4). While `homeHealth.kind === "blocked"` the
       * Home prompt is blurred and receives no keys, so backspace cannot reach the editor — and
       * backspace is the only thing that can empty a prompt whose `q` quit is gated on emptiness.
       */
      readonly kind: "home-backspace";
    }
  | { readonly kind: "home-submit" }
  | { readonly kind: "home-recheck" }
  | { readonly kind: "composer-submit" }
  | { readonly kind: "action-execute"; readonly actionId: string }
  | { readonly kind: "slash-open" }
  | { readonly kind: "slash-move"; readonly delta: -1 | 1 }
  | { readonly kind: "slash-submit" }
  | { readonly kind: "chat-move"; readonly delta: -1 | 1 }
  | { readonly kind: "chat-switch" }
  | { readonly kind: "pin-save" }
  | { readonly kind: "trust-accept" }
  | { readonly kind: "trust-decline" }
  | { readonly kind: "overlay-dismiss" }
  | { readonly kind: "export-dismiss" }
  | { readonly kind: "esc" }
  | { readonly kind: "tab" }
  | { readonly kind: "exit" }
  | { readonly kind: "none" };
```

3. Replace `RETURN_NAMES` and add the submit predicate plus the claim rule:

```ts
/** Every name a terminal reports for the Enter key, main row or numpad. */
const RETURN_NAMES: ReadonlySet<string> = new Set(["return", "enter", "kpenter"]);

/**
 * An UNMODIFIED Enter — the only one the App claims.
 *
 * `Shift+Enter`, `Alt+Enter` and `Ctrl+J` are the editor's three newline routes (§4.4), so they
 * must fall through. `Ctrl+J` needs no check here at all: it parses as `linefeed`, a different
 * name entirely.
 */
function isSubmitKey(key: KeyLike): boolean {
  return RETURN_NAMES.has(key.name) && !key.shift && !key.meta && !key.ctrl;
}

/**
 * THE CLAIM RULE (§6.4), and the reason there is no second list of "keys the App owns" — a second
 * list would drift from the first.
 *
 * > The App calls `preventDefault()` if and only if `resolveKey` returned an intent other than
 * > `none`.
 *
 * This holds because seven of the eight editing intent kinds have left {@link KeyIntent}. What
 * remains in the union is, by definition, what the App governs: `Esc`, `Tab`, the F-keys, the
 * registry hotkeys, an unmodified `Enter`, `/` on an empty primary input, and the arrows while
 * the slash menu is open. Everything else resolves to `none` and reaches the focused editor.
 *
 * A welcome consequence: with the menu open, `↑`/`↓` drive the row selection while `←`/`→`,
 * `Ctrl+←`/`Ctrl+→` and `Ctrl+W` reach the editor, so the filter is editable with the same full
 * set as ordinary text — which it was not before.
 */
export function isClaimedKey(intent: KeyIntent): boolean {
  return intent.kind !== "none";
}
```

4. Delete `printableChar` entirely — nothing resolves a printable to an intent any more. The two `/`-open checks read `key.sequence === "/"` already.

5. Rewrite the affected branches of `resolveKey`:

```ts
  if (context.screen === "trust-prompt") {
    if (isSubmitKey(key)) return { kind: "trust-accept" };
    if (key.name === "escape") return { kind: "trust-decline" };
    return { kind: "none" };
  }

  if (context.overlay === "export") {
    if (key.name === "escape" || isSubmitKey(key)) return { kind: "export-dismiss" };
    return { kind: "none" };
  }

  if (context.screen === "read-only" && context.overlay === "slash-menu") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    return { kind: "none" };
  }

  if (context.overlay === "slash-menu") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    if (isSubmitKey(key)) return { kind: "slash-submit" };
    if (key.name === "up" && !key.ctrl) return { kind: "slash-move", delta: -1 };
    if (key.name === "down" && !key.ctrl) return { kind: "slash-move", delta: 1 };
    // Everything else — printables, Backspace, ←/→, Ctrl+←/→, Ctrl+W — reaches the editor, which
    // IS the filter's buffer. The closing rule moved to `mirrorPrimaryInput` (§7.3).
    return { kind: "none" };
  }

  if (context.overlay === "chat-list") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    if (isSubmitKey(key)) return { kind: "chat-switch" };
    if (key.name === "up") return { kind: "chat-move", delta: -1 };
    if (key.name === "down") return { kind: "chat-move", delta: 1 };
    return { kind: "none" };
  }

  if (context.overlay === "pin-input") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    // On a read-only screen the pin editor is never focused, so nothing reaches it either way —
    // this keeps the refusal explicit at the key layer as well.
    if (context.screen === "read-only") return { kind: "none" };
    if (isSubmitKey(key)) return { kind: "pin-save" };
    return { kind: "none" };
  }
```

Home:

```ts
    if (context.homeHealth.kind === "blocked") {
      if (key.sequence === "r") return { kind: "home-recheck" };
      if (key.sequence === "q" && context.homePrompt.length === 0) return { kind: "exit" };
      // The escape route the `q` guard needs (fix round 3). The prompt is blurred here, so this
      // intent is the ONLY thing that can shrink it toward empty — see `TextEditorHandle
      // .deleteCharBackward`'s own doc comment for the other half of the arrangement.
      if (key.name === "backspace") return { kind: "home-backspace" };
      return { kind: "none" };
    }
    if (isSubmitKey(key)) {
      if (context.projectOpening) return { kind: "none" };
      return homeSubmitAllowed(context.homeHealth) ? { kind: "home-submit" } : { kind: "none" };
    }
    if (key.sequence === "/" && context.homePrompt.length === 0) return { kind: "slash-open" };
    return { kind: "none" };
```

(the unconditional `if (key.name === "backspace") return { kind: "home-backspace" };` that sat below the Enter branch is deleted — a live Home prompt's backspace belongs to the editor.)

Composer:

```ts
  if (composerActive) {
    if (key.sequence === "/" && context.composerValue.length === 0) return { kind: "slash-open" };
    if (isSubmitKey(key)) return { kind: "composer-submit" };
  }

  return { kind: "none" };
```

- [ ] **Step 4: Delete the dead intent arms**

In `src/ui/app/model/intent.ts`, delete the `home-input`, `composer-input`, `composer-backspace`, `slash-input`, `slash-backspace`, `pin-input` and `pin-backspace` cases. Delete `setPinInput`'s now-unused import if nothing else calls it — `pin-save` and `overlay-dismiss` still do, so it stays.

Delete the matching tests in `src/ui/app/model/intent.test.ts` (the `home-input` half, `slash-input`/`slash-backspace` cases, and the pin-draft typing cases). Keep every test that covers `slash-open`, `slash-submit`, `slash-move`, `pin-save`, both submits and F6 — those paths are unchanged.

- [ ] **Step 5: Make `App.tsx` claim keys**

In `src/ui/app/ui/App.tsx`, import `isClaimedKey` alongside `resolveActiveOverlay` and `resolveKey`, and add the claim after the trace call:

```tsx
    trace("ui.onKey", { /* …unchanged… */ });
    // THE CLAIM (§4.6, §6.4). Global listeners run before renderable handlers, and
    // `Renderable.focus()`'s own keypress handler skips `handleKeyPress` when
    // `key.defaultPrevented` — so this is a COMPLETE gate, and the single point where the App and
    // the focused editor divide the keyboard. Derived from the resolved intent rather than a
    // second key list, which would drift.
    if (isClaimedKey(intent)) key.preventDefault();
    applyIntent(intent, deps);
```

Add it to the module barrel too, beside the two resolvers already there — `src/ui/app/index.ts`:

```ts
export { isClaimedKey, resolveActiveOverlay, resolveKey } from "./model/keymap";
```

- [ ] **Step 6: Drop the arrow aliases**

In `src/ui/actions/model/registry.ts`, remove `aliases: ["ctrl+left"]` from the `page.prev` hotkey and `aliases: ["ctrl+right"]` from `page.next`, and amend the block comment above `page.prev` — replace the bullet `- the arrows stay as aliases, so the chord still works wherever it IS encoded;` with:

```
    //   - the ctrl+arrow aliases were DROPPED when the composer became a real editor
    //     (2026-08-03): `ctrl+left`/`ctrl+right` are OpenTUI's own `word-backward`/`word-forward`
    //     bindings, and `resolveHotkey` runs ahead of every input branch, so keeping them would
    //     have made Ctrl+Left switch pages from inside a text field. Neither alias was ever drawn
    //     — both entries carry `hint: false` — so nothing on screen named them;
```

- [ ] **Step 7: Update `App.test.tsx`**

Any App test that types into the composer or the Home prompt via `mockInput` now depends on a mounted editor, which does not exist until Tasks 8 and 9. Find them with:

```bash
rtk git grep -n "typeText\|pressBackspace" src/ui/app/ui/App.test.tsx
```

Change each affected `test(` to `test.skip(` — leaving its title and body untouched — and put this comment on the line above, with the right task number (8 for composer tests, 9 for Home-prompt tests):

```tsx
  // RE-ENABLED IN TASK 8: typing now flows through the mounted composer editor, not applyIntent.
```

Do **not** delete or reword any of them; Task 11 turns every one back on and verifies it.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test src/ui`
Expected: PASS, with the skipped App tests reported as skipped.

- [ ] **Step 9: Typecheck, lint, format**

Run: `bunx tsc --noEmit && bun run lint && bun run fmt`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
printf '%s\n' \
  'feat(ui): derive the key claim from the resolved intent' \
  '' \
  'resolveKey loses seven editing intent kinds; App preventDefaults exactly when' \
  'an intent other than none came back, so every unclaimed key reaches the focused' \
  'editor. Drops the ctrl+left/ctrl+right page-step aliases, which would otherwise' \
  'shadow the editor word-movement bindings.' \
  > /tmp/tc-commit-msg.txt
rtk git add src/ui/app src/ui/actions && rtk git commit -F /tmp/tc-commit-msg.txt
```

---

### Task 8: The composer becomes a real editor

**Files:**
- Modify: `src/ui/chat/ui/Composer.tsx`, `src/ui/workspace/ui/Workspace.tsx`, `src/ui/workspace/types.ts`, `src/ui/workspace/model/agent-block-budget.ts`, `src/ui/app/ui/App.tsx`
- Test: `src/ui/chat/ui/Composer.test.tsx`, `src/ui/workspace/model/agent-block-budget.test.ts`, `src/ui/workspace/ui/Workspace.test.tsx`, `src/ui/app/ui/App.test.tsx`

**Interfaces:**
- Consumes: `TextEditor`, `EditorBridge`, `editorRowCount` (Tasks 2/4), `UiDeps.editors` (Task 5).
- Produces:
  - `composerRowCount(hasAttach: boolean, editorRows: number): number`
  - `ComposerProps` gains `focused: boolean`, `rows: number`, `width: number`, `bridge: EditorBridge` and loses `value: string`.
  - `WorkspaceLocalState` gains `composerEditor: Atom<TextEditorHandle | null>`; `WorkspaceDeps` gains `editors: { readonly composer: EditorBridge }`; the `Workspace` component gains an `activeOverlay: OverlayKind | null` prop.

- [ ] **Step 1: Write the failing test for the row budget**

In `src/ui/workspace/model/agent-block-budget.test.ts`, replace the `composerRowCount` describe block:

```ts
describe("composerRowCount", () => {
  test("is the seam row plus the editor's own rows, with no attach line", () => {
    expect(composerRowCount(false, 1)).toBe(2);
    expect(composerRowCount(false, 3)).toBe(4);
    expect(composerRowCount(false, 6)).toBe(7);
  });

  test("adds one for the attach line", () => {
    expect(composerRowCount(true, 1)).toBe(3);
    expect(composerRowCount(true, 4)).toBe(6);
  });

  test("at one editor row it is exactly what the design's fixed composer always was", () => {
    // The single-row case must stay pixel-identical (spec §3): 2 without an attach line, 3 with.
    expect(composerRowCount(false, 1)).toBe(2);
    expect(composerRowCount(true, 1)).toBe(3);
  });
});
```

And add, at the end of the `agentStatusMaxRows` block:

```ts
  test("a grown composer takes its rows out of the live block's budget", () => {
    const base = agentStatusMaxRows({
      frameH: 35,
      chromeRows: 1,
      hasAgentLine: true,
      pinListRows: 0,
      composerRows: composerRowCount(false, 1),
    });
    const grown = agentStatusMaxRows({
      frameH: 35,
      chromeRows: 1,
      hasAgentLine: true,
      pinListRows: 0,
      composerRows: composerRowCount(false, 4),
    });
    expect(base - grown).toBe(3);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/ui/workspace/model/agent-block-budget.test.ts`
Expected: FAIL — `composerRowCount` takes one argument.

- [ ] **Step 3: Change `composerRowCount`**

In `src/ui/workspace/model/agent-block-budget.ts`:

```ts
/**
 * How many rows `Composer` actually renders: the seam row, an optional attach line, and however
 * many rows the editor takes.
 *
 * WAS the constant `2 | 3` (spec §6.3): `TextInput` always rendered exactly one row, because the
 * design draws the input on exactly one — `drawChat` `:256`, `workspace` `:594`. The editor now
 * grows to `editorMaxRows(frameH)` (`ui/text-input`'s own approved divergence, spec §3), and its
 * height is subtracted from the chat's budget in the SAME frame the text changes, which is why
 * the count is passed in rather than asked of the renderable one frame later.
 *
 * At `editorRows === 1` this is exactly today's 2 and 3.
 */
export function composerRowCount(hasAttach: boolean, editorRows: number): number {
  return 1 + (hasAttach ? 1 : 0) + Math.max(1, editorRows);
}
```

- [ ] **Step 4: Write the failing component test**

Rewrite the value-bearing cases of `src/ui/chat/ui/Composer.test.tsx`. Add a bridge helper at the top:

```tsx
import type { EditorBridge } from "ui/text-input";

/** A bridge shaped like the real one: seeds from a caller-owned string, records projections. */
const bridgeWith = (seed: string, sink?: (text: string) => void): EditorBridge => ({
  attach: (handle) => {
    if (handle !== null) handle.setText(seed);
  },
  mirror: (text) => sink?.(text),
});

const composerProps = {
  id: "composer",
  modelChip: "claude · sonnet-4.5",
  ctx: null,
  placeholder: "Ask for changes…",
  focused: true,
  rows: 1,
  width: 40,
} as const;
```

Update every existing mount to the new props (dropping `value=""`, adding `bridge={bridgeWith("")}` and the four constants above) and add:

```tsx
  test("renders the seeded draft in the foreground hue", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 4 });
    open = handle;
    handle.mount(<Composer {...composerProps} bridge={bridgeWith("fix the gauge")} />);
    await handle.render();
    const run = findRun(handle.capture(), "fix the gauge");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.fg);
  });

  test("renders a multi-row draft across the rows it was given", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 6 });
    open = handle;
    handle.mount(
      <Composer {...composerProps} rows={3} bridge={bridgeWith("first line\nsecond line")} />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "first line")).toBeDefined();
    expect(findRun(frame, "second line")).toBeDefined();
  });
```

- [ ] **Step 5: Rewrite `Composer.tsx`'s input row**

Replace the `ComposerProps.value` field with the new props:

```ts
  /** Whether keys reach the composer's editor. */
  readonly focused: boolean;
  /** How many rows the editor renders — `ui/text-input`'s `editorRowCount`, computed by the caller. */
  readonly rows: number;
  /** The editor's own width in cells, excluding the caret run. */
  readonly width: number;
  /** The composer editor's wiring — `deps.editors.composer`. */
  readonly bridge: EditorBridge;
```

and replace the `<TextInput …/>` element:

```tsx
      <TextEditor
        id={`${props.id}-input`}
        placeholder={props.placeholder}
        caret={"❯ "}
        caretFg={props.disabled === true ? SHELL_PALETTE.faint : SHELL_PALETTE.amber}
        valueFg={SHELL_PALETTE.fg}
        placeholderFg={SHELL_PALETTE.faint}
        cursorFg={SHELL_PALETTE.amber}
        multiline
        rows={props.rows}
        width={props.width}
        focused={props.focused}
        // `focused` and `showCursor` are DELIBERATELY independent (§7.5). §3.2 permits typing the
        // next message while a turn runs and refuses only sending, but the design draws a running
        // turn with an empty composer as a faint placeholder with NO cursor (`wsGenTyping`,
        // `design/termcraft-engine.js:259-277`). Blurring the composer would revoke §3.2; keeping
        // `focused` true while `showCursor` goes false satisfies both.
        showCursor={props.disabled !== true}
        bridge={props.bridge}
      />
```

Amend the component's doc comment: replace the closing paragraph about `TextInput` with

```
 * The input row is `ui/text-input`'s {@link TextEditor} — the caret, the placeholder, the cursor
 * and the whole editing key table come from that one component, and the text itself lives in its
 * native edit buffer rather than in a prop. `value` is gone from these props for that reason; the
 * caller still reads the mirror atom to decide `disabled` and to size `rows`.
```

- [ ] **Step 6: Wire `Workspace.tsx`**

1. In `src/ui/workspace/types.ts`, add to `WorkspaceLocalState`:

```ts
  /** The mounted composer editor, or `null`. See `ui/app/model/primary-input.ts`. */
  readonly composerEditor: Atom<TextEditorHandle | null>;
```

and to `WorkspaceDeps`:

```ts
  /**
   * The composer editor's wiring. Declared here, structurally, for the same reason the rest of
   * this interface is: `ui/workspace` never imports `ui/app`, and the App's `UiDeps` satisfies
   * this shape.
   */
  readonly editors: { readonly composer: EditorBridge };
```

with `import type { EditorBridge, TextEditorHandle } from "ui/text-input";` at the top.

2. In `Workspace.tsx`, add the `activeOverlay` prop and derive focus from it:

```tsx
export const Workspace = reatomComponent<{
  deps: WorkspaceDeps;
  readOnly: boolean;
  /**
   * Which surface owns the keys, ALREADY precedence-resolved by the App's own
   * `resolveActiveOverlay` — the same call `renderOverlay` and the key-context builder make. Read
   * here rather than re-derived from `local.overlay()` so the composer's focus, the popup that is
   * drawn, and the keys `resolveKey` routes can never disagree about who owns the keyboard.
   */
  activeOverlay: OverlayKind | null;
}>((props) => {
```

3. Replace the `slashOpen` derivation:

```tsx
  const slashOpen = !props.readOnly && props.activeOverlay === "slash-menu";
```

Then add the editor geometry. `chatContentWidth` is currently declared AFTER `agentBlockMaxRows`; **delete that declaration** and re-declare it at the top of this block, so the width the editor wraps against and the width the chat wraps against stay one value:

```tsx
  // `ws-chat`'s own inner content width: the panel's width less its left/right border. This is
  // what every `<text>` inside `ws-chat-stream` wraps against, and — less the caret run — what
  // the composer's editor wraps against too.
  const chatContentWidth = Math.max(1, chatW - 2);
  const composerEditorWidth = Math.max(1, chatContentWidth - COMPOSER_CARET_COLUMNS);
  const composerEditorRows = editorRowCount({
    text: composerValue,
    width: composerEditorWidth,
    frameH,
  });
  const pinRowCount = pinListRowCount(pinRows);
  const composerRows = composerRowCount(composerAttach !== null, composerEditorRows);
```

with, near `AGENT_BLOCK_CHROME_ROWS`:

```tsx
/** The `❯ ` caret run `Composer` draws before the editor — two cells, matching `drawChat` `:651`. */
const COMPOSER_CARET_COLUMNS = 2;
```

and the import (`Workspace` sizes the editor but never renders it — `Composer` does):

```tsx
import { editorRowCount } from "ui/text-input";
```

4. Derive the composer's focus. Add this beside the other pre-render derivations, above the `return`:

```tsx
  // §7.5's focus table. The composer keeps the keys while the slash menu is open — the filter IS
  // this buffer — and loses them to any modal overlay, to a preview-focused Tab, and on a
  // read-only screen. Exactly one editor is focused at any moment, which is a requirement rather
  // than a coincidence: the terminal has one hardware cursor.
  const composerEditorFocused =
    !props.readOnly &&
    composerFocused &&
    (props.activeOverlay === null || props.activeOverlay === "slash-menu");
```

5. Rewire the `<Composer …/>` element: drop `value={composerValue}` and add the four new props.

```tsx
              placeholder={composerPlaceholder}
              attach={composerAttach}
              focused={composerEditorFocused}
              rows={composerEditorRows}
              width={composerEditorWidth}
              bridge={props.deps.editors.composer}
```

`disabled` keeps its current expression verbatim — it still reads `composerValue.length === 0`, which is exactly what selects `wsGenTyping`'s two states.

6. In `App.tsx`, pass the resolved overlay down. `renderOverlay` already computes it; hoist the call so both use one value:

```tsx
  const activeOverlay = resolveActiveOverlay(deps.local.overlay(), exportPopupShowing(deps));
  const overlay = renderOverlay(deps, clock(), activeOverlay);
  return (
    <box …>
      <Workspace deps={deps} readOnly={screen === "read-only"} activeOverlay={activeOverlay} />
```

and change `renderOverlay(deps, nowMs)` to `renderOverlay(deps, nowMs, overlay)` taking the resolved value as a parameter instead of recomputing it.

- [ ] **Step 7: Update the Workspace and App tests**

In `Workspace.test.tsx`, add `activeOverlay={null}` to every `<Workspace …/>` mount (or the overlay the test is exercising). Replace any assertion that read composer text out of the frame with one that seeds through `deps.local.composer.set(...)` **before** mounting — the bridge seeds the editor from the mirror at attach, so a pre-mount write is what puts text on screen.

Add:

```tsx
  test("a grown composer takes its rows out of the scrollback, in the same frame", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(workspaceSnapshot());
    deps.local.composer.set("one\ntwo\nthree");
    const renderer = await createReactTestRenderer(
      <Workspace deps={deps} readOnly={false} activeOverlay={null} />,
      { width: 120, height: 36 },
    );
    open = renderer;
    const frame = renderer.captureCharFrame();
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    expect(frame).toContain("three");
  });
```

In `App.test.tsx`, un-skip every composer test skipped in Task 7 and adjust each to drive real keys through the mounted editor.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test src/ui`
Expected: PASS.

- [ ] **Step 9: Typecheck, lint, format**

Run: `bunx tsc --noEmit && bun run lint && bun run fmt`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
printf '%s\n' \
  'feat(ui): make the workspace composer a real editable buffer' \
  '' \
  'Composer renders TextEditor, Workspace sizes it with editorRowCount and feeds' \
  'the real height into the chat row budget, and the composer focus derives from' \
  'the one precedence-resolved overlay the App already computes.' \
  > /tmp/tc-commit-msg.txt
rtk git add src/ui/chat src/ui/workspace src/ui/app && rtk git commit -F /tmp/tc-commit-msg.txt
```

---

### Task 9: The Home prompt becomes a real editor, and `TextInput` is deleted

**Files:**
- Modify: `src/ui/home/ui/Home.tsx`, `src/ui/home/types.ts`, `src/ui/app/ui/App.tsx`, `src/ui/text-input/index.ts`, `src/ui/text-input/types.ts`
- Delete: `src/ui/text-input/ui/TextInput.tsx`, `src/ui/text-input/ui/TextInput.test.tsx`
- Test: `src/ui/home/ui/Home.test.tsx`

**Interfaces:**
- Consumes: `TextEditor`, `editorRowCount`, `UiDeps.editors.prompt`.
- Produces: `HomeProps` gains `promptBridge: EditorBridge`. `TextInputProps` and `TextInput` leave `ui/text-input`'s public surface.

- [ ] **Step 1: Write the failing test**

In `src/ui/home/ui/Home.test.tsx`, add the bridge helper and these tests:

```tsx
import type { EditorBridge } from "ui/text-input";

const bridgeWith = (seed: string): EditorBridge => ({
  attach: (handle) => {
    if (handle !== null) handle.setText(seed);
  },
  mirror: () => undefined,
});
```

```tsx
  test("the prompt box grows with a multi-line prompt, keeping the hint row below it", async () => {
    const handle = await createHeadlessRenderer({ w: 100, h: 30 });
    open = handle;
    handle.mount(
      <Home
        {...homeProps}
        prompt={"first line\nsecond line\nthird line"}
        promptBridge={bridgeWith("first line\nsecond line\nthird line")}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "first line")).toBeDefined();
    expect(findRun(frame, "third line")).toBeDefined();
    // The `⏎ create` hint is pushed down by the grown editor, never overdrawn by it.
    expect(findRun(frame, "⏎ create")).toBeDefined();
  });

  test("the box is exactly its design height while the prompt fits one row", async () => {
    const handle = await createHeadlessRenderer({ w: 100, h: 30 });
    open = handle;
    handle.mount(<Home {...homeProps} prompt="" promptBridge={bridgeWith("")} />);
    await handle.render();
    // design `home()` :139 — `const boxH=6;`. At one editor row nothing about this screen moves.
    // `rectOf` is `RenderHandle`'s own absolute-rectangle query (`host/render/types.ts`).
    expect(handle.rectOf(`${homeProps.id}-prompt-box`)?.height).toBe(6);
  });

  test("the box gains exactly one row per extra editor row", async () => {
    const handle = await createHeadlessRenderer({ w: 100, h: 30 });
    open = handle;
    handle.mount(
      <Home {...homeProps} prompt={"a\nb\nc"} promptBridge={bridgeWith("a\nb\nc")} />,
    );
    await handle.render();
    expect(handle.rectOf(`${homeProps.id}-prompt-box`)?.height).toBe(8);
  });
```

Update every existing `<Home …/>` mount to pass `promptBridge={bridgeWith(<its prompt prop>)}`, and make sure `homeProps` in this file carries the `id` the two assertions above interpolate.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/ui/home`
Expected: FAIL — `promptBridge` is not a prop of `HomeProps`.

- [ ] **Step 3: Add the prop and render `TextEditor`**

In `src/ui/home/types.ts`, add to `HomeProps`:

```ts
  /**
   * The Home prompt editor's wiring — `deps.editors.prompt`. The prompt TEXT is not a prop of the
   * editor (see `ui/text-input`'s `TextEditorProps`); {@link HomeProps.prompt} above stays because
   * the slash menu still renders the typed prefix and the `/`-open gate still reads its length.
   */
  readonly promptBridge: EditorBridge;
```

with `import type { EditorBridge } from "ui/text-input";`.

In `src/ui/home/ui/Home.tsx`:

1. Replace the `TextInput` import with `import { TextEditor, editorRowCount } from "ui/text-input";`.

2. Add the caret constant beside `PROMPT_BOX_HEIGHT`:

```tsx
/** The `❯ ` caret run drawn before the editor — two cells, matching design `home()` `:145`. */
const PROMPT_CARET_COLUMNS = 2;
```

3. In `HomeIdle`, compute the editor geometry after `iw`:

```tsx
  // The editor wraps inside the bordered box: its width less the border and the caret run. The
  // box grows with it, keeping design's own `boxH=6` (`design/termcraft-engine.js:139`) as the
  // one-row case exactly — the same approved divergence the composer takes (spec §3).
  const promptEditorWidth = Math.max(1, iw - 2 - PROMPT_CARET_COLUMNS);
  const promptEditorRows = editorRowCount({
    text: props.prompt,
    width: promptEditorWidth,
    frameH: props.height - 1,
  });
```

4. On the `prompt-box` box, replace `height={PROMPT_BOX_HEIGHT}` with:

```tsx
            height={PROMPT_BOX_HEIGHT + promptEditorRows - 1}
```

5. Replace the `<TextInput …/>` element:

```tsx
            <TextEditor
              id={`${props.id}-prompt-row`}
              placeholder={PLACEHOLDER}
              caret={"❯ "}
              caretFg={blocked ? SHELL_PALETTE.faint : SHELL_PALETTE.amber}
              valueFg={SHELL_PALETTE.fg}
              placeholderFg={SHELL_PALETTE.faint}
              cursorFg={SHELL_PALETTE.amber}
              multiline
              rows={promptEditorRows}
              width={promptEditorWidth}
              // `blocked` is the one outcome with a genuinely non-interactive prompt (keymap.ts's
              // own fix-round-1 Finding 6): design `homeHealth('login')` `:173` draws no cursor
              // over a refused prompt, and blurring it is what makes the `r`/`q` keys safe to bind
              // literally there. `missing` never reaches this component at all.
              focused={!blocked}
              showCursor={!blocked}
              bridge={props.promptBridge}
            />
```

and amend the comment block above it: keep the design citations, replace "TextInput (finding §2.6, phase-8 Task 18) reproduces that exactly" with "`TextEditor` reproduces that by construction — the cursor is the terminal's own, and it physically occupies the placeholder's first cell".

- [ ] **Step 4: Pass the bridge from `App.tsx`**

In the `screen === "home"` branch, add `promptBridge={deps.editors.prompt}` to the `<Home …/>` element.

- [ ] **Step 5: Delete `TextInput`**

```bash
rtk git rm src/ui/text-input/ui/TextInput.tsx src/ui/text-input/ui/TextInput.test.tsx
```

Remove the last two export lines from `src/ui/text-input/index.ts` and delete the `TextInputProps` interface from `src/ui/text-input/types.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/ui`
Expected: PASS, and no test file named `TextInput.test.tsx` in the output.

- [ ] **Step 7: Typecheck, lint, format**

Run: `bunx tsc --noEmit && bun run lint && bun run fmt`
Expected: exit 0. A leftover `TextInput` import anywhere fails here.

- [ ] **Step 8: Commit**

```bash
printf '%s\n' \
  'feat(ui): make the Home prompt a real editable buffer and drop TextInput' \
  '' \
  'The prompt box grows with the editor and keeps design boxH=6 as its one-row' \
  'case. TextInput had exactly two consumers and both now render TextEditor.' \
  > /tmp/tc-commit-msg.txt
rtk git add -A src/ui && rtk git commit -F /tmp/tc-commit-msg.txt
```

---

### Task 10: The pin-input popup becomes a real editor

**Files:**
- Modify: `src/ui/popups/ui/PinInputPopup.tsx`, `src/ui/app/ui/App.tsx`
- Test: `src/ui/popups/ui/PinInputPopup.test.tsx`

**Interfaces:**
- Consumes: `TextEditor`, `EditorBridge`, `UiDeps.editors.pin`.
- Produces: `PinInputPopupProps` loses `value: string` and gains `focused: boolean` and `bridge: EditorBridge`.

- [ ] **Step 1: Write the failing test**

Rewrite `src/ui/popups/ui/PinInputPopup.test.tsx`'s value cases with the bridge helper:

```tsx
import type { EditorBridge } from "ui/text-input";

const bridgeWith = (seed: string): EditorBridge => ({
  attach: (handle) => {
    if (handle !== null) handle.setText(seed);
  },
  mirror: () => undefined,
});
```

```tsx
  test("renders a seeded comment in the foreground hue", async () => {
    const handle = await createHeadlessRenderer({ w: 48, h: 6 });
    open = handle;
    handle.mount(
      <PinInputPopup
        id="pin-input"
        focused
        bridge={bridgeWith("why is this always on top?")}
      />,
    );
    await handle.render();
    const run = findRun(handle.capture(), "why is this always on top?");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.fg);
  });

  test("stays one row tall — a pin comment is single-line by design", async () => {
    const handle = await createHeadlessRenderer({ w: 48, h: 6 });
    open = handle;
    handle.mount(
      <PinInputPopup id="pin-input" focused bridge={bridgeWith("first\nsecond")} />,
    );
    await handle.render();
    const frame = handle.capture();
    // `InputRenderable` strips newlines from both typing and paste, so the seed collapses.
    expect(findRun(frame, "firstsecond")).toBeDefined();
  });
```

Update the remaining mounts (title, footer) to the new props.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/ui/popups/ui/PinInputPopup.test.tsx`
Expected: FAIL — `bridge` is not a prop.

- [ ] **Step 3: Rewrite the component**

```tsx
import { TextEditor } from "ui/text-input";
import type { EditorBridge } from "ui/text-input";
import { SHELL_PALETTE } from "ui/theme";

/** The content width of the box, inside its border. */
const PIN_INPUT_WIDTH = 38;

/** Props for the {@link PinInputPopup} new-pin comment input box. */
export interface PinInputPopupProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  /** Whether keys reach the comment field. False on a read-only screen. */
  readonly focused: boolean;
  /** The pin editor's wiring — `deps.editors.pin`. */
  readonly bridge: EditorBridge;
}
```

```tsx
export function PinInputPopup(props: PinInputPopupProps) {
  return (
    <box
      id={props.id}
      width={PIN_INPUT_WIDTH + 2}
      border
      borderStyle="rounded"
      borderColor={SHELL_PALETTE.amber}
      title="new pin"
      titleColor={SHELL_PALETTE.amberHi}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
      padding={0}
    >
      <TextEditor
        id={`${props.id}-input`}
        placeholder=""
        // Design draws no caret glyph for this field — `wsPinInput` `:699` starts the text at
        // `pxs+2` with no `❯` — so the caret run is empty and the editor owns the whole row.
        caret=""
        caretFg={SHELL_PALETTE.amber}
        valueFg={SHELL_PALETTE.fg}
        placeholderFg={SHELL_PALETTE.faint}
        cursorFg={SHELL_PALETTE.amber}
        // Single-line: `InputRenderable` enforces height 1, no wrapping, and newline stripping
        // including from paste — which is what a one-row comment field wants.
        multiline={false}
        rows={1}
        width={PIN_INPUT_WIDTH}
        focused={props.focused}
        showCursor={props.focused}
        bridge={props.bridge}
      />
      <text id={`${props.id}-footer`} fg={SHELL_PALETTE.faint}>
        {"⏎ save · esc cancel"}
      </text>
    </box>
  );
}
```

Amend the doc comment: keep the existing footer divergence, replace the "deliberately does NOT use the shared `ui/text-input`" paragraph with

```
 * divergence (width): design sizes the box `pw = Math.min(40, dw - 14)` (`wsPinInput` `:696`),
 * where `dw` is the preview pane's inner width — the popup there is anchored beside the numbered
 * badge. This component is centred in the App's modal layer instead (already a documented
 * divergence: "the numbered anchor badge … are the App/overlay's concern"), so the `dw - 14`
 * shrink term has no meaning here and the design's own upper bound, 40, is used directly.
 *
 * The comment field is `ui/text-input`'s {@link TextEditor} in its single-line form. Design draws
 * the cursor one column past the end of the value (`this.put(b,pxs+2+26,pys+1,'█',…)`, `:699`),
 * which is exactly where the terminal's own cursor sits after the last character — the placement
 * this component used to emulate now holds by construction.
```

- [ ] **Step 4: Wire it in `App.tsx`**

```tsx
  if (overlay === "pin-input") {
    return (
      <PinInputPopup
        id="overlay-pin"
        // §7.5: the field is live except on a read-only screen, where pins are refused outright.
        focused={deps.screen() !== "read-only"}
        bridge={deps.editors.pin}
      />
    );
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/ui`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, format**

Run: `bunx tsc --noEmit && bun run lint && bun run fmt`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
printf '%s\n' 'feat(ui): make the pin comment field a real editable buffer' > /tmp/tc-commit-msg.txt
rtk git add src/ui/popups src/ui/app && rtk git commit -F /tmp/tc-commit-msg.txt
```

---

### Task 11: The integration tests §10.2 asks for, and the doc sync

**Files:**
- Create: `src/ui/text-input/ui/input-editing.test.tsx`
- Modify: `docs/architecture/modules.md`, `docs/architecture/code-structure.md`, `docs/architecture/flows/interactive-prototype.md`
- Test: `src/ui/app/ui/App.test.tsx` (every test skipped in Task 7 is re-enabled and verified)

**Interfaces:**
- Consumes: everything above.
- Produces: no new exports.

- [ ] **Step 1: Write the integration tests**

Create `src/ui/text-input/ui/input-editing.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { uuidv7 } from "infrastructure/uuid";
import { App, createUiDeps } from "ui/app";
import {
  type ReactTestRenderer,
  TEST_TS,
  createFakeKernel,
  createReactTestRenderer,
  event,
  resetEventSeq,
  snapshot,
} from "ui/testing";

import { wrappedLineCount } from "../model/editor-height";
import { TEXT_EDITOR_KEY_BINDINGS } from "../model/key-bindings";

let open: ReactTestRenderer | null = null;
afterEach(async () => {
  await open?.destroy();
  open = null;
});
beforeEach(() => resetEventSeq());

/** The same open-project snapshot `App.test.tsx` and `Workspace.test.tsx` already build. */
const workspaceSnapshot = () =>
  snapshot({
    projectId: uuidv7(),
    activePageSlug: "main",
    activeChatId: uuidv7(),
    trust: "trusted",
    agentIdentity: { backendId: "claude", modelLabel: "sonnet-4.5" },
  });

async function workspace(kittyKeyboard: boolean) {
  const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
  deps.mirror.apply(workspaceSnapshot());
  const renderer = await createReactTestRenderer(<App deps={deps} />, {
    width: 120,
    height: 36,
    kittyKeyboard,
  });
  open = renderer;
  await renderer.waitForFrame((frame) => frame.includes("Ask for changes…"));
  return { deps, renderer };
}

describe("the two-mode run — §9.2's degradation table as an executable test", () => {
  test("with the extended protocol, Shift+Enter breaks the line and Ctrl+Backspace eats a word", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => {
      renderer.mockInput.typeText("alpha beta");
      renderer.mockInput.pressEnter({ shift: true });
      renderer.mockInput.typeText("gamma");
    });
    expect(deps.local.composer()).toBe("alpha beta\ngamma");
    await renderer.act(() => renderer.mockInput.pressBackspace({ ctrl: true }));
    expect(deps.local.composer()).toBe("alpha beta\n");
  });

  test("without it, Ctrl+J breaks the line and Ctrl+W eats a word", async () => {
    const { deps, renderer } = await workspace(false);
    await renderer.act(() => {
      renderer.mockInput.typeText("alpha beta");
      // The byte for Shift+Enter does not exist here — this is a no-op, not a failure.
      renderer.mockInput.pressEnter({ shift: true });
      renderer.mockInput.pressKey("\n");
      renderer.mockInput.typeText("gamma");
    });
    expect(deps.local.composer()).toBe("alpha beta\ngamma");
    await renderer.act(() => renderer.mockInput.pressBackspace({ ctrl: true }));
    // Ctrl+Backspace collapses to a plain backspace here; the fallback is what deletes the word.
    expect(deps.local.composer()).toBe("alpha beta\ngamm");
    await renderer.act(() => renderer.mockInput.pressKey("\u0017"));
    expect(deps.local.composer()).toBe("alpha beta\n");
  });
});

describe("growth, scroll and the chat budget", () => {
  test("Enter still submits while Shift+Enter breaks the line", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => {
      renderer.mockInput.typeText("send me");
      renderer.mockInput.pressEnter();
    });
    await renderer.waitFor(() => deps.local.composer() === "");
    expect(deps.local.composer()).toBe("");
  });

  test("the composer stops growing at the ceiling and scrolls to follow the cursor", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => {
      for (let line = 1; line <= 9; line += 1) {
        renderer.mockInput.typeText(`line${line}`);
        renderer.mockInput.pressEnter({ shift: true });
      }
      renderer.mockInput.typeText("tail");
    });
    const frame = renderer.captureCharFrame();
    // The ceiling at frameH 35 is 6 rows, so the head has scrolled out and the tail is on screen.
    expect(frame).toContain("tail");
    expect(frame).not.toContain("line1");
    expect(deps.local.composer().split("\n")).toHaveLength(10);
  });

  test("a bracketed paste lands in the buffer whole, newlines and all (§9.4)", async () => {
    const { deps, renderer } = await workspace(true);
    // NEW BEHAVIOUR: `usePaste` is wired nowhere in this codebase, so pasted text used to arrive
    // as individual keypresses or be lost outright. `TextareaRenderable.handlePaste` inserts it
    // as one edit. No size cap is introduced — the design has none, and silently truncating a
    // user's text is worse than inserting it.
    await renderer.act(() => renderer.mockInput.pasteBracketedText("one\ntwo\nthree"));
    expect(deps.local.composer()).toBe("one\ntwo\nthree");
  });

  test("a grown composer costs the scrollback its rows", async () => {
    const { deps, renderer } = await workspace(true);
    const before = renderer.captureCharFrame().split("\n").length;
    await renderer.act(() => {
      renderer.mockInput.pressEnter({ shift: true });
      renderer.mockInput.pressEnter({ shift: true });
    });
    // The frame is the same height; what changed is how many of its rows the composer owns.
    expect(renderer.captureCharFrame().split("\n").length).toBe(before);
    expect(deps.local.composer()).toBe("\n\n");
  });
});

describe("the slash menu's two new closing rules, end to end", () => {
  test("deleting the leading slash closes the menu and leaves the text", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => renderer.mockInput.typeText("/export"));
    expect(deps.local.overlay()).toBe("slash-menu");
    await renderer.act(() => {
      // Home, then delete forward past the "/" — reachable only now that the cursor can move.
      renderer.mockInput.pressKey("HOME");
      renderer.mockInput.pressKey("DELETE");
    });
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.composer()).toBe("export");
  });

  test("erasing the filter to empty closes the menu", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => renderer.mockInput.typeText("/e"));
    expect(deps.local.overlay()).toBe("slash-menu");
    await renderer.act(() => {
      renderer.mockInput.pressBackspace();
      renderer.mockInput.pressBackspace();
    });
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.composer()).toBe("");
  });

  test("arrows edit the filter while up/down still move the selection", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => renderer.mockInput.typeText("/export"));
    await renderer.act(() => {
      renderer.mockInput.pressArrow("left");
      renderer.mockInput.typeText("X");
    });
    expect(deps.local.composer()).toBe("/exporXt");
  });
});

describe("wrappedLineCount conformance — our counter against the native layout", () => {
  const CASES: ReadonlyArray<readonly [string, number]> = [
    ["hello world again", 10],
    ["supercalifragilisticexpialidocious", 10],
    ["日本語日本語日本語", 10],
    ["abc\n", 10],
    ["ab cdefghijklmnopqr", 10],
    ["", 10],
  ];

  test("agrees with TextareaRenderable.virtualLineCount for every case", async () => {
    const setup = await createTestRenderer({ width: 60, height: 60 });
    try {
      const editors = CASES.map(([text, width], index) => {
        const editor = new TextareaRenderable(setup.renderer, {
          id: `conformance-${index}`,
          width,
          height: 8,
          wrapMode: "word",
          keyBindings: [...TEXT_EDITOR_KEY_BINDINGS],
          initialValue: text,
        });
        setup.renderer.root.add(editor);
        return editor;
      });
      await setup.renderOnce();
      CASES.forEach(([text, width], index) => {
        // This is the ONLY thing holding an independent counter to the renderer's own layout. It
        // exists because the row budget must be known in the SAME frame the text changes — asking
        // the renderable would answer one frame late and make the chat region jitter on every wrap.
        expect(wrappedLineCount(text, width)).toBe(editors[index]?.virtualLineCount ?? -1);
      });
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("the cursor is painted exactly where §7.5 says", () => {
  test("a running turn with an empty draft keeps typing live but paints no cursor", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => {
      // Driven through the mirror's own event fold, exactly as `Workspace.test.tsx` does — never
      // by writing a mirror slice directly.
      deps.mirror.apply(
        event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }),
      );
    });
    expect(renderer.renderer.getCursorState().visible).toBe(false);
    await renderer.act(() => renderer.mockInput.typeText("next message"));
    expect(deps.local.composer()).toBe("next message");
    // A non-empty draft during a turn looks alive again — `wsGenTyping`'s own two states.
    expect(renderer.renderer.getCursorState().visible).toBe(true);
  });

  test("focus on the preview takes the cursor off the composer entirely", async () => {
    const { renderer } = await workspace(true);
    await renderer.act(() => renderer.mockInput.pressTab());
    expect(renderer.renderer.getCursorState().visible).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `bun test src/ui/text-input/ui/input-editing.test.tsx`
Expected: PASS. If the scroll test's `not.toContain("line1")` fails, print `captureCharFrame()` and check the ceiling: at `frameH = 35`, `editorMaxRows` is 6, so a 10-line draft must have scrolled. If the bracketed-paste test fails, check whether the renderable received the paste at all before changing anything — `PasteEvent` is delivered to the focused renderable on the same path as a keypress.

- [ ] **Step 3: Re-enable every skipped App test**

Run: `rtk git grep -n "RE-ENABLED IN TASK" src/ui/app/ui/App.test.tsx`
Remove every `.skip` and its marker comment, and make each test pass by driving real keys.

Run: `bun test src/ui/app/ui/App.test.tsx`
Expected: PASS with zero skipped tests.

- [ ] **Step 4: Update the architecture docs**

`docs/architecture/modules.md:96` — replace the `src/ui/text-input/` bullet:

```
- `src/ui/text-input/` — the one editable text surface in the shell, `TextEditor`: a caret run plus OpenTUI's `<textarea>` (multi-line, word-wrapped, growing to `clamp(floor(frameH/4), 1, 6)` rows and scrolling past it) or `<input>` (single-line, newline-stripping). The buffer lives in the renderable's native `EditBuffer` and the UI-local `Atom<string>` is its downstream mirror; external writes reach the mounted buffer through a `TextEditorHandle` recorded on `UiLocalState`. `model/key-bindings.ts` holds the editing key table (Enter submits, `Shift+Enter`/`Ctrl+J`/`Alt+Enter` break the line, `Ctrl+Backspace`/`Ctrl+W` delete a word, `Ctrl+Z`/`Ctrl+Shift+Z`/`Ctrl+Y` undo and redo), `model/editor-height.ts` the growth ceiling and the visual-line counter the chat row budget needs in the same frame the text changes. The Workspace composer, the Home prompt and the pin-comment field all render through it
```

`docs/architecture/modules.md:98` — append to the `src/ui/app/` bullet, before its closing text: `, plus \`model/primary-input.ts\` — the two named input directions (\`mirrorPrimaryInput\` downstream from the editor's buffer into the atom, \`setPrimaryInput\` upstream from an external decision into both) and the per-editor bridges \`createUiDeps\` binds once`.

`docs/architecture/code-structure.md:370` — extend the source-anchor list to name `src/ui/app/model/primary-input.ts` and `src/ui/text-input/model/`.

`docs/architecture/flows/interactive-prototype.md:84` — replace the parenthetical and the trailing clause:

```
- `src/ui/app/model/keymap.ts` — the shell's key → intent resolver; hotkeys resolve generically through the registry (which is how `F5` reaches `preview.retry` and how `ctrl+b`/`ctrl+n` reach the page steps — their `ctrl+left`/`ctrl+right` aliases were dropped in 2026-08-03's input-editing work, where those chords became the editor's own word movement). It no longer resolves text editing at all: `isClaimedKey` is the single split, and every key it does not claim reaches the focused `TextEditor`. Its `KeyIntent` union still has no set-mode or forward-input member, so no key drives interaction-mode or input forwarding
```

- [ ] **Step 5: Run the full suite**

Run: `bun test src/ui`
Then: `bun test src/entrypoint`
Expected: both PASS. A run that prints no `(fail)` lines but also no summary is a crash, not a clean run — re-run before drawing any conclusion.

- [ ] **Step 6: Run the Reatom audit**

Run: `/reatom-audit`
Expected: no findings. This work touched atoms, named actions, and a `bind` boundary on external callbacks — precisely its subject. If the router reports "already audited", the cache was consumed by an earlier run; use `/reatom-audit <paths>` naming `src/ui/app/model/primary-input.ts`, `src/ui/app/model/deps.ts` and `src/ui/text-input/ui/TextEditor.tsx`.

- [ ] **Step 7: Manual verification of the whole feature**

```bash
mkdir -p /tmp/tc-manual && cd /tmp/tc-manual
bun run <repo>/src/main.tsx
```

Walk the list, confirming each on screen:
1. Type a long sentence in the composer — it wraps and the box grows.
2. `Shift+Enter` (or `Ctrl+J` on a legacy terminal) — a line break appears, the chat above shrinks by a row.
3. Keep adding lines past six — growth stops and the view scrolls with the cursor.
4. `←`/`→`/`Home`/`End` move the cursor; typing inserts mid-string.
5. `Ctrl+←`/`Ctrl+→` move by word; `Ctrl+Backspace` (or `Ctrl+W`) deletes one.
6. `Ctrl+Z` undoes, `Ctrl+Shift+Z` (or `Ctrl+Y`) redoes.
7. `Enter` sends; the composer clears and collapses back to one row.
8. Type `/` — the menu opens; `←` and typing edit the filter; deleting the `/` closes it and leaves the text.
9. `Ctrl+B`/`Ctrl+N` still step pages; `Ctrl+E` still exports.
10. Right-click the preview, type a pin comment with the cursor mid-string, `Enter` saves.

- [ ] **Step 8: Commit**

```bash
printf '%s\n' \
  'test(ui): pin the input-editing behaviour end to end and sync the docs' \
  '' \
  'Covers the two-mode degradation table, growth against the chat budget,' \
  'cursor-following scroll, both new slash-menu closing rules, the counter'"'"'s' \
  'conformance with the native layout, and the focus/cursor split.' \
  > /tmp/tc-commit-msg.txt
rtk git add -A src/ui docs/architecture && rtk git commit -F /tmp/tc-commit-msg.txt
```

---

## Verification

After Task 11, all of the following must hold:

```bash
bunx tsc --noEmit          # exit 0
bun run lint               # exit 0
bun run fmt:check          # exit 0
bun test src/ui            # all pass, zero skipped
bun test src/entrypoint    # all pass
```

Plus the ten manual checks in Task 11 Step 7, and no `TextInput` reference anywhere:

```bash
rtk git grep -n "TextInput" src/ docs/   # no matches
```
