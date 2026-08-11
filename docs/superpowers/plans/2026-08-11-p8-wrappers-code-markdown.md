# P8 — `Code` and `Markdown` wrappers (Track B, Wave 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Load `/reatom` and `/errore` before any code-related
> action (CLAUDE.md mandate). Every task ends green — `bun x tsc --noEmit` silent and the named
> suites passing — and is one commit.

**Goal:** Add the two heaviest OpenTUI wrappers — `Code` and `Markdown` — to the
`@termcraft/runtime` catalog, with syntax colors built from the active theme, highlight
diagnostics kept off stdout, and an export path that snapshots the *highlighted* frame instead
of the plain-text one it snapshots today.

**Architecture:** Four pieces, in dependency order. (1) `src/runtime/model/syntax-style.ts`
turns the active theme's `TokenMap` into an OpenTUI `SyntaxStyle` through
`SyntaxStyle.fromStyles`, memoised as one named Reatom `computed`; the roles→capture-scope
mapping is fixed by this plan (Decision D1) and is never re-decided at a call site.
(2) `infrastructure/debug-log` gains a third-party console bridge, installed by the two
processes that own a byte stream (the live shell and the `_host --stdio` child), so
`@opentui/core`'s `console.warn`/`console.error` reach the trace file instead of the terminal
or the protocol pipe. (3) `src/host/render/model/settle.ts` adds a quiet-frames settle loop
that yields real time and joins the one and only render seam this repository has —
`RenderHandle.render()` — and `handleMount` calls it before it captures. (4) The two wrappers
themselves, each a curated prop interface over the `<code>` / `<markdown>` intrinsics with
`syntaxStyle` and `treeSitterClient` withheld.

**Tech Stack:** Bun 1.3, TypeScript 7 (`bun x tsc --noEmit`), Reatom v1001 (`@reatom/core@1001`),
`@opentui/core@0.4.5` + `@opentui/react@0.4.5`, `web-tree-sitter@0.25.10`, `bun:test`,
errore 0.14.1, oxlint/oxfmt.

## Global Constraints

- **Depends on P1 only.** `Color`, `TokenMap`, `useTokens`, `activeTokens` and
  `seedThemeCapability` already exist on this branch (`src/runtime/types.ts`,
  `src/runtime/model/tokens.ts`). Nothing here reads the design-system manifest, the Gate, or the
  host wiring — those are P2/P4.
- **Scope fence.** `src/runtime/model/syntax-style.ts(+test)`, `src/runtime/ui/code.tsx(+test)`,
  `src/runtime/ui/markdown.tsx(+test)`, `src/runtime/index.ts(+test)`,
  `src/runtime/generated/**` (regenerated, never hand-edited),
  `src/host/render/model/settle.ts(+test)`, `src/host/render/model/renderer.ts`,
  `src/host/render/types.ts`, `src/host/render/index.ts`,
  `src/host/session/model/host-state-machine.ts(+test)`, `src/host/session/model/entry.ts(+test)`,
  `src/infrastructure/debug-log/model/logger.ts(+test)`,
  `src/infrastructure/debug-log/index.ts`, `src/ui/app/model/render-root.tsx`,
  `package.json` + `bun.lock`, the two Gate lexer canaries, the agent authoring guide, and
  `docs/architecture/**`. **No** other module. `examples/**` is never edited (spec §9).
- **Design is a source of truth (CLAUDE.md).** Every hue this plan writes is one of the
  seventeen core roles read off `activeTokens()`. **No hex literal appears in any production
  file added by this plan.** Test fixtures may name a hue only by reading it back off
  `activeTokens()`.
- **The design does not cover syntax highlighting. This is a FLAGGED GAP, not an invention.**
  See Decision D1: the gap is stated, the mapping is derived from the design's own emphasis
  hierarchy rather than from a foreign editor theme, and the divergence is documented in the
  module's own doc comment as CLAUDE.md requires.
- **Module layout (CLAUDE.md).** `model/` holds the style builder; `ui/` holds the two
  components; `types.ts`/`index.ts` stay at each module root. No loose files at a module root.
- **Imports.** Relative inside one module (`../model/syntax-style`, `./text`); aliased across
  module boundaries (`host/render/model/renderer`, `infrastructure/debug-log`).
  `verbatimModuleSyntax: true` — every type-only import is `import type`.
  `src/runtime` may import `infrastructure/*` (the domain-free ring) and nothing else outside
  itself; it must NOT import `host/*`, `core/*`, `store/*` in production code (its *tests*
  already import `host/render/**`, which is existing, accepted practice).
- **errore.** No `throw` for expected failures. `SyntaxStyle.create()` reaches the native render
  library and can throw; it is wrapped once, at that boundary, with `errore.try` into a tagged
  error, and every consumer degrades to plain text on it. No `try`/`catch` for control flow.
- **Reatom.** Every atom, computed and action is NAMED (`RTM-S05`). The style builder is one
  `computed` over `themeTokensAtom` — a memo Reatom already owns, never a hand-rolled `Map`
  cache (`RTM-A08`'s spirit). No module-level `effect`, no timer owned by anything but the
  settle loop's own bounded `await`.
- **Declaration regeneration.** Any change to `src/runtime/index.ts`'s surface invalidates
  `src/runtime/generated/runtime-dts.ts` and `runtime.generated.d.ts`;
  `src/runtime/generated/runtime-dts.test.ts` fails on the drift. Run `bun run gen:runtime-dts`
  **before** running tests in every task that touches the facade.
- **Corpus canary.** This plan adds EIGHT `.ts`/`.tsx` files under `src/`.
  `src/gate/model/lexer.test.ts:379`'s `expect(files.length).toBe(949)` is a hard assertion and
  `src/gate/model/lexer.oracle.test.ts:556`'s test title quotes the same number. Task 8 recounts
  and bumps BOTH. Do not guess the number — run the count.
- **Test-command split (spec §11).** `src/ui` and `src/entrypoint` render tests run as SEPARATE
  `bun test` commands; a combined run produces random failures under load.
- **A crashed `bun test` is not a failure and not a pass.** `bun test` dies intermittently with
  `panic(main thread): Segmentation fault` inside `Bun.Transpiler`, and a crashed run prints no
  `(fail)` lines. Always run the suite through `bun run test` (`scripts/run-tests.ts`), which
  classifies a crash as `crashed`. Re-run once before believing a regression.
- **Commits.** One commit per task, conventional-commit subject. Use `rtk git …`. If a message
  is multi-line, write it to a scratch file and pass `-F <path>` — `rtk git commit` swallows
  heredoc stdin. `rtk git diff` compacts output and is not a valid patch; use
  `git --no-pager diff` when a diff must round-trip.

---

## Decisions made here, with their reasons

These are the choices the spec leaves to the implementation. They are settled here so no task
has to re-litigate them.

### D1 — The token-roles → syntax-capture-scopes mapping (the plan's first and heaviest decision)

**The gap, stated plainly, as CLAUDE.md requires.** The project's design system covers no code
display of any kind. `design/termcraft-engine.js` carries fifteen palette keys and a cell model
of `{ch, fg, bg, bold, blink}` — there is no `italic`, no diff colouring, no fenced-block
rendering, and no draw method for source text; none of the 27 `design/*.dc.html` screens shows
code, a diff, or a rendered markdown document. A repository-wide search of `design/` for
`syntax`, `highlight`, `keyword`, `comment`, `token`, `fence`, `drawCode`, `drawDiff` returns
nothing about code display. **So there is no per-scope design source to copy, and this plan does
not pretend there is.**

**FLAGGED FOR THE OPERATOR.** This mapping is the closest faithful reading of the design's own
vocabulary, not a design decision the design system made. If a future design pass adds a code
screen, this table is what it overrides, and `src/runtime/model/syntax-style.ts`'s doc comment
says so in place.

**The principle used instead of a borrowed editor theme.** The design's colour language is
"warm amber emphasis on a near-black neutral ramp, with green and red reserved for *status*".
The engine uses green exclusively for healthy/complete (`● live`, `✓ read current design`,
`✓ codex 0.34`) and red exclusively for failure (`✗ codex not found`). Painting strings green —
the reflex from every mainstream editor theme — would import a foreign convention AND
contradict the design's own semantics. So the mapping is built from the neutral ramp plus the
accent family, arranged along the design's existing three-step emphasis hierarchy, and it
touches a status hue exactly once, where the design's own meaning matches (a **checked** list
item is a completed thing, which is what the engine's green `✓` means everywhere).

The design's emphasis hierarchy, quoted from its own usage:

| Tier | Role | Design usage it is taken from |
| --- | --- | --- |
| emphasis | `accent` (`pal.amber`) | active/selected markers `▸`, panel titles, `❯ you`, commit hashes |
| bright emphasis | `accentHi` (`pal.amberHi`) | the highlighted item inside an emphasised set — `selFg`, the current commit's subject |
| muted accent | `accentDim` (`pal.amberDim`) | accent-family text that is not the point — `· ⠹ checking codex`, the chat gutter fold (`engine.js:620-621`) |
| content | `foreground` (`pal.fg`) | ordinary body text, the fill of every cell in `mk()` |
| secondary | `foregroundMuted` (`pal.dim`) | labels, column headers, metadata (`author`, `when`) |
| de-emphasis | `foregroundFaint` (`pal.faint`) | inactive/aside — dimmed panes, unfocused chrome |

**The mapping.** Every value is read off `activeTokens()` at build time; the `dark-default`
column is shown only so a reviewer can see what it looks like.

| Capture scope | Core role | `dark-default` | Justification |
| --- | --- | --- | --- |
| `default` | `foreground` | `#d7d0c2` | The fallback every unmatched span resolves through; the design's body ink. |
| `variable` | `foreground` | `#d7d0c2` | Ordinary content — the thing the reader is reading. |
| `property` | `foreground` | `#d7d0c2` | Same tier as `variable`; a member access is content, not structure. |
| `embedded` | `foreground` | `#d7d0c2` | Injected sub-language text is still content. |
| `keyword` | `accent` | `#e6a23c` | The design's single emphasis hue marks "the thing you are meant to notice first". In code that is the keyword. |
| `function` | `accentHi` | `#f6c163` | Bright accent = the highlighted item inside an emphasised set; a call is the emphasised element of a statement. |
| `constructor` | `accentHi` | `#f6c163` | Same family as `function`. |
| `type` | `accentHi` | `#f6c163` | Same tier — a type name is a named, emphasised reference. |
| `string` | `accentDim` | `#8a6d33` | Literal data: accent-family, deliberately *not* the point. Green is refused here — see the principle above. |
| `number` | `accentDim` | `#8a6d33` | Literal. |
| `boolean` | `accentDim` | `#8a6d33` | Literal. |
| `constant` | `accentDim` | `#8a6d33` | Literal. |
| `character` | `accentDim` | `#8a6d33` | Literal. |
| `operator` | `foregroundMuted` | `#8f877a` | One step below content — grammar, not meaning. |
| `label` | `foregroundMuted` | `#8f877a` | The design's `dim` is literally its label tier. |
| `module` | `foregroundMuted` | `#8f877a` | An import path reads as metadata, which is the `dim` tier. |
| `attribute` | `foregroundMuted` | `#8f877a` | Metadata. |
| `punctuation` | `foregroundFaint` | `#5b544a` | Code's structural chrome; the design paints box glyphs and separators in `faint`/`line`. |
| `comment` | `foregroundFaint` | `#5b544a` | The design's de-emphasis endpoint — aside text that must stay readable and stay quiet. |
| `conceal` | `foregroundFaint` | `#5b544a` | Concealed syntax markers are chrome by definition. |
| `markup` | `foreground` | `#d7d0c2` | Markdown prose body. |
| `markup.heading` and `markup.heading.1`…`.6` | `accent`, **bold** | `#e6a23c` | The engine draws every panel/box title in amber and bold (`box()`'s `titleFg` + `titleBold: true`). A heading is a title. |
| `markup.strong` | `foreground`, **bold** | `#d7d0c2` | The design expresses emphasis-within-a-hue with bold (selected rows, header rows), not with a second hue. |
| `markup.italic` | `foregroundMuted` | `#8f877a` | **DIVERGENCE, documented in file:** the design's cell model has `bold` and `blink` and no italic, so italic is outside its vocabulary. The closest faithful reading of "lighter emphasis" is the design's own secondary tier. |
| `markup.strikethrough` | `foregroundFaint` | `#5b544a` | Struck text is retired text — the de-emphasis endpoint. |
| `markup.raw` / `markup.raw.block` | `accentDim` | `#8a6d33` | Inline code and fenced text are literals; same tier as `string`. |
| `markup.link` / `markup.link.label` | `accent` | `#e6a23c` | The engine paints references in amber (commit hashes, `engine.js:409`). |
| `markup.link.url` | `foregroundMuted` | `#8f877a` | The machine half of a reference is metadata. No underline: the design's cell model has none. |
| `markup.list` | `foregroundMuted` | `#8f877a` | An unselected bullet is `dim` in the engine (`engine.js:503`: `sel ? P.amber : P.dim`). |
| `markup.list.unchecked` | `foregroundMuted` | `#8f877a` | Pending work is the `dim` tier (`· ⠹ checking codex`). |
| `markup.list.checked` | `success` | `#8fb96b` | **The one status hue used.** The engine's green `✓` means exactly "done" everywhere it appears. |
| `markup.quote` | `foregroundMuted` | `#8f877a` | Quoted aside = secondary text. |

**Deliberately NOT registered:** `spell`, `nospell`, `none`. They are spell-check/no-op markers
that tree-sitter applies to whole prose runs; registering them would repaint entire paragraphs.
Unregistered, they fall through to `default`, which is the intent.

**Why the table is bigger than the spec's "~14 base scopes".** The spec says capture-name
fallback "strips one dot level only". **That is not what the shipped implementation does**, and
the difference is load-bearing. `SyntaxStyle.getStyleId` /`getStyle`
(`node_modules/@opentui/core/chunk-bun-tkm837n2.js:2349-2395`) do:

```js
if (name.includes(".")) {
  const baseName = name.split(".")[0];   // FIRST segment, not one level up
  return this.resolveStyleId(baseName);
}
```

So `markup.heading.1` resolves to `markup`, **never** to `markup.heading`. If only the base
scopes were registered, every markdown heading would render as plain body text. The dotted
`markup.*` rows above therefore have to be registered explicitly. (One dotted lookup does work
without them: `MarkdownRenderable` asks for the literal string `"markup.heading"` for table
header cells, `index.bun.js:10080`.) This correction is recorded in the module's doc comment so
the next reader does not re-derive it from the spec's wording.

### D2 — The style is one named Reatom `computed`, not a per-render construction

`SyntaxStyle.create()` allocates a native object through `resolveRenderLib()` and has its own
`destroy()`. Building one per render would allocate one per frame. `syntaxStyleAtom` is a
`computed` over `themeTokensAtom`, so Reatom owns the memo (`RTM-A08`: never hand-roll a `Map`
cache when a Reatom primitive fits) and it is rebuilt exactly when the theme's values change.

**Accepted, stated leak:** a superseded `SyntaxStyle` is not `destroy()`ed. Stage 1 seeds the
theme once per mount and ships no switcher (spec §4.2), so a process holds at most two. The
trigger to revisit is a shell-side theme switcher; that is written into the atom's own doc
comment rather than left to be found.

### D3 — Failure degrades to plain text, through errore, never through a throw

`SyntaxStyle.create()` can throw if the native render library is unavailable. It is wrapped once
with `errore.try` into `SyntaxStyleUnavailableError`; `activeSyntaxStyle()` returns
`SyntaxStyleUnavailableError | SyntaxStyle`; and both wrappers early-return a plain `<text>`
render on the error branch after one `log.warn`. That is the spec's "the failure itself degrades
gracefully to plain text", implemented as a value rather than as an exception, and it is the
only honest shape given `syntaxStyle` is a REQUIRED prop on both OpenTUI options types
(`CodeOptions.syntaxStyle: SyntaxStyle`, `MarkdownOptions.syntaxStyle: SyntaxStyle`) — there is
no "render `<code>` without a style" branch to take.

### D4 — `console` interception is a narrow, opt-in bridge, not a global monkey-patch

`consoleMode: "disabled"` does not silence `console` — `TerminalConsoleCache.deactivate()`
restores `global.console` to the real one, so `@opentui/core`'s
`console.warn("Code highlighting failed, falling back to plain text:", error)`
(`renderables/Code.ts`, `startHighlight`'s catch) and `TreeSitterClient`'s six `console.error`
sites write to real stdout. In the live shell that corrupts the frame; in the `_host --stdio`
child, whose **stdout is the protocol pipe**, it corrupts framing.

The repository deliberately removed the old global console tee (`logger.ts`'s header). This plan
does **not** bring it back. It adds an explicitly-installed pair,
`installThirdPartyConsoleBridge()` / `uninstallThirdPartyConsoleBridge()`, called from exactly
the two places that own a byte stream, and **never installed in tests unless a test installs it**.
`emit()` gains one indirection so the bridge cannot recurse into itself: when a bridge is
installed, `log.*`'s passthrough writes to the captured pre-bridge `console` method; when none
is, it writes to `console[method]` exactly as today — which is what keeps the ~30 test files
that `spyOn(console, …)` working unchanged.

### D5 — The settle loop lives at the one render seam, and runs for EVERY mount mode

`RenderHandle.render()` (`src/host/render/model/renderer.ts:46-49`,
`renderer.intermediateRender(); await renderer.idle();`) is the only render seam in the
repository — grep finds no second `intermediateRender()`/`idle()` call site anywhere in `src/`.
`handleMount` calls it exactly once and then captures.

The spec asks for the settle loop on the export path. This plan runs it on **every** mount mode,
because the host emits exactly one frame per mount (`emitFrame` is called at
`host-state-machine.ts:294` and `:463` only): a preview frame captured before highlighting lands
would be permanently unhighlighted, with no later frame to correct it. That is a user-visible
defect, not a documented limitation, so it is fixed here rather than deferred. The loop costs
`quietFrames × pollMs` (≈16 ms) on a page with no async content, because a static frame is
already quiet on its first two comparisons.

### D6 — The loop is content-driven AND uses `highlightingDone`, and its fingerprint includes colour

Two mechanisms, in that order per pass:

1. **`highlightingDone` — the precise signal.** `CodeRenderable.highlightingDone` is a getter
   returning the promise of the most recently started highlight pass, created inside
   `renderSelf()`. `MarkdownRenderable` exposes no aggregate signal — but every one of its
   blocks, fenced *and* prose, is itself a `CodeRenderable` (`createCodeRenderable` /
   `createMarkdownCodeRenderable`). So one walk of `renderer.root` collecting
   `CodeRenderable#highlightingDone` covers `Code` and `Markdown` alike, precisely.
2. **Quiet frames — the general backstop**, for anything the walk cannot see (a highlight that
   spawns new blocks, a late worker message).

**The fingerprint MUST include `fg`/`bg`/`attrs`, not just text.** Highlighting changes only
colour. A text-only fingerprint would call the plain-text frame "quiet" on the first comparison
and return before a single hue arrived — the exact failure the spec warns about, wearing a
green test.

Defaults: `quietFrames: 2`, `budgetMs: 350`, `pollMs: 8`. `pollMs` is an `await` of real
wall-clock time; the repository uses no fake timers anywhere, and a tight loop with no yield
does not let the worker's message land.

### D7 — `web-tree-sitter` becomes a direct dependency, pinned to the peer's exact version

`@opentui/core@0.4.5` declares `"peerDependencies": { "web-tree-sitter": "0.25.10" }` — an exact
pin, not a range. `web-tree-sitter@0.25.10` is present in `node_modules` today only because the
package manager hoisted the peer. A lockfile or linker change would remove it with no build
error, and `bun build --compile` would silently produce a binary that renders every `Code` and
`Markdown` as unhighlighted plain text. It is declared directly, at the same exact version, and
a test asserts the two stay equal.

### D8 — Author-facing prop is `language`, and only five languages highlight

`Code` exposes `language?: string`, mapped onto OpenTUI's `filetype`. Only five grammars ship
(`typescript`, `javascript`, `markdown`, `markdown_inline`, `zig`); anything else resolves no
parser and renders plain, with no error and no console output (the worker's
`No parser available for filetype …` warning is read and discarded by `CodeRenderable`). The
type stays open rather than a closed union of five, because "renders plain" is a supported
outcome, and a closed union would make a correct page fail to compile.

**No grammar is ever registered at runtime.** `TreeSitterClient.addFiletypeParser()` accepts
`http(s)` sources and `DownloadUtils.downloadOrLoad()` will `fetch` them; the five bundled
grammars resolve from local asset paths only. termcraft calls `addFiletypeParser` nowhere, and
Task 6 pins that with a source-text assertion in the same style as
`index.test.ts`'s "names no private dependency identity" test.

### D9 — Both wrappers set the element's own `fg`, and set `width="100%"`

`TextBufferRenderable`'s `fg` is pushed to the native buffer as `setDefaultFg` and is what shows
through for un-highlighted spans and for the pre-highlight frame (`drawUnstyledText: true`
paints `textBuffer.setText(content)` with the default fg). Its own default is **opaque white**,
which is not in the design's palette. Both wrappers therefore set `fg={tokens.foreground}`.

`width="100%"` matches how `MarkdownRenderable` sizes the `CodeRenderable`s it creates itself
(`createCodeRenderable` passes `width: "100%"`); without it a code block's intrinsic width is
its longest line, which clips wrapped content in a column parent.

### D10 — The style builder is an INTERNAL export for P9, not a facade export

P9's `Diff` highlighting consumes `activeSyntaxStyle()` by importing
`"../model/syntax-style"` from `src/runtime/ui/diff.tsx` — the same relative shape every
wrapper uses for `activeTokens()`. It is deliberately **not** added to `src/runtime/index.ts`:
a `SyntaxStyle` is a native handle, and handing one to an authored page is exactly the
renderer-internal access §6 exists to prevent. `src/runtime/index.test.ts` asserts the facade
withholds it, next to the existing `seedThemeCapability` withholding assertion.

---

## File structure

| File | Change | Responsibility after this plan |
| --- | --- | --- |
| `src/runtime/model/syntax-style.ts` | **create** | D1's scope table, `buildSyntaxStyle`, `syntaxStyleAtom`, `activeSyntaxStyle`, `SyntaxStyleUnavailableError` |
| `src/runtime/model/syntax-style.test.ts` | **create** | Every scope maps to the role D1 fixes; theme changes rebuild; the `web-tree-sitter` pin matches the peer |
| `src/runtime/ui/code.tsx` | **create** | `Code` + `CodeProps` |
| `src/runtime/ui/code.test.tsx` | **create** | Render test + export-determinism test + the no-network pin |
| `src/runtime/ui/markdown.tsx` | **create** | `Markdown` + `MarkdownProps` |
| `src/runtime/ui/markdown.test.tsx` | **create** | Render test + export-determinism test |
| `src/runtime/index.ts` | modify | Appends `Code`/`CodeProps`, `Markdown`/`MarkdownProps` |
| `src/runtime/index.test.ts` | modify | Catalog list 13→15; withholds `activeSyntaxStyle` |
| `src/runtime/generated/*` | regenerate | Never hand-edited |
| `src/host/render/model/settle.ts` | **create** | `settleFrames`, `collectHighlightingPromises`, `frameFingerprint` |
| `src/host/render/model/settle.test.ts` | **create** | The loop's logic, against injected fakes — no renderer needed |
| `src/host/render/model/renderer.ts` | modify | `RenderHandle.settle()` wiring |
| `src/host/render/types.ts` | modify | `settle` on the interface; `FrameSettleOptions`/`FrameSettleResult` |
| `src/host/render/index.ts` | modify | Re-exports the settle surface |
| `src/host/session/model/host-state-machine.ts` | modify | `handleMount` settles before it captures |
| `src/host/session/model/host-state-machine.test.tsx` | modify | The tracked fake gains `settle` |
| `src/host/session/model/entry.ts` | modify | Installs/uninstalls the console bridge around the child's life |
| `src/infrastructure/debug-log/model/logger.ts` | modify | `installThirdPartyConsoleBridge`, `uninstallThirdPartyConsoleBridge`, the non-recursing write |
| `src/infrastructure/debug-log/model/logger.test.ts` | modify | Bridge behaviour + the spy-compat guarantee |
| `src/infrastructure/debug-log/index.ts` | modify | Exports the pair |
| `src/ui/app/model/render-root.tsx` | modify | Installs/uninstalls beside suspend/resume |
| `package.json`, `bun.lock` | modify | `web-tree-sitter` direct dependency |
| `src/gate/model/lexer.test.ts`, `lexer.oracle.test.ts` | modify | Corpus canary |
| `src/agent/prompt/model/runtime-authoring-guide.md` | modify | One "Code and Markdown" section |
| `docs/architecture/modules{,.ru}.md`, `flows/export{,.ru}.md` | modify | Catalog count, the style builder, the settle step |

---

### Task 1: The theme → `SyntaxStyle` builder

**Files:**
- Create: `src/runtime/model/syntax-style.ts`
- Create: `src/runtime/model/syntax-style.test.ts`

**Interfaces:**
- Consumes: `TokenMap` (`src/runtime/types.ts`), `themeTokensAtom`, `activeTokens`,
  `DARK_DEFAULT`, `DEFAULT_THEME_ID`, `seedThemeCapability` (`src/runtime/model/tokens.ts`),
  `computed` (`src/runtime/model/reatom.ts`), `log` (`infrastructure/debug-log`).
- Produces, all exported from `src/runtime/model/syntax-style.ts`:
  - `class SyntaxStyleUnavailableError` (errore tagged error)
  - `function syntaxScopeStyles(tokens: TokenMap): Record<string, StyleDefinitionInput>`
  - `function buildSyntaxStyle(tokens: TokenMap): SyntaxStyleUnavailableError | SyntaxStyle`
  - `const syntaxStyleAtom` — `computed<SyntaxStyleUnavailableError | SyntaxStyle>`
  - `function activeSyntaxStyle(): SyntaxStyleUnavailableError | SyntaxStyle`

- [ ] **Step 1: Write the failing test**

Create `src/runtime/model/syntax-style.test.ts`:

```ts
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { DARK_DEFAULT, DEFAULT_THEME_ID, seedThemeCapability } from "./tokens";
import { activeSyntaxStyle, buildSyntaxStyle, syntaxScopeStyles } from "./syntax-style";

/**
 * The mapping this asserts is plan P8's Decision D1 — a FLAGGED design gap, resolved from the
 * design's own emphasis hierarchy because the design system covers no code display at all.
 * If this table ever changes, D1's justification column is what has to change with it.
 */
describe("the theme → syntax-scope mapping (plan P8 D1)", () => {
  const t = DARK_DEFAULT;
  const styles = syntaxScopeStyles(t);

  test("the neutral ramp carries content, structure and asides", () => {
    expect(styles["default"]?.fg).toBe(t.foreground);
    expect(styles["variable"]?.fg).toBe(t.foreground);
    expect(styles["property"]?.fg).toBe(t.foreground);
    expect(styles["embedded"]?.fg).toBe(t.foreground);
    expect(styles["operator"]?.fg).toBe(t.foregroundMuted);
    expect(styles["label"]?.fg).toBe(t.foregroundMuted);
    expect(styles["module"]?.fg).toBe(t.foregroundMuted);
    expect(styles["attribute"]?.fg).toBe(t.foregroundMuted);
    expect(styles["punctuation"]?.fg).toBe(t.foregroundFaint);
    expect(styles["comment"]?.fg).toBe(t.foregroundFaint);
    expect(styles["conceal"]?.fg).toBe(t.foregroundFaint);
  });

  test("the accent family carries emphasis, and literals are muted accent — never green", () => {
    expect(styles["keyword"]?.fg).toBe(t.accent);
    expect(styles["function"]?.fg).toBe(t.accentHi);
    expect(styles["constructor"]?.fg).toBe(t.accentHi);
    expect(styles["type"]?.fg).toBe(t.accentHi);
    for (const literal of ["string", "number", "boolean", "constant", "character"]) {
      expect(styles[literal]?.fg).toBe(t.accentDim);
    }
    // The design reserves green for "healthy/complete" and red for failure. A string is
    // neither. This assertion is the guard against the mainstream-editor reflex.
    expect(styles["string"]?.fg).not.toBe(t.success);
  });

  test("every markdown heading LEVEL is registered, because fallback goes to the first segment", () => {
    // `SyntaxStyle.getStyleId` splits on "." and takes segment [0], so `markup.heading.1`
    // would resolve to `markup` — not to `markup.heading`. Registering the levels is the only
    // way a heading renders as a title.
    for (const scope of [
      "markup.heading",
      "markup.heading.1",
      "markup.heading.2",
      "markup.heading.3",
      "markup.heading.4",
      "markup.heading.5",
      "markup.heading.6",
    ]) {
      expect(styles[scope]?.fg).toBe(t.accent);
      expect(styles[scope]?.bold).toBe(true);
    }
  });

  test("markup inline scopes follow the design's bold-not-hue emphasis, and italic diverges", () => {
    expect(styles["markup"]?.fg).toBe(t.foreground);
    expect(styles["markup.strong"]).toEqual({ fg: t.foreground, bold: true });
    // DIVERGENCE (documented in the module): the design's cell model has bold and blink and no
    // italic, so italic is outside its vocabulary; the secondary tier is the faithful reading.
    expect(styles["markup.italic"]?.fg).toBe(t.foregroundMuted);
    expect(styles["markup.italic"]?.italic).toBeUndefined();
    expect(styles["markup.strikethrough"]?.fg).toBe(t.foregroundFaint);
    expect(styles["markup.raw"]?.fg).toBe(t.accentDim);
    expect(styles["markup.raw.block"]?.fg).toBe(t.accentDim);
    expect(styles["markup.link"]?.fg).toBe(t.accent);
    expect(styles["markup.link.label"]?.fg).toBe(t.accent);
    expect(styles["markup.link.url"]?.fg).toBe(t.foregroundMuted);
    expect(styles["markup.quote"]?.fg).toBe(t.foregroundMuted);
    expect(styles["markup.list"]?.fg).toBe(t.foregroundMuted);
    expect(styles["markup.list.unchecked"]?.fg).toBe(t.foregroundMuted);
    // The ONE status hue: the engine's green ✓ means "done" everywhere it appears.
    expect(styles["markup.list.checked"]?.fg).toBe(t.success);
  });

  test("spell markers are deliberately unregistered so they fall through to default", () => {
    expect(styles["spell"]).toBeUndefined();
    expect(styles["nospell"]).toBeUndefined();
    expect(styles["none"]).toBeUndefined();
  });

  test("no hue is invented — every registered fg is one of the active theme's own values", () => {
    const declared = new Set<string>(Object.values(t));
    for (const [scope, style] of Object.entries(styles)) {
      expect({ scope, fg: style.fg }).toEqual({ scope, fg: style.fg });
      if (style.fg !== undefined) expect(declared.has(style.fg)).toBe(true);
    }
  });

  test("the mapping follows the ACTIVE theme, not the compiled seed", () => {
    // #4cc9f0 is a synthetic test fixture, not a design colour — the same value
    // `tokens.reactivity.test.tsx` already uses for its MIDNIGHT theme.
    const midnight = { ...DARK_DEFAULT, accent: "#4cc9f0" } as const;
    expect(syntaxScopeStyles(midnight)["keyword"]?.fg).toBe("#4cc9f0");
  });
});

describe("the SyntaxStyle handle", () => {
  test("buildSyntaxStyle registers every scope in the table", () => {
    const built = buildSyntaxStyle(DARK_DEFAULT);
    if (built instanceof Error) throw built;
    const registered = new Set(built.getRegisteredNames());
    for (const scope of Object.keys(syntaxScopeStyles(DARK_DEFAULT))) {
      expect(registered.has(scope)).toBe(true);
    }
    built.destroy();
  });

  test("activeSyntaxStyle is memoised per theme and rebuilt when the theme changes", () => {
    seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
    const first = activeSyntaxStyle();
    expect(activeSyntaxStyle()).toBe(first);

    seedThemeCapability({ themeId: "midnight", tokens: { ...DARK_DEFAULT, accent: "#4cc9f0" } });
    expect(activeSyntaxStyle()).not.toBe(first);

    seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/runtime/model/syntax-style.test.ts`
Expected: FAIL — `Cannot find module './syntax-style'`.

- [ ] **Step 3: Write the builder**

Create `src/runtime/model/syntax-style.ts`:

```ts
import { SyntaxStyle } from "@opentui/core";
import type { StyleDefinitionInput } from "@opentui/core";
import * as errore from "errore";

import { log } from "infrastructure/debug-log";

import type { TokenMap } from "../types";
import { computed } from "./reatom";
import { themeTokensAtom } from "./tokens";

/**
 * The native render library could not allocate a syntax style. Every consumer degrades to
 * plain text on it (plan P8 D3) — `syntaxStyle` is a REQUIRED prop on OpenTUI's `CodeOptions`
 * and `MarkdownOptions`, so there is no "render `<code>` without a style" branch to take.
 */
export class SyntaxStyleUnavailableError extends errore.createTaggedError({
  name: "SyntaxStyleUnavailableError",
  message: "the terminal render library could not allocate a syntax style",
}) {}

/**
 * THE ROLES → SYNTAX-SCOPES MAPPING, AND THE DESIGN GAP IT ANSWERS (plan P8, Decision D1).
 *
 * FLAGGED, NOT INVENTED. termcraft's design system covers no code display: `design/`'s
 * `termcraft-engine.js` carries fifteen palette keys and a cell model of
 * `{ch, fg, bg, bold, blink}`, has no draw method for source text, diffs or fenced blocks, and
 * none of the 27 `design/*.dc.html` screens shows code. There is therefore NO per-scope design
 * source to copy, and this table does not pretend there is one. It is the closest faithful
 * reading of the design's own vocabulary, and it is what a future design pass overrides.
 *
 * THE PRINCIPLE, instead of a borrowed editor theme. The design's language is warm amber
 * emphasis over a neutral ramp, with green reserved for healthy/complete (`● live`,
 * `✓ read current design`) and red for failure (`✗ codex not found`). Painting strings green —
 * the reflex from every mainstream editor theme — would import a foreign convention AND
 * contradict the design's own semantics. So the mapping uses the neutral ramp
 * (`foreground` → `foregroundMuted` → `foregroundFaint`) and the accent family
 * (`accent` → `accentHi` → `accentDim`) along the design's existing three-step emphasis
 * hierarchy, and touches a status hue exactly once: `markup.list.checked` → `success`, where
 * the design's own green `✓` already means "done".
 *
 * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED: `markup.italic` is not italic. The
 * design's cell model has `bold` and `blink` and no italic, so italic is outside its
 * vocabulary; the faithful reading of "lighter emphasis" is the design's own secondary tier,
 * `foregroundMuted`.
 *
 * WHY THE DOTTED `markup.*` SCOPES ARE REGISTERED EXPLICITLY, and why this list is longer than
 * a base-scope list would be. `SyntaxStyle.getStyleId`/`getStyle` fall back with
 * `name.split(".")[0]` — the FIRST segment, not one level up. `markup.heading.1` therefore
 * resolves to `markup`, never to `markup.heading`. Registering only base scopes would render
 * every markdown heading as plain body text. (The design spec's wording — "strips one dot level
 * only" — describes the intent, not the shipped behaviour; the behaviour is what this follows.)
 *
 * `spell`, `nospell` and `none` are deliberately absent: tree-sitter applies them to whole
 * prose runs, so registering them would repaint entire paragraphs. Unregistered, they fall
 * through to `default`, which is the intent.
 */
export function syntaxScopeStyles(tokens: TokenMap): Record<string, StyleDefinitionInput> {
  const heading: StyleDefinitionInput = { fg: tokens.accent, bold: true };
  const literal: StyleDefinitionInput = { fg: tokens.accentDim };
  const secondary: StyleDefinitionInput = { fg: tokens.foregroundMuted };
  const aside: StyleDefinitionInput = { fg: tokens.foregroundFaint };
  const emphasised: StyleDefinitionInput = { fg: tokens.accentHi };
  const content: StyleDefinitionInput = { fg: tokens.foreground };

  return {
    // The fallback every unmatched span resolves through.
    default: content,

    // Content tier.
    variable: content,
    property: content,
    embedded: content,

    // Emphasis tier.
    keyword: { fg: tokens.accent },
    function: emphasised,
    constructor: emphasised,
    type: emphasised,

    // Literals — accent family, deliberately not the point. Never `success`.
    string: literal,
    number: literal,
    boolean: literal,
    constant: literal,
    character: literal,

    // Secondary tier: grammar and metadata.
    operator: secondary,
    label: secondary,
    module: secondary,
    attribute: secondary,

    // De-emphasis endpoint: structural chrome and asides.
    punctuation: aside,
    comment: aside,
    conceal: aside,

    // Markdown. The dotted entries are mandatory — see this function's doc comment.
    markup: content,
    "markup.heading": heading,
    "markup.heading.1": heading,
    "markup.heading.2": heading,
    "markup.heading.3": heading,
    "markup.heading.4": heading,
    "markup.heading.5": heading,
    "markup.heading.6": heading,
    "markup.strong": { fg: tokens.foreground, bold: true },
    "markup.italic": secondary,
    "markup.strikethrough": aside,
    "markup.raw": literal,
    "markup.raw.block": literal,
    "markup.link": { fg: tokens.accent },
    "markup.link.label": { fg: tokens.accent },
    "markup.link.url": secondary,
    "markup.quote": secondary,
    "markup.list": secondary,
    "markup.list.unchecked": secondary,
    "markup.list.checked": { fg: tokens.success },
  };
}

/**
 * Build one native `SyntaxStyle` from a theme's token map.
 *
 * `SyntaxStyle.create()` reaches the native render library through `resolveRenderLib()`, which
 * is an uncontrolled boundary — so it is wrapped once, HERE, with `errore.try`, and the failure
 * travels as a value (plan P8 D3). Nothing above this line ever throws.
 */
export function buildSyntaxStyle(tokens: TokenMap): SyntaxStyleUnavailableError | SyntaxStyle {
  return errore.try(
    () => SyntaxStyle.fromStyles(syntaxScopeStyles(tokens)),
    (cause) => new SyntaxStyleUnavailableError({ cause }),
  );
}

/**
 * The active theme's syntax style, memoised by Reatom.
 *
 * A `computed` rather than a hand-rolled `Map` keyed on the token object: Reatom already owns
 * exactly this memo, and it invalidates on precisely the right input (`themeTokensAtom`).
 *
 * ACCEPTED, STATED LEAK: a superseded `SyntaxStyle` is not `destroy()`ed. Stage 1 seeds the
 * theme once per mount and ships no switcher (spec §4.2), so a process holds at most two.
 * THE TRIGGER TO REVISIT: a shell-side theme switcher, at which point this needs a disconnect
 * hook that destroys the previous handle.
 */
export const syntaxStyleAtom = computed<SyntaxStyleUnavailableError | SyntaxStyle>(
  () => buildSyntaxStyle(themeTokensAtom()),
  "runtime.syntaxStyle",
);

/**
 * A catalog component's read of the active syntax style — the same current-value (untracked)
 * shape `activeTokens()` uses, for the same stage-1 reason recorded there.
 *
 * INTERNAL, and not on the `@termcraft/runtime` facade (plan P8 D10): a `SyntaxStyle` is a
 * native handle, and handing one to an authored page is the renderer-internal access the
 * wrapper layer exists to prevent. Plan P9's `Diff` consumes it the same way this module's
 * siblings consume `activeTokens()` — `import { activeSyntaxStyle } from "../model/syntax-style"`.
 */
export function activeSyntaxStyle(): SyntaxStyleUnavailableError | SyntaxStyle {
  const style = syntaxStyleAtom();
  if (style instanceof Error) {
    log.warn(
      "runtime/syntax-style: no syntax style could be allocated; code and markdown render as " +
        "plain text:",
      style.message,
    );
  }
  return style;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/runtime/model/syntax-style.test.ts`
Expected: PASS.

**If `buildSyntaxStyle` fails in a plain unit test** because `resolveRenderLib()` needs a
renderer to exist first: that is a real finding, not a reason to weaken the test. Move the two
`describe("the SyntaxStyle handle")` tests into `src/runtime/ui/code.test.tsx`, where a
headless renderer is already created in `beforeEach`, and leave the pure
`syntaxScopeStyles` tests here. Record the reason in a comment at the moved tests.

- [ ] **Step 5: Typecheck, lint, format**

Run: `bun x tsc --noEmit && bun run lint && bun run fmt:check`
Expected: all silent.

- [ ] **Step 6: Commit**

```bash
rtk git add src/runtime/model/syntax-style.ts src/runtime/model/syntax-style.test.ts
rtk git commit -m "feat(runtime): build the syntax style from the active theme's tokens"
```

---

### Task 2: `web-tree-sitter` as a direct dependency

**Files:**
- Modify: `package.json` (the `dependencies` block)
- Modify: `bun.lock` (regenerated by the install)
- Modify: `src/runtime/model/syntax-style.test.ts` (append one describe)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. The deliverable is that `web-tree-sitter@0.25.10` is a
  first-class dependency and a test fails if it drifts from `@opentui/core`'s peer pin.

- [ ] **Step 1: Write the failing test**

Append to `src/runtime/model/syntax-style.test.ts`:

```ts
describe("the tree-sitter runtime dependency (plan P8 D7)", () => {
  test("web-tree-sitter is a DIRECT dependency pinned to @opentui/core's peer version", async () => {
    // WHY THIS IS ASSERTED AT ALL. Highlighting runs through @opentui/core's worker, which
    // imports `web-tree-sitter` and loads its wasm through `import.meta.resolve`. Today the
    // package resolves only because the package manager HOISTED @opentui/core's peer. A
    // lockfile or linker change would remove it with no build error, and `bun build --compile`
    // would silently ship a binary that renders every Code and Markdown as plain text.
    // `import.meta.dir` + node:path, never `new URL(...).pathname` — the latter yields `/C:/…`
    // on Windows and no file opens.
    const root = path.resolve(import.meta.dir, "../../..");
    const ours = (await Bun.file(path.join(root, "package.json")).json()) as {
      dependencies: Record<string, string>;
    };
    const core = (await Bun.file(
      path.join(root, "node_modules/@opentui/core/package.json"),
    ).json()) as { peerDependencies: Record<string, string> };

    expect(ours.dependencies["web-tree-sitter"]).toBeDefined();
    expect(ours.dependencies["web-tree-sitter"]).toBe(
      core.peerDependencies["web-tree-sitter"] as string,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/runtime/model/syntax-style.test.ts`
Expected: FAIL — `expect(received).toBeDefined()` with `received: undefined`.

- [ ] **Step 3: Declare the dependency**

In `package.json`'s `dependencies`, insert in alphabetical position (after `"react"`, before
`"typescript"` — the block is alphabetically ordered today):

```json
    "web-tree-sitter": "0.25.10",
```

The value is the EXACT version, not `^0.25.10`: `@opentui/core@0.4.5` pins its peer exactly, and
a caret here could float to a version the peer refuses.

- [ ] **Step 4: Install and verify the lockfile moved**

```bash
rtk bun install
git --no-pager diff --stat bun.lock package.json
```
Expected: both files changed; `bun.lock` now lists `web-tree-sitter` under the root package's
own dependencies, not only as a peer.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/runtime/model/syntax-style.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove nothing else moved**

Run: `bun x tsc --noEmit && bun test src/runtime`
Expected: silent, and the runtime suite green.

- [ ] **Step 7: Commit**

```bash
rtk git add package.json bun.lock src/runtime/model/syntax-style.test.ts
rtk git commit -m "build: declare web-tree-sitter directly at @opentui/core's peer version"
```

---

### Task 3: The third-party console bridge

**Files:**
- Modify: `src/infrastructure/debug-log/model/logger.ts`
- Modify: `src/infrastructure/debug-log/model/logger.test.ts`
- Modify: `src/infrastructure/debug-log/index.ts`
- Modify: `src/host/session/model/entry.ts`
- Modify: `src/ui/app/model/render-root.tsx`

**Interfaces:**
- Consumes: the existing `emit`/`passthrough`/`hold` machinery inside `logger.ts`.
- Produces, exported from `infrastructure/debug-log`:
  - `function installThirdPartyConsoleBridge(): void` — idempotent
  - `function uninstallThirdPartyConsoleBridge(): void` — idempotent, restores the exact
    functions captured at install

- [ ] **Step 1: Write the failing test**

Append to `src/infrastructure/debug-log/model/logger.test.ts`:

```ts
describe("the third-party console bridge (plan P8 D4)", () => {
  test("a third-party console.warn goes through log.* once installed, and is restored on uninstall", () => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      installThirdPartyConsoleBridge();
      // A dependency's own call — this is exactly the shape @opentui/core's
      // `console.warn("Code highlighting failed, falling back to plain text:", error)` has.
      console.warn("Code highlighting failed", "boom");
      expect(seen).toEqual(["Code highlighting failed boom"]);

      uninstallThirdPartyConsoleBridge();
      console.warn("after");
      expect(seen).toEqual(["Code highlighting failed boom", "after"]);
    } finally {
      uninstallThirdPartyConsoleBridge();
      console.warn = original;
    }
  });

  test("installing twice is idempotent and does not chain the bridge onto itself", () => {
    const seen: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      installThirdPartyConsoleBridge();
      installThirdPartyConsoleBridge();
      console.error("x");
      // Exactly once — a chained bridge would double every line and, worse, could recurse.
      expect(seen).toEqual(["x"]);
    } finally {
      uninstallThirdPartyConsoleBridge();
      console.error = original;
    }
  });

  test("with NO bridge installed, log.* still reaches whatever console.warn currently is", () => {
    // The compatibility guarantee that keeps the ~30 test files which spyOn(console, …) green:
    // the indirection added for the bridge must be inert when no bridge is installed.
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      log.warn("plain");
      expect(seen).toEqual(["plain"]);
    } finally {
      console.warn = original;
    }
  });

  test("while the terminal is held, a bridged line never reaches the writer", () => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      installThirdPartyConsoleBridge();
      suspendConsolePassthrough();
      console.warn("would corrupt the frame");
      expect(seen).toEqual([]);
      resumeConsolePassthrough();
      // Held, then flushed — never dropped.
      expect(seen).toEqual(["would corrupt the frame"]);
    } finally {
      resumeConsolePassthrough();
      uninstallThirdPartyConsoleBridge();
      console.warn = original;
    }
  });
});
```

Add `installThirdPartyConsoleBridge`, `uninstallThirdPartyConsoleBridge` to that file's existing
import from `./logger` (and `suspendConsolePassthrough`/`resumeConsolePassthrough`/`log` if they
are not already imported there).

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/infrastructure/debug-log`
Expected: FAIL — `installThirdPartyConsoleBridge is not a function`.

- [ ] **Step 3: Implement the bridge in `logger.ts`**

Below `MAX_HELD_LINES`'s declarations and above `suspendConsolePassthrough`, add:

```ts
/**
 * The pre-bridge `console` methods, captured at install time.
 *
 * WHY AN INDIRECTION AT ALL. `installThirdPartyConsoleBridge` replaces `console.warn` with a
 * call into `emit`, and `emit`'s passthrough branch writes to `console`. Without this capture
 * that is an infinite loop. With it, a bridged passthrough writes to the function the bridge
 * replaced, and an UNBRIDGED passthrough still writes to whatever `console[method]` currently
 * is — which is what keeps every test that `spyOn(console, …)` working exactly as before.
 */
let bridged: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> | null = null;

const CONSOLE_METHODS: readonly ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

function writeThrough(method: ConsoleMethod, args: readonly unknown[]): void {
  const captured = bridged?.[method];
  if (captured !== undefined) {
    captured(...args);
    return;
  }
  console[method](...args);
}

/**
 * Route a DEPENDENCY's own `console.*` calls into `log.*`.
 *
 * WHY THIS EXISTS. `@opentui/core` reports highlight failures with
 * `console.warn("Code highlighting failed, falling back to plain text:", error)` and its
 * `TreeSitterClient` reports worker/init failures with `console.error`. Under
 * `consoleMode: "disabled"` OpenTUI does not silence those — `TerminalConsoleCache.deactivate()`
 * RESTORES the real console — so they write to real stdout. In the interactive shell that
 * corrupts the frame; in the `_host --stdio` child, whose stdout IS the protocol pipe, it
 * corrupts framing. termcraft's own call sites already report through `log.*`; this closes the
 * one hole left, for code termcraft does not own.
 *
 * DELIBERATELY NOT THE OLD GLOBAL TEE. This is installed by the two processes that own a byte
 * stream and by nothing else, it is uninstalled when they hand the stream back, and it is never
 * installed under `bun test` unless a test installs it. Idempotent by identity: a second call
 * while installed is a no-op, so the bridge can never chain onto itself.
 */
export function installThirdPartyConsoleBridge(): void {
  if (bridged !== null) return;
  const captured: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
  for (const method of CONSOLE_METHODS) {
    captured[method] = console[method].bind(console) as (...args: unknown[]) => void;
  }
  bridged = captured;
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => emit(method, defaultSink, args);
  }
}

/** Hand `console` back exactly as it was at install. Idempotent, and safe when never installed. */
export function uninstallThirdPartyConsoleBridge(): void {
  const captured = bridged;
  if (captured === null) return;
  bridged = null;
  for (const method of CONSOLE_METHODS) {
    const original = captured[method];
    if (original !== undefined) console[method] = original;
  }
}
```

Then replace the two direct writer calls so they go through `writeThrough`:

- in `flushHeld`, `console.error(...)` for the dropped-line notice becomes
  `writeThrough("error", [ ... ])`, and `for (const line of lines) console[line.method](...line.args);`
  becomes `for (const line of lines) writeThrough(line.method, line.args);`
- in `emit`, `console[method](...args);` becomes `writeThrough(method, args);`

- [ ] **Step 4: Export the pair**

`src/infrastructure/debug-log/index.ts` — replace the first export line with:

```ts
export {
  createLogger,
  installThirdPartyConsoleBridge,
  log,
  resumeConsolePassthrough,
  suspendConsolePassthrough,
  uninstallThirdPartyConsoleBridge,
} from "./model/logger";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/infrastructure/debug-log`
Expected: PASS.

- [ ] **Step 6: Install it in the `_host --stdio` child**

`src/host/session/model/entry.ts` — add to the existing `infrastructure/debug-log` import (or
create it) `installThirdPartyConsoleBridge, uninstallThirdPartyConsoleBridge`, then inside
`runHostStdio`, immediately after `registerRuntimeResolver();`:

```ts
  // THIS CHILD'S STDOUT IS THE PROTOCOL PIPE. A dependency writing a diagnostic to it — and
  // `@opentui/core` writes one on every highlight failure — does not garble a picture, it
  // corrupts framing and kills the incarnation. The renderer runs with `consoleMode: "disabled"`,
  // which RESTORES the real console rather than silencing it, so this bridge is the only thing
  // standing between a tree-sitter warning and a broken session.
  installThirdPartyConsoleBridge();
```

and inside `performExit`, immediately after `liveRenderer = null;`:

```ts
    uninstallThirdPartyConsoleBridge();
```

- [ ] **Step 7: Install it in the interactive shell**

`src/ui/app/model/render-root.tsx` — add the two names to the existing
`infrastructure/debug-log` import; call `installThirdPartyConsoleBridge();` on the line
immediately BEFORE the existing `suspendConsolePassthrough();` (line ~102), and
`uninstallThirdPartyConsoleBridge();` immediately AFTER each of the four existing
`resumeConsolePassthrough();` calls (lines ~107, ~119, ~129, ~146). Install before suspend and
uninstall after resume so the window the bridge covers always contains the window the terminal
is held for.

- [ ] **Step 8: Run the affected suites**

```bash
bun test src/infrastructure/debug-log src/host/session
bun test src/ui/app
```
Expected: both green. Run them as separate commands — `src/ui` render tests must not share a
command with anything else (spec §11).

- [ ] **Step 9: Typecheck, lint, format, commit**

```bash
bun x tsc --noEmit && bun run lint && bun run fmt:check
rtk git add src/infrastructure/debug-log src/host/session/model/entry.ts src/ui/app/model/render-root.tsx
rtk git commit -m "fix(debug-log): route dependency console diagnostics off stdout"
```

---

### Task 4: The quiet-frames settle loop

**Files:**
- Create: `src/host/render/model/settle.ts`
- Create: `src/host/render/model/settle.test.ts`
- Modify: `src/host/render/types.ts`
- Modify: `src/host/render/model/renderer.ts`
- Modify: `src/host/render/index.ts`
- Modify: `src/host/session/model/host-state-machine.test.tsx` (the one fake `RenderHandle`)

**Interfaces:**
- Consumes: `CapturedFrame`, `RenderHandle` (`src/host/render/types.ts`); `Renderable`,
  `CodeRenderable` (`@opentui/core`).
- Produces:
  - `src/host/render/types.ts`: `interface FrameSettleOptions { readonly quietFrames?: number; readonly budgetMs?: number; readonly pollMs?: number }`,
    `interface FrameSettleResult { readonly settled: boolean; readonly passes: number; readonly elapsedMs: number }`,
    and `settle(options?: FrameSettleOptions): Promise<FrameSettleResult>` on `RenderHandle`.
  - `src/host/render/model/settle.ts`: `DEFAULT_FRAME_SETTLE`, `frameFingerprint(frame: CapturedFrame): string`,
    `collectHighlightingPromises(root: Renderable): readonly Promise<void>[]`,
    `settleFrames(input: SettleDriver): Promise<FrameSettleResult>` where
    `interface SettleDriver { readonly render: () => Promise<void>; readonly snapshot: () => string; readonly pending: () => readonly Promise<void>[]; readonly now: () => number; readonly sleep: (ms: number) => Promise<void>; readonly options?: FrameSettleOptions }`.

- [ ] **Step 1: Write the failing test**

Create `src/host/render/model/settle.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { StyledRun } from "../../protocol";
import { DEFAULT_FRAME_SETTLE, frameFingerprint, settleFrames } from "./settle";

const run = (text: string, fg: string): StyledRun => ({ text, fg, bg: "#000000", attrs: 0 });
const frame = (runs: StyledRun[]) => ({ width: runs.length, height: 1, rows: [runs] });

/** A driver whose snapshots are handed to it, so the loop's logic is testable with no renderer. */
function createDriver(snapshots: readonly string[], pending: readonly Promise<void>[] = []) {
  let index = 0;
  let clock = 0;
  const passes: number[] = [];
  return {
    passes,
    driver: {
      render: async () => {
        passes.push(index);
      },
      snapshot: () => snapshots[Math.min(index++, snapshots.length - 1)] ?? "",
      pending: () => pending,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
  };
}

describe("frameFingerprint", () => {
  test("a colour-only change moves the fingerprint", () => {
    // THE ASSERTION THIS WHOLE MECHANISM RESTS ON. Highlighting changes ONLY colour. A
    // text-only fingerprint would call the plain-text frame 'quiet' on its first comparison
    // and return before a single hue arrived — the export hazard wearing a green test.
    const plain = frameFingerprint(frame([run("const", "#d7d0c2")]));
    const highlighted = frameFingerprint(frame([run("const", "#e6a23c")]));
    expect(plain).not.toBe(highlighted);
  });

  test("identical rows fingerprint identically", () => {
    expect(frameFingerprint(frame([run("a", "#111111")]))).toBe(
      frameFingerprint(frame([run("a", "#111111")])),
    );
  });
});

describe("settleFrames", () => {
  test("a frame that never changes settles after quietFrames comparisons", async () => {
    const { driver } = createDriver(["A", "A", "A", "A", "A"]);
    const result = await settleFrames(driver);
    expect(result.settled).toBe(true);
    expect(result.passes).toBe(DEFAULT_FRAME_SETTLE.quietFrames);
  });

  test("a frame that changes late still settles on the SETTLED content", async () => {
    // plain, plain, HIGHLIGHTED, highlighted, highlighted…
    const { driver } = createDriver(["A", "A", "B", "B", "B", "B"]);
    const result = await settleFrames(driver);
    expect(result.settled).toBe(true);
    // It must not have stopped at the first quiet pair — that pair was the PLAIN frame.
    expect(result.passes).toBeGreaterThan(DEFAULT_FRAME_SETTLE.quietFrames);
  });

  test("a frame that never stops changing gives up at the budget and says so", async () => {
    const forever = Array.from({ length: 500 }, (_value, index) => String(index));
    const { driver } = createDriver(forever);
    const result = await settleFrames(driver);
    expect(result.settled).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(DEFAULT_FRAME_SETTLE.budgetMs);
  });

  test("a pending highlight promise is awaited before the first comparison", async () => {
    let resolved = false;
    const pending = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        resolved = true;
        resolve();
      });
    });
    const { driver } = createDriver(["A", "A", "A"], [pending]);
    await settleFrames(driver);
    expect(resolved).toBe(true);
  });

  test("a pending promise that never resolves cannot outlast the budget", async () => {
    const never = new Promise<void>(() => {});
    const { driver } = createDriver(["A", "A", "A"], [never]);
    const result = await settleFrames(driver);
    // It settles on content even though the promise is still open — the promise is an
    // accelerator, never a gate.
    expect(result.settled).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/host/render/model/settle.test.ts`
Expected: FAIL — `Cannot find module './settle'`.

- [ ] **Step 3: Write the settle module**

Create `src/host/render/model/settle.ts`:

```ts
import { CodeRenderable } from "@opentui/core";
import type { Renderable } from "@opentui/core";

import type { CapturedFrame, FrameSettleOptions, FrameSettleResult } from "../types";

/**
 * WHY A SETTLE LOOP EXISTS AT ALL (design spec §6.1/§6.3).
 *
 * `RenderHandle.render()` — `renderer.intermediateRender(); await renderer.idle();` — is the
 * ONLY render seam in this repository, and `handleMount` calls it once and captures. Syntax
 * highlighting is asynchronous: it runs in `@opentui/core`'s tree-sitter WORKER, so a single
 * pass plus `idle()` snapshots the frame BEFORE any hue arrives. Because the host emits exactly
 * one frame per mount, that unhighlighted frame is not a transient — it is the frame, forever.
 *
 * Two mechanisms, in this order per pass, because neither alone is enough:
 *   1. `CodeRenderable.highlightingDone` — the PRECISE signal, and it covers `Markdown` too:
 *      every markdown block, fenced and prose alike, is itself a `CodeRenderable`.
 *   2. quiet frames — the general backstop for anything the walk cannot see (a highlight that
 *      spawns new blocks; a late worker message).
 *
 * The loop YIELDS REAL WALL-CLOCK TIME between passes. A tight loop with no yield does not let
 * the worker's message land, and this repository uses no fake timers anywhere.
 */
export const DEFAULT_FRAME_SETTLE = {
  /** Consecutive identical frames that end the loop. Two is the smallest number that can tell
   *  "nothing is happening" from "one pass happened to look the same". */
  quietFrames: 2,
  /** Wall-clock ceiling. ~350 ms is the design spec's budget for a small document. */
  budgetMs: 350,
  /** The yield between passes. Small enough that a static page costs ~16 ms in total. */
  pollMs: 8,
} as const satisfies Required<FrameSettleOptions>;

/** Everything the loop needs, injected so its logic is testable with no renderer and no clock. */
export interface SettleDriver {
  readonly render: () => Promise<void>;
  readonly snapshot: () => string;
  readonly pending: () => readonly Promise<void>[];
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly options?: FrameSettleOptions;
}

/**
 * A frame's identity for "did anything change".
 *
 * INCLUDES COLOUR AND ATTRIBUTES, NOT ONLY TEXT — this is the load-bearing detail. Highlighting
 * changes only colour, so a text-only fingerprint would report the plain-text frame as quiet on
 * its very first comparison and the loop would return before a single hue arrived.
 */
export function frameFingerprint(frame: CapturedFrame): string {
  return frame.rows
    .map((row) => row.map((run) => `${run.text}${run.fg}${run.bg}${run.attrs}`).join(""))
    .join("");
}

/**
 * Every in-flight highlight promise reachable from a mounted tree.
 *
 * `MarkdownRenderable` exposes no aggregate completion signal, but it builds every block —
 * fenced code AND prose — as a `CodeRenderable`, so this one walk is precise for both wrappers.
 * The promise is re-read on every pass because `CodeRenderable` reassigns it inside `renderSelf`
 * each time highlights go dirty.
 */
export function collectHighlightingPromises(root: Renderable): readonly Promise<void>[] {
  const found: Promise<void>[] = [];
  const visit = (node: Renderable): void => {
    if (node instanceof CodeRenderable) found.push(node.highlightingDone);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

/** Render until the frame stops changing, or until the budget runs out. Never throws. */
export async function settleFrames(input: SettleDriver): Promise<FrameSettleResult> {
  const quietFrames = input.options?.quietFrames ?? DEFAULT_FRAME_SETTLE.quietFrames;
  const budgetMs = input.options?.budgetMs ?? DEFAULT_FRAME_SETTLE.budgetMs;
  const pollMs = input.options?.pollMs ?? DEFAULT_FRAME_SETTLE.pollMs;

  const started = input.now();
  await input.render();
  let last = input.snapshot();
  let quiet = 0;
  let passes = 0;

  while (input.now() - started < budgetMs) {
    // The highlight promises ACCELERATE the loop; they never gate it. A worker that dies leaves
    // a promise open forever, so the race is against ONE poll interval — never against the whole
    // remaining budget, which would spend the entire budget on the first pass. The `while`
    // condition is what bounds the total.
    await Promise.race([Promise.all(input.pending()), input.sleep(pollMs)]);
    await input.render();
    passes += 1;
    const next = input.snapshot();
    if (next === last) {
      quiet += 1;
      if (quiet >= quietFrames) {
        return { settled: true, passes, elapsedMs: input.now() - started };
      }
    } else {
      quiet = 0;
      last = next;
    }
    // The SECOND yield, and the one that matters. When `Promise.all(pending())` wins the race
    // above it resolves on a microtask, so no wall-clock time passed and the worker's next
    // message never got a chance to land. This one always spends real time.
    await input.sleep(pollMs);
  }

  return { settled: false, passes, elapsedMs: input.now() - started };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/host/render/model/settle.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the types and the handle method**

`src/host/render/types.ts` — add above `RenderHandle`:

```ts
/** How long, and how still, {@link RenderHandle.settle} waits. See `model/settle.ts`. */
export interface FrameSettleOptions {
  readonly quietFrames?: number;
  readonly budgetMs?: number;
  readonly pollMs?: number;
}

/** What one settle actually did. `settled: false` means the budget ran out with the frame still
 *  moving — a caller that needs a deterministic snapshot must treat that as a diagnostic. */
export interface FrameSettleResult {
  readonly settled: boolean;
  readonly passes: number;
  readonly elapsedMs: number;
}
```

and inside `RenderHandle`, immediately after `render()`:

```ts
  /**
   * Render until the frame stops changing, or until the budget runs out.
   *
   * `render()` is ONE pass; syntax highlighting runs in a worker and lands after it, so a
   * `render()` + `capture()` pair snapshots the unhighlighted frame. Anything that needs the
   * finished frame — every export, and every mount, because the host emits one frame per
   * mount — must call this instead. See `model/settle.ts` for the mechanism.
   */
  settle(options?: FrameSettleOptions): Promise<FrameSettleResult>;
```

`src/host/render/model/renderer.ts` — import the settle surface and add the method to the
returned handle, immediately after `render()`:

```ts
    async settle(options) {
      return settleFrames({
        render: async () => {
          renderer.intermediateRender();
          await renderer.idle();
        },
        snapshot: () =>
          frameFingerprint({
            width: renderer.currentRenderBuffer.width,
            height: renderer.currentRenderBuffer.height,
            rows: styledRowsFromSpanLines(renderer.currentRenderBuffer.getSpanLines()),
          }),
        pending: () => collectHighlightingPromises(renderer.root),
        now: () => Date.now(),
        sleep: (ms) => Bun.sleep(ms),
        options,
      });
    },
```

`src/host/render/index.ts` — append:

```ts
export { DEFAULT_FRAME_SETTLE, collectHighlightingPromises, frameFingerprint, settleFrames } from "./model/settle";
export type { SettleDriver } from "./model/settle";
```

and add `FrameSettleOptions`, `FrameSettleResult` to the existing `export type { … } from "./types"` line.

- [ ] **Step 6: Confirm the one fake `RenderHandle` needs no change**

`src/host/session/model/host-state-machine.test.tsx`'s `trackingRendererFactory` builds its
handle as `const tracked: RenderHandle = { ...real, mount(…), resize(…), renderError() }` — it
SPREADS the real handle, so `settle` arrives with the spread and nothing has to be added. Run
`bun x tsc --noEmit` to confirm; only if it reports a missing `settle` somewhere does a fake need
one, and then it delegates to the real handle rather than faking a result.

- [ ] **Step 7: Verify**

```bash
bun x tsc --noEmit && bun run lint && bun run fmt:check
bun test src/host
```
Expected: silent, and the host suite green.

- [ ] **Step 8: Commit**

```bash
rtk git add src/host/render src/host/session/model/host-state-machine.test.tsx
rtk git commit -m "feat(host): add a quiet-frames settle pass to the render handle"
```

---

### Task 5: `handleMount` settles before it captures

**Files:**
- Modify: `src/host/session/model/host-state-machine.ts:236-245`
- Modify: `src/host/session/model/host-state-machine.test.tsx`

**Interfaces:**
- Consumes: `RenderHandle.settle` (Task 4), `log` (`infrastructure/debug-log`).
- Produces: no new exported name. `handleMount` calls `settle()` instead of `render()`.

- [ ] **Step 1: Write the failing test**

Append to `src/host/session/model/host-state-machine.test.tsx`, inside the existing
`describe("host session — mount")`. It uses that file's own `handshaken` / `mountEnvelope`
helpers and its `liveRenderer` teardown variable — do not introduce a new harness:

```tsx
  test("a mount SETTLES the frame instead of taking one pass (design §6.1/§6.3)", async () => {
    const calls: string[] = [];
    const { h, session } = await handshaken({
      createRenderer: async (size) => {
        const real = await createHeadlessRenderer(size);
        liveRenderer = real;
        return {
          ...real,
          render: async () => {
            calls.push("render");
            await real.render();
          },
          settle: async (options) => {
            calls.push("settle");
            return real.settle(options);
          },
        };
      },
    });
    await session.receiveControlPayload(mountEnvelope());

    // A single `render()` is exactly the shape that snapshots an unhighlighted Code/Markdown
    // frame. The host emits ONE frame per mount, so that frame would never be corrected.
    expect(calls).toEqual(["settle"]);
    // And the mount still produced its ready + frame pair.
    expect(h.out).toHaveLength(2);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/host/session/model/host-state-machine.test.tsx`
Expected: FAIL — `expected ["settle"] but received ["render"]`.

- [ ] **Step 3: Make `handleMount` settle**

`src/host/session/model/host-state-machine.ts` — replace `await handle.render();` (line 237)
with:

```ts
    // SETTLE, NOT ONE PASS (design §6.1/§6.3). Highlighting is asynchronous — it runs in
    // @opentui/core's tree-sitter worker — and this handler emits exactly ONE frame per mount
    // (`emitFrame` below is the only frame this mount will ever produce). A single
    // `render()` here therefore does not snapshot an early frame that a later one corrects; it
    // snapshots the unhighlighted frame permanently, in preview exactly as in export.
    const settled = await handle.settle();
    if (!settled.settled) {
      // NOT a failure: a page whose content genuinely never stops moving still deserves a
      // frame. It IS a determinism diagnostic — an export whose frame was still changing when
      // the budget ran out is an export that may not reproduce.
      log.warn(
        `host-session: frame did not settle within the budget (mode ${request.mode}, ` +
          `${settled.passes} passes, ${settled.elapsedMs}ms) — the captured frame may not be final`,
      );
    }
```

Add `import { log } from "infrastructure/debug-log";` to the file's import block if it is not
already there.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/host/session`
Expected: PASS.

- [ ] **Step 5: Prove the real end-to-end path still renders identically**

Run: `bun test src/host`
Expected: green, including `src/host/render/model/determinism.test.ts` (it spawns real `_host`
processes; allow it the full 45 s). If it reports a crash rather than a failure, re-run once —
`scripts/run-tests.ts` documents the intermittent `Bun.Transpiler` panic.

- [ ] **Step 6: Typecheck, lint, format, commit**

```bash
bun x tsc --noEmit && bun run lint && bun run fmt:check
rtk git add src/host/session
rtk git commit -m "fix(host): settle the frame before sealing a mount's capture"
```

---

### Task 6: The `Code` wrapper

**Files:**
- Create: `src/runtime/ui/code.tsx`
- Create: `src/runtime/ui/code.test.tsx`
- Modify: `src/runtime/index.ts`
- Modify: `src/runtime/index.test.ts`
- Regenerate: `src/runtime/generated/*`

**Interfaces:**
- Consumes: `activeTokens` (`../model/tokens`), `activeSyntaxStyle` (`../model/syntax-style`,
  Task 1), `Text` (`./text`), `log` (`infrastructure/debug-log`),
  `RenderHandle.settle` (Task 4).
- Produces: `interface CodeProps { readonly id: string; readonly content: string; readonly language?: string }`
  and `function Code(props: CodeProps): React.ReactNode`, both exported from
  `src/runtime/ui/code.tsx` and re-exported from `src/runtime/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/runtime/ui/code.test.tsx`:

```tsx
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { DARK_DEFAULT, DEFAULT_THEME_ID, activeTokens, seedThemeCapability } from "../model/tokens";
import { Code } from "./code";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const allText = (frame: { rows: StyledRun[][] }) =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");
const hueOf = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame)
    .filter((run) => run.text.includes(needle))
    .map((run) => extractRgb(run.fg));

const TS_SOURCE = 'const answer = 42\n// why\nfunction go() { return "x" }\n';

describe("Code component (design-system §6.1)", () => {
  test("renders its content", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Code id="snippet" content={TS_SOURCE} language="typescript" />);
    await handle.settle();
    expect(allText(handle.capture())).toContain("const answer");
  });

  test("highlights TypeScript with the ACTIVE theme's hues (plan P8 D1)", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Code id="snippet" content={TS_SOURCE} language="typescript" />);
    await handle.settle();
    const frame = handle.capture();
    const t = activeTokens();
    // `const` is a keyword → the design's emphasis hue.
    expect(hueOf(frame, "const")).toContain(t.accent);
    // `42` is a literal → muted accent, never green.
    expect(hueOf(frame, "42")).toContain(t.accentDim);
    // The comment is the de-emphasis endpoint.
    expect(hueOf(frame, "why")).toContain(t.foregroundFaint);
  });

  test("A SILENTLY FAILED WORKER MUST FAIL THIS TEST, not degrade quietly", async () => {
    // The whole point of §6.3's rule: unhighlighted output is indistinguishable from correct
    // plain text unless a test asserts that a hue OTHER than the base foreground is present.
    const handle = await createHeadlessRenderer({ w: 40, h: 6 });
    open = handle;
    handle.mount(<Code id="snippet" content={TS_SOURCE} language="typescript" />);
    await handle.settle();
    const hues = new Set(allRuns(handle.capture()).map((run) => extractRgb(run.fg)));
    expect(hues.size).toBeGreaterThan(1);
  });

  test("an unsupported language renders plain in the theme's foreground", async () => {
    // Only five grammars ship. Anything else resolves no parser and renders plain — no error,
    // no console output. That is a supported outcome, not a failure.
    const handle = await createHeadlessRenderer({ w: 40, h: 3 });
    open = handle;
    handle.mount(<Code id="snippet" content="fn main() {}" language="rust" />);
    await handle.settle();
    const frame = handle.capture();
    expect(allText(frame)).toContain("fn main()");
    const hues = new Set(
      allRuns(frame)
        .filter((run) => run.text.trim().length > 0)
        .map((run) => extractRgb(run.fg)),
    );
    expect([...hues]).toEqual([activeTokens().foreground]);
  });

  test("with no language it renders plain in the theme's foreground", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 3 });
    open = handle;
    handle.mount(<Code id="snippet" content="plain text" />);
    await handle.settle();
    const frame = handle.capture();
    expect(allText(frame)).toContain("plain text");
    const hues = new Set(
      allRuns(frame)
        .filter((run) => run.text.trim().length > 0)
        .map((run) => extractRgb(run.fg)),
    );
    expect([...hues]).toEqual([activeTokens().foreground]);
  });

  test("the highlight follows the ACTIVE theme, not the compiled seed", async () => {
    // #4cc9f0 is a synthetic test fixture, not a design colour.
    seedThemeCapability({ themeId: "midnight", tokens: { ...DARK_DEFAULT, accent: "#4cc9f0" } });
    const handle = await createHeadlessRenderer({ w: 40, h: 3 });
    open = handle;
    handle.mount(<Code id="snippet" content="const a = 1" language="typescript" />);
    await handle.settle();
    expect(hueOf(handle.capture(), "const")).toContain("#4cc9f0");
  });

  test("a token NAME is not a Color and the renderer internals are not props", () => {
    // @ts-expect-error — `syntaxStyle` is never exposed; termcraft builds it from the theme.
    const withStyle = <Code id="x" content="" syntaxStyle={undefined} />;
    // @ts-expect-error — `treeSitterClient` is never exposed (design spec §6, §6.1).
    const withClient = <Code id="y" content="" treeSitterClient={undefined} />;
    // @ts-expect-error — `id` is mandatory on every wrapper.
    const withoutId = <Code content="" />;
    expect([withStyle, withClient, withoutId]).toHaveLength(3);
  });
});

describe("Code export determinism (design-system §6.3)", () => {
  test("two settled renders of the same source produce byte-identical styled rows", async () => {
    const first = await createHeadlessRenderer({ w: 40, h: 6 });
    first.mount(<Code id="snippet" content={TS_SOURCE} language="typescript" />);
    await first.settle();
    const a = first.capture();
    first.destroy();

    const second = await createHeadlessRenderer({ w: 40, h: 6 });
    second.mount(<Code id="snippet" content={TS_SOURCE} language="typescript" />);
    await second.settle();
    const b = second.capture();
    second.destroy();

    expect(b).toEqual(a);
    // And BOTH must be the highlighted frame — two identical unhighlighted frames would pass
    // an equality-only assertion while being exactly the defect §6.3 names.
    expect(allRuns(a).map((run) => extractRgb(run.fg))).toContain(activeTokens().accent);
  });
});

describe("Code never reaches the network (design-system §6.1)", () => {
  test("no runtime source registers a tree-sitter parser", async () => {
    // Registering an extra grammar can fetch over HTTP — a runtime network dependency a shipped
    // binary must not take. The five bundled grammars resolve from local asset paths only. This
    // is a source-text assertion in the same style as index.test.ts's private-identity test,
    // because the fetch would happen in @opentui/core's WORKER, where a main-thread spy on
    // `fetch` proves nothing.
    // `import.meta.dir` + node:path, never `new URL(...).pathname` — the latter yields
    // `/C:/…` on Windows and no file opens.
    const root = path.resolve(import.meta.dir, "..");
    const offenders: string[] = [];
    for await (const relative of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
      const source = await Bun.file(path.join(root, relative)).text();
      if (source.includes("addFiletypeParser") || source.includes("addDefaultParsers")) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/runtime/ui/code.test.tsx`
Expected: FAIL — `Cannot find module './code'`.

- [ ] **Step 3: Write the wrapper**

Create `src/runtime/ui/code.tsx`:

```tsx
import { activeSyntaxStyle } from "../model/syntax-style";
import { activeTokens } from "../model/tokens";
import { Text } from "./text";

/** Props for the themed `Code` component. `id` is the mandatory stable id (§3.2). */
export interface CodeProps {
  /** Stable id selection and pins key on (§3.2). Mandatory on every catalog component. */
  readonly id: string;
  /** The source text to display, verbatim. Newlines are honoured. */
  readonly content: string;
  /**
   * Which grammar highlights the content — `"typescript"`, `"javascript"`, `"markdown"` or
   * `"zig"`. ANY OTHER VALUE, AND OMITTING IT ENTIRELY, RENDERS PLAIN TEXT: those four (plus
   * `markdown_inline`, used internally by `Markdown`) are the only grammars this binary ships,
   * and termcraft never downloads another one. That is a supported outcome, which is why this
   * is an open string rather than a closed union — a page naming a language this build cannot
   * highlight is correct code, not a type error.
   *
   * Syntax colours come from the ACTIVE THEME, never from a prop.
   */
  readonly language?: string;
}

/**
 * A themed block of source code (design-system §6.1). Renders one OpenTUI `<code>` renderable
 * whose syntax colours are built from the active theme's tokens.
 *
 * WHAT IS DELIBERATELY NOT A PROP. `syntaxStyle` is REQUIRED on OpenTUI's own `CodeOptions`;
 * termcraft constructs it from the theme instead of exposing it, so a page cannot hand the
 * renderer an arbitrary palette. `treeSitterClient` is never exposed at all — it is
 * renderer-internal access, and reaching it is what the wrapper layer exists to prevent.
 *
 * WHY THE ELEMENT'S OWN `fg` IS SET. OpenTUI paints the frame BEFORE highlighting lands (the
 * highlight runs in a worker) using the renderable's own default foreground, whose upstream
 * default is opaque white — not a colour in this design system. Every un-highlighted span, and
 * every span in an unsupported language, draws in this value.
 *
 * WHY `width="100%"`. A code renderable's intrinsic width is its longest line, which clips
 * wrapped content in a column parent. This is the same sizing OpenTUI's own `Markdown` gives
 * the code blocks it creates.
 *
 * FAILURE DEGRADES TO PLAIN TEXT, AS A VALUE. If the native render library cannot allocate a
 * syntax style, `activeSyntaxStyle()` returns an error (it logs once, through
 * `infrastructure/debug-log` — never through `console`, which under the renderer's
 * `consoleMode: "disabled"` writes to the real stdout) and this renders themed plain text.
 */
export function Code(props: CodeProps) {
  const fg = activeTokens().foreground;
  const syntaxStyle = activeSyntaxStyle();
  if (syntaxStyle instanceof Error) return <Text id={props.id}>{props.content}</Text>;

  return (
    <code
      id={props.id}
      content={props.content}
      filetype={props.language}
      syntaxStyle={syntaxStyle}
      fg={fg}
      width="100%"
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/runtime/ui/code.test.tsx`
Expected: PASS.

**If the highlight assertions fail with everything in `foreground`:** the worker did not finish
inside the settle budget, or `filetype` did not resolve. Diagnose before changing the test —
raise `handle.settle({ budgetMs: 2000 })` TEMPORARILY to tell "too slow" from "never highlights",
then fix the cause and restore the default. Never relax the assertion to accept plain text; that
is the exact defect §6.3 names.

- [ ] **Step 5: Add to the facade**

`src/runtime/index.ts` — append after the `Sparkline` exports:

```ts
export { Code } from "./ui/code";
export type { CodeProps } from "./ui/code";
```

`src/runtime/index.test.ts` — the catalog test is titled `"exports the full 13-component
design-system catalog + the low-level Box escape hatch"` and its list holds 13 names plus
`"Box"`. Retitle it `"…the full 14-component design-system catalog…"`, add
`"Code"` to its list, and append to the withholding test's forbidden-name list
`"activeSyntaxStyle"`, `"syntaxStyleAtom"` beside the existing `seedThemeCapability` entries.

- [ ] **Step 6: Regenerate the declaration**

Run: `bun run gen:runtime-dts`
Then confirm the new entry landed:
`grep -n "interface CodeProps" src/runtime/generated/runtime.generated.d.ts`
Expected: one hit, carrying the JSDoc from Step 3 verbatim — that JSDoc *is* the agent-facing
catalog entry.

- [ ] **Step 7: Verify**

```bash
bun x tsc --noEmit && bun run lint && bun run fmt:check
bun test src/runtime
```
Expected: silent, and the runtime suite green (including `generated/runtime-dts.test.ts`, which
fails on any un-regenerated drift).

- [ ] **Step 8: Commit**

```bash
rtk git add src/runtime/ui/code.tsx src/runtime/ui/code.test.tsx src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated
rtk git commit -m "feat(runtime): add the themed Code wrapper"
```

---

### Task 7: The `Markdown` wrapper

**Files:**
- Create: `src/runtime/ui/markdown.tsx`
- Create: `src/runtime/ui/markdown.test.tsx`
- Modify: `src/runtime/index.ts`
- Modify: `src/runtime/index.test.ts`
- Regenerate: `src/runtime/generated/*`

**Interfaces:**
- Consumes: `activeTokens`, `activeSyntaxStyle`, `Text`, `RenderHandle.settle`.
- Produces: `interface MarkdownProps { readonly id: string; readonly content: string }` and
  `function Markdown(props: MarkdownProps): React.ReactNode`, both exported from
  `src/runtime/ui/markdown.tsx` and re-exported from `src/runtime/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/runtime/ui/markdown.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { DARK_DEFAULT, DEFAULT_THEME_ID, activeTokens, seedThemeCapability } from "../model/tokens";
import { Markdown } from "./markdown";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const allText = (frame: { rows: StyledRun[][] }) =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");
const hueOf = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame)
    .filter((run) => run.text.includes(needle))
    .map((run) => extractRgb(run.fg));

const DOCUMENT = ["# Heading", "", "Body text here.", "", "```ts", "const a = 1", "```", ""].join(
  "\n",
);

describe("Markdown component (design-system §6.1)", () => {
  test("renders the heading, the prose and the fenced block", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 12 });
    open = handle;
    handle.mount(<Markdown id="doc" content={DOCUMENT} />);
    await handle.settle();
    const text = allText(handle.capture());
    expect(text).toContain("Heading");
    expect(text).toContain("Body text here.");
    expect(text).toContain("const a = 1");
  });

  test("a heading takes the design's title treatment: accent, bold (plan P8 D1)", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 12 });
    open = handle;
    handle.mount(<Markdown id="doc" content={DOCUMENT} />);
    await handle.settle();
    const frame = handle.capture();
    const heading = allRuns(frame).find((run) => run.text.includes("Heading"));
    expect(heading && extractRgb(heading.fg)).toBe<string>(activeTokens().accent);
    // BOLD=1 in the protocol attribute mask.
    expect((heading?.attrs ?? 0) & 0b1).toBe(0b1);
  });

  test("a fenced ts block is highlighted per its own language", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 12 });
    open = handle;
    handle.mount(<Markdown id="doc" content={DOCUMENT} />);
    await handle.settle();
    // `const` inside the fence resolves through the typescript grammar, not the markdown one.
    expect(hueOf(handle.capture(), "const")).toContain(activeTokens().accent);
  });

  test("A SILENTLY FAILED WORKER MUST FAIL THIS TEST, not degrade quietly", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 12 });
    open = handle;
    handle.mount(<Markdown id="doc" content={DOCUMENT} />);
    await handle.settle();
    const hues = new Set(allRuns(handle.capture()).map((run) => extractRgb(run.fg)));
    expect(hues.size).toBeGreaterThan(1);
  });

  test("the render follows the ACTIVE theme, not the compiled seed", async () => {
    // #4cc9f0 is a synthetic test fixture, not a design colour.
    seedThemeCapability({ themeId: "midnight", tokens: { ...DARK_DEFAULT, accent: "#4cc9f0" } });
    const handle = await createHeadlessRenderer({ w: 40, h: 12 });
    open = handle;
    handle.mount(<Markdown id="doc" content={DOCUMENT} />);
    await handle.settle();
    const heading = allRuns(handle.capture()).find((run) => run.text.includes("Heading"));
    expect(heading && extractRgb(heading.fg)).toBe<string>("#4cc9f0");
  });

  test("Markdown takes no filetype, and no renderer internals", () => {
    // @ts-expect-error — language is per fenced block inside the content (design spec §6.1).
    const withLanguage = <Markdown id="a" content="" language="typescript" />;
    // @ts-expect-error — termcraft builds the syntax style from the theme.
    const withStyle = <Markdown id="b" content="" syntaxStyle={undefined} />;
    // @ts-expect-error — `treeSitterClient` is never exposed.
    const withClient = <Markdown id="c" content="" treeSitterClient={undefined} />;
    // @ts-expect-error — `id` is mandatory on every wrapper.
    const withoutId = <Markdown content="" />;
    expect([withLanguage, withStyle, withClient, withoutId]).toHaveLength(4);
  });
});

describe("Markdown export determinism (design-system §6.3)", () => {
  test("two settled renders of the same document produce byte-identical styled rows", async () => {
    const first = await createHeadlessRenderer({ w: 40, h: 12 });
    first.mount(<Markdown id="doc" content={DOCUMENT} />);
    await first.settle();
    const a = first.capture();
    first.destroy();

    const second = await createHeadlessRenderer({ w: 40, h: 12 });
    second.mount(<Markdown id="doc" content={DOCUMENT} />);
    await second.settle();
    const b = second.capture();
    second.destroy();

    expect(b).toEqual(a);
    // Both must be the HIGHLIGHTED frame: `Markdown` exposes no completion signal of its own,
    // so a settle that returned early would produce two identical plain frames that an
    // equality-only assertion would happily accept.
    expect(allRuns(a).map((run) => extractRgb(run.fg))).toContain(activeTokens().accent);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/runtime/ui/markdown.test.tsx`
Expected: FAIL — `Cannot find module './markdown'`.

- [ ] **Step 3: Write the wrapper**

Create `src/runtime/ui/markdown.tsx`:

```tsx
import { activeSyntaxStyle } from "../model/syntax-style";
import { activeTokens } from "../model/tokens";
import { Text } from "./text";

/** Props for the themed `Markdown` component. `id` is the mandatory stable id (§3.2). */
export interface MarkdownProps {
  /** Stable id selection and pins key on (§3.2). Mandatory on every catalog component. */
  readonly id: string;
  /**
   * The markdown source. There is NO language prop: a fenced block declares its own language in
   * its info string (```` ```ts ````), and prose is styled by the markdown grammar. Only
   * `typescript`, `javascript`, `markdown` and `zig` fences highlight; any other fence renders
   * plain, which is a supported outcome.
   */
  readonly content: string;
}

/**
 * A themed rendered markdown document (design-system §6.1). Renders one OpenTUI `<markdown>`
 * renderable whose colours — headings, emphasis, lists, links, and every fenced code block —
 * come from the active theme's tokens.
 *
 * NO `filetype` PROP, ON PURPOSE. Language selection is per fenced block, inside the content
 * itself; a document-level language would be meaningless.
 *
 * WHAT IS DELIBERATELY NOT A PROP: `syntaxStyle` (REQUIRED upstream, built here from the theme)
 * and `treeSitterClient` (renderer-internal access this layer exists to prevent).
 *
 * WHY THE ELEMENT'S OWN `fg` IS SET. `MarkdownRenderable` forwards its `fg` to every child code
 * renderable it builds, and those paint their pre-highlight frame with it. Left unset, upstream's
 * own default is opaque white — not a colour in this design system.
 *
 * ASYNCHRONOUS BY CONSTRUCTION, AND WHAT THAT COSTS THE EXPORT PATH. Every block — fenced code
 * AND prose — is internally a code renderable whose highlight runs in a worker, and
 * `MarkdownRenderable` exposes no aggregate completion signal. A single render pass therefore
 * captures the plain-text frame. `RenderHandle.settle()` (`host/render/model/settle.ts`) is what
 * makes a captured markdown frame the finished one; `handleMount` calls it for every mount.
 *
 * FAILURE DEGRADES TO PLAIN TEXT, AS A VALUE — see `Code`'s own note for the mechanism.
 */
export function Markdown(props: MarkdownProps) {
  const fg = activeTokens().foreground;
  const syntaxStyle = activeSyntaxStyle();
  if (syntaxStyle instanceof Error) return <Text id={props.id}>{props.content}</Text>;

  return (
    <markdown
      id={props.id}
      content={props.content}
      syntaxStyle={syntaxStyle}
      fg={fg}
      width="100%"
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/runtime/ui/markdown.test.tsx`
Expected: PASS.

**If the heading assertion fails on `attrs`:** check whether the concealed `# ` prefix split the
run — assert on the run containing `"Heading"` specifically (the test already does) rather than
on row 0's first run. **If it fails on the hue**, re-read D1's note on
`markup.heading.1` → `markup` fallback: the six numbered heading scopes must be registered, and
Task 1's test asserts they are.

- [ ] **Step 5: Add to the facade**

`src/runtime/index.ts` — append after the `Code` exports:

```ts
export { Markdown } from "./ui/markdown";
export type { MarkdownProps } from "./ui/markdown";
```

`src/runtime/index.test.ts` — retitle the catalog test (Task 6 left it at 14) to
`"exports the full 15-component design-system catalog + the low-level Box escape hatch"` and add
`"Markdown"` to its list, which then holds 15 names plus `"Box"`.

- [ ] **Step 6: Regenerate and verify**

```bash
bun run gen:runtime-dts
bun x tsc --noEmit && bun run lint && bun run fmt:check
bun test src/runtime
```
Expected: silent, and the runtime suite green.

- [ ] **Step 7: Commit**

```bash
rtk git add src/runtime/ui/markdown.tsx src/runtime/ui/markdown.test.tsx src/runtime/index.ts src/runtime/index.test.ts src/runtime/generated
rtk git commit -m "feat(runtime): add the themed Markdown wrapper"
```

---

### Task 8: Canary, agent guide, architecture docs

**Files:**
- Modify: `src/gate/model/lexer.test.ts:379`
- Modify: `src/gate/model/lexer.oracle.test.ts:556`
- Modify: `src/agent/prompt/model/runtime-authoring-guide.md`
- Modify: `docs/architecture/modules.md`, `docs/architecture/modules.ru.md`
- Modify: `docs/architecture/flows/export.md`, `docs/architecture/flows/export.ru.md`

**Interfaces:**
- Consumes: everything above. Produces nothing importable.

- [ ] **Step 1: Recount the corpus — do not guess**

```bash
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.mts" -o -name "*.cts" \) | wc -l
```
Expected: `957` (949 before this plan, plus this plan's eight new files). **Use the number the
command prints, not this one** — if they disagree, some task added or removed a file and the
printed number is the truth.

- [ ] **Step 2: Run the canary to verify it fails**

Run: `bun test src/gate/model/lexer.test.ts`
Expected: FAIL — `expect(files.length).toBe(949)` receiving the new count.

- [ ] **Step 3: Bump both canaries**

`src/gate/model/lexer.test.ts:379` — `expect(files.length).toBe(957);` (the counted number), and
extend the comment above it with `; 949 → 957 when plan P8 added the Code/Markdown wrappers,
their tests, the syntax-style builder and the render settle loop`.

`src/gate/model/lexer.oracle.test.ts:556` — the test title becomes
`"the repository's own 957 sources: zero under-scans and zero refusals"`.

- [ ] **Step 4: Run both to verify they pass**

Run: `bun test src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts`
Expected: PASS. If the run reports `crashed` rather than pass/fail, re-run once — this is the
known `Bun.Transpiler` panic that `lexer.oracle.test.ts`'s fuzz corpus reaches.

- [ ] **Step 5: Add the agent-facing entry**

The per-component catalog an authoring agent reads is the generated `runtime.d.ts` (Tasks 6 and
7 already put the JSDoc there). `RUNTIME.md` needs the one thing a signature cannot say — which
languages actually highlight. Append to
`src/agent/prompt/model/runtime-authoring-guide.md`, immediately before the final
`## What not to do` section:

```markdown
## Code and rendered markdown

`Code` shows source text; `Markdown` renders a markdown document, including its fenced code
blocks. Both need only `id` and `content`.

    <Code id="snippet" language="typescript" content={source} />
    <Markdown id="notes" content={doc} />

Syntax colours come from the project's theme. There is no colour prop, no style prop, and no
way to pass a palette — a page cannot recolour syntax, and does not need to.

`Code` takes an optional `language`. `Markdown` takes none: a fenced block names its own
language in its info string.

Only `typescript`, `javascript`, `markdown` and `zig` highlight. Any other language — and
`Code` with no `language` at all — renders as plain themed text. That is a normal outcome, not
an error: nothing is downloaded at runtime, so a build ships exactly these grammars.
```

- [ ] **Step 6: Update the architecture docs**

`docs/architecture/modules.md` — the `src/runtime/ui/` row (line ~233) becomes "16 components"
and gains: `code` and `markdown` build their syntax colours from `runtime/model/syntax-style.ts`
(`SyntaxStyle.fromStyles` over the active theme's roles — the roles→capture-scopes mapping is a
FLAGGED design gap resolved in plan P8's D1, since the design system covers no code display),
never expose `syntaxStyle`/`treeSitterClient`, and degrade to plain text when no style can be
allocated. Add a `src/host/render/model/settle.ts` entry: the quiet-frames settle pass every
mount runs before its capture, because highlighting is asynchronous and the host emits one frame
per mount. Add an `infrastructure/debug-log` note that the third-party console bridge keeps a
dependency's diagnostics off the terminal and off the protocol pipe.

`docs/architecture/flows/export.md` — in the capture step (the numbered list around line 27),
record that the one-shot child now SETTLES the frame (`RenderHandle.settle`) before sealing it,
that the settle is content-fingerprinted including colour, and that a budget exhaustion is
logged as a determinism diagnostic rather than failing the export.

Mirror both edits into `modules.ru.md` and `flows/export.ru.md`, matching those files' existing
mixed-language house style.

- [ ] **Step 7: Verify and commit**

```bash
bun x tsc --noEmit && bun run lint && bun run fmt:check
bun test src/gate src/agent
rtk git add src/gate/model/lexer.test.ts src/gate/model/lexer.oracle.test.ts src/agent/prompt/model/runtime-authoring-guide.md docs/architecture
rtk git commit -m "docs: record the Code/Markdown wrappers, the settle pass and the design gap"
```

---

## Final verification

Run every command; paste real output before claiming the plan is done. Evidence before
assertions (`superpowers:verification-before-completion`).

- [ ] **Typecheck**

```bash
bun x tsc --noEmit
```
Expected: no output.

- [ ] **Lint and format**

```bash
bun run lint && bun run fmt:check
```
Expected: both clean.

- [ ] **Generated declaration is in sync**

```bash
bun run gen:runtime-dts && git --no-pager diff --stat src/runtime/generated
```
Expected: empty diff. A non-empty diff means a task committed a stale artifact; commit the
regeneration.

- [ ] **The corpus canary matches reality**

```bash
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.mts" -o -name "*.cts" \) | wc -l
grep -n "files.length).toBe" src/gate/model/lexer.test.ts
grep -n "the repository's own" src/gate/model/lexer.oracle.test.ts
```
Expected: all three numbers equal.

- [ ] **The two render suites, as SEPARATE commands (spec §11)**

```bash
bun test src/ui
```
```bash
bun test src/entrypoint
```
Expected: both green. A combined run produces random failures under load — do not combine them,
and do not "fix" a failure produced by combining them.

- [ ] **The whole suite, through the crash-aware wrapper**

```bash
bun run test
```
Expected: `pass`. If it prints the crash banner, that is neither a pass nor a fail — re-run once.
Only a second crash is evidence about this change.

- [ ] **The wrappers really highlight, end to end, not only in a unit test**

```bash
bun test src/runtime/ui/code.test.tsx src/runtime/ui/markdown.test.tsx
bun test src/host/render/model/determinism.test.ts
```
Expected: green. The determinism test spawns real `_host --stdio` processes and exercises the
same `handleMount` settle path a real export takes.

- [ ] **The dependency is declared and pinned**

```bash
node -e "const a=require('./package.json'),b=require('./node_modules/@opentui/core/package.json');console.log(a.dependencies['web-tree-sitter'], b.peerDependencies['web-tree-sitter'])"
```
Expected: the two versions print identically (`0.25.10 0.25.10`).

- [ ] **Reatom audit over the changed code**

```
/reatom-audit
```
Expected: clean. This plan adds one `computed` (`syntaxStyleAtom`) and no new atoms, actions or
effects; a finding here almost certainly concerns that computed's naming or its dependency read.

- [ ] **Architecture docs**

Confirm `docs/architecture/modules{,.ru}.md` and `flows/export{,.ru}.md` describe the 16-component
catalog, the syntax-style builder and its flagged design gap, and the settle pass.

---

## Open risks, carried forward deliberately

1. **The roles→scopes mapping is a flagged gap, not a design decision.** D1 says so, the
   module's doc comment says so, and the architecture docs say so. If a design pass ever adds a
   code screen, D1's table is what it replaces.
2. **A superseded `SyntaxStyle` is not destroyed** (D2). Bounded at two per process in stage 1;
   the trigger to revisit is a shell-side theme switcher.
3. **The settle loop is time-budgeted**, so a page whose content never stops changing exports a
   non-final frame. It is logged, not failed — an export that produces nothing is worse than one
   that produces an early frame. The per-wrapper export tests assert the highlighted frame, so a
   regression in settle behaviour fails a test rather than shipping quietly.
4. **The console bridge changes global `console` while it is installed.** It is installed only
   by the two stream-owning processes and never by a test unless the test installs it, and
   `emit`'s indirection is inert when no bridge is installed — but `src/host/session/entry.test.ts`
   and `src/ui/app` exercise both install sites, so the full suite is the check that matters.
5. **`Markdown` still exposes no aggregate completion signal.** The settle loop reaches its
   blocks only because each one happens to be a `CodeRenderable`; an upstream refactor that
   changes that would silently degrade `Markdown` to quiet-frames-only. The quiet-frames
   backstop is what keeps that from being a correctness bug, and `settle.test.ts`'s
   "pending promise that never resolves" case pins that the promises are an accelerator, never a
   gate.
