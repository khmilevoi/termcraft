# Agent Prompt Library (phase-8 WP-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two placeholders `core/kernel/model/handlers/turn.ts` currently sends
into every real turn — `TURN_START_SYSTEM_PROMPT_PLACEHOLDER` and `runtimeDocs: []` — with a
real, ported `AgentPromptSource` that composes the system prompt from honestly-held turn
context and ships the runtime API reference as real files staged into the turn workspace.

**Architecture:** `core/ports/agent-prompt.ts` declares `AgentPromptContextV1`/
`AgentPromptSource` (both FIXED verbatim by the parent plan, `docs/superpowers/plans/
2026-07-25-mvp-phase-8.md` Task 19 — this plan may not change their shape). A new module,
`agent/prompt/`, implements the port: static prose (role, §5.8 design-code rules including the
slug mask, the page-file layout, answer-style guidance) composed with the live context into
the system prompt, plus two real files — the generated `@termcraft/runtime` declaration and a
hand-authored `RUNTIME.md` — returned as paths, never staged eagerly (there is no startup
staging step under npm distribution). `core/kernel/types.ts`'s `KernelDeps` gains one field;
`turn.ts`'s `runTurnStart` builds the context from facts it ALREADY reads for other purposes
(no new port call) and calls the port. `entrypoint/model/create-shell.ts` wires the real
production factory.

**Tech Stack:** TypeScript on Bun ≥1.3.14, `@reatom/core` ^1001.1.0, `errore` ^0.14.1. Tests:
`bun test`. Typecheck: `bun x tsc --noEmit`. Lint/format: `oxlint` / `oxfmt`.

**Normative sources:** `docs/superpowers/plans/2026-07-25-mvp-phase-8.md` (Task 19, whose
Interfaces/Required-scope sections this plan implements verbatim), `docs/superpowers/specs/
2026-07-25-mvp-phase-8-design.md` §WP-3, `docs/superpowers/specs/2026-07-13-termcraft-design.md`
§5.8 (design-code rules), §6.2 (turn protocol — what the prompt carries; **not** §6.1 as the
parent plan's brief names it, see "What turned out not to be true" below), §3.2 (the
markdown-lite subset), `docs/architecture/code-structure.md`.

## Global Constraints

Inherited verbatim from `docs/superpowers/plans/2026-07-25-mvp-phase-8.md`'s own "Global
Constraints" section (itself inherited from `2026-07-17-termcraft-mvp-roadmap.md`). Every task
below implicitly includes it; restated here only for the points this plan's tasks actually
touch:

- **Bun** `>=1.3.14`. Tests: `bun test`. Typecheck: `bun x tsc --noEmit`.
- **errore is mandatory**: namespace import, errors as values, `createTaggedError` for domain
  errors, `.catch()`/`errore.try` only at boundaries, flat control flow, one-line
  `instanceof Error` early returns. (No task below introduces a fallible I/O boundary that
  needs a new tagged error — `runtimeDocs()` is synchronous with no failure channel and only
  ever logs; see Task 4.)
- **Reatom v1001 rules**: named atoms/computeds/actions; this package adds none — it is pure
  string composition plus static file paths, no Reatom surface of its own.
- **Module DAG** (`docs/architecture/code-structure.md`): `core` imports only `entities/` and
  its own `ports/`; `agent` implements the ports `core` declares (mirrors `AgentBackend`).
  `core/kernel/model/handlers/turn.ts` may import `AgentPromptContextV1`/`AgentPromptSource`
  type-only from `core/ports`, never from `agent/prompt/` itself.
- **Module folder shape** (`CLAUDE.md`): `ui/`, `model/`, `types.ts`, `index.ts`; code always
  inside subfolders, never loose at module root.
- **Imports**: cross-module imports use the `tsconfig.json` path aliases (`agent`, `agent/*`,
  `core`, `core/*`, etc.), never a relative path climbing out of the module.
- **Page slug mask** (quoted exactly, per the parent plan's brief): `^[a-z0-9][a-z0-9-]{0,31}$`
  minus Windows device names (`con`, `nul`, `aux`, `prn`, `com1`–`com9`, `lpt1`–`lpt9`).
- **Honest values only**: every fact `AgentPromptContextV1` carries must trace to a `core/ports`
  read this handler already performs (or a field on a port it already holds) — never a second
  port call invented for this package, never a fabricated default.
- **Language**: all code, comments, commit messages, and this document in English.
- **Commits**: frequent, per task, `feat:`/`fix:`/`docs:`/`test:`/`refactor:`/`chore:` prefixes,
  each ending with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  trailer (omitted from the example commands below for brevity, exactly as the parent plan's
  own commit blocks do — add it when actually committing).

## Interfaces this plan implements (fixed by the parent plan — not open for redesign here)

```ts
// src/core/ports/agent-prompt.ts — declared by core (the consumer), implemented by agent
export interface AgentPromptContextV1 {
  readonly activePageSlug: PageSlug | null;
  readonly pageOrder: readonly PageSlug[];
  readonly kitApiVersion: number;
  readonly openPins: readonly { readonly pageSlug: PageSlug; readonly text: string }[];
}

export interface AgentPromptSource {
  systemPrompt(context: AgentPromptContextV1): string;
  runtimeDocs(): readonly StagingRuntimeDocV1[];
}
```

## Known gaps this plan does NOT close (read before executing)

These are recorded here, with evidence, rather than papered over — per the parent brief's
explicit instruction and this project's "flag, never fabricate" discipline.

1. **Master spec §6.2 names more prompt content than `AgentPromptContextV1` carries.**
   `2026-07-13-termcraft-design.md:926-935` states the prompt contains "the role, design-code
   rules (§5.8), portable page order, **source-extracted metadata**, the local active page,
   **the outstanding diagnostics** (from the Gate and host-reported runtime lints, §5.2), **the
   current selection**, open pins ..., answer-style guidance ..., and the user message." The
   FIXED `AgentPromptContextV1` (parent plan Task 19) carries only `activePageSlug`,
   `pageOrder`, `kitApiVersion`, and `openPins` — it has no field for per-page
   title/theme/minSize metadata, no field for outstanding Gate/host diagnostics, and no field
   for the current selection. This plan implements the interface as fixed; it does not widen
   it. Two of the three missing items are honestly explained by other, already-landed code
   (below); the third is a genuine, standing gap:
   - **Outstanding diagnostics** are NOT missing in practice — they travel through a different
     channel already wired and explicitly out of scope for this package: on a Gate-rejected
     retry, `core/turns/model/run-turn.ts` (around the `foldGateDiagnosticsIntoPrompt` call
     near what is currently line 491, and the `userMessage = appendPromptFold(...)` reassignment
     at line 501; `RunTurnDeps.foldGateDiagnosticsIntoPrompt` is declared at line 138) replaces
     `userMessage` with the original text plus the previous attempt's folded diagnostics. This
     is the USER message channel, not the system prompt this package builds — see the parent
     plan's own Task 19 brief, which calls this "already wired ... not part of this package."
   - **Source-extracted per-page metadata** (title/theme/minSize) has no channel into the
     prompt at all today. `core/ports/projections.ts`'s `PageMetaCache`/`PageMetaEntryV1` holds
     exactly this, keyed by `(pageSlug, sourceHash)` — `KernelDeps.pageMetaCache` already exists
     — but `AgentPromptContextV1` has no field for it, and widening the fixed interface is out
     of this plan's authority. Flagged for whoever next revises `AgentPromptContextV1`.
   - **The current selection** has NO channel into the live agent call at all, in the current
     tree. `core/turns/model/admission.ts:145` folds `input.selection` only into the persisted
     `ChatUserRecord` (chat history for the UI), never into `AgentTask.userMessage` or
     `AgentTask.systemPrompt`. Confirmed by reading `admission.ts` in full: no other write of
     `selection` exists in `core/turns`. This is a standing gap outside `AgentPromptContextV1`'s
     fixed shape and outside this plan's scope — recorded here so it is not silently assumed
     "already handled."
2. **`kitApiVersion` sourcing was not specified by the parent plan and required investigation.**
   Resolved in Task 7 below: it comes from `context.deps.exportRender.runtimeDeclaration
   .currentKitApiVersion` (`core/ports/export-render.ts`'s `RuntimeDeclarationBundleV1`,
   already a `KernelDeps.exportRender` field) — no new `KernelDeps` field, no new port call.
   See Task 7's own rationale for the full chain of evidence.
3. **`import.meta.dir`-based path resolution for the two runtime-doc source files is verified
   in dev-checkout mode by this plan's own tests, but NOT against a `bun link`-installed
   package.** Task 4 flags this explicitly as verify-not-assume; Task 21 of the parent plan
   (the phase's closing task) is where the installed-package proof belongs, per the phase's own
   cross-cutting constraint ("Acceptance oracles must exercise the shipped artifact in the
   shipped mode"). This plan's Task 4 Step 6 adds one manual `bun link` check to reduce risk
   before that gate, but does not add a second permanent installed-package test — Task 5/Task 21
   of the parent plan already own that oracle shape (`installed-package.test.ts`).

## What turned out not to be true about the brief (report before executing)

- **The brief cites master spec "§6.1 (what the prompt must carry)."** The actual paragraph
  enumerating prompt contents ("The agent runs against the turn workspace with its native file
  tools ... The prompt contains the role, design-code rules (§5.8), portable page order ...")
  lives in **§6.2 "Turn protocol"** (`2026-07-13-termcraft-design.md:926-935`), not §6.1
  ("Backend abstraction", `:796`). This plan cites §6.2 for that content and reserves §6.1 for
  what it actually covers (the `AgentBackend` interface, confinement, the `AgentEvent` stream).
- **`src/agent/session/model/prompt.ts` already exists, and is genuinely a different concern —
  not a naming collision to resolve.** Read in full (`docs/architecture/code-structure.md:402`
  already documents it as "the SHARED resume-delta / fresh-transcript composition"). Its one
  function, `buildPrompt(task: AgentTask): string`, builds the per-ATTEMPT **user message**:
  on a `resume` session it returns the delta (or the raw user message when the kernel supplied
  none); on a `fresh` session it prepends the bounded seed transcript. It has no role text, no
  design-code rules, no slug mask, and is never called with anything shaped like
  `AgentPromptContextV1`. This plan does not touch, absorb, or rename it — `agent/prompt/` is a
  new, sibling top-level module under `agent/`, and Task 7 adds one sentence to `turn.ts`'s own
  header explicitly distinguishing the two so a future reader never conflates them.
- **`turn.ts`'s real line numbers had all moved, exactly as the brief warned.** As read for this
  plan: `TURN_START_SYSTEM_PROMPT_PLACEHOLDER` is declared at line 323-324 and used at line 684;
  `runtimeDocs: []` is at line 672. `candidatePins`/`readSet.pins` (kernel-command-contract
  §12.2, phase-8 WP-6) are ALREADY real in this tree (lines 622-654) — Task 10 of the parent
  plan has already landed here, ahead of its nominal position in the parent plan's task order.
  This matters for Task 7 below: the open-pins-for-the-prompt list is built in the SAME loop
  that already builds `candidatePins`, not a new one.
- **`AgentPromptContextV1.kitApiVersion`'s source was not specified and is not obvious** — see
  "Known gaps" item 2 above and Task 7's own rationale.
- **The runtime docs need to be REAL FILES on disk, and none existed before this plan.**
  `StagingRuntimeDocV1` (`core/ports/staging.ts:26-29`) is confirmed to carry `relPath` +
  `sourcePath` — a path, never content, confirming the parent design doc's "the port returns
  paths into it" — but `src/runtime/generated/runtime-dts.ts` (already landed, phase-8 Task 6)
  only exists as a JS string constant (`RUNTIME_DTS`), never as a plain `.d.ts` file. Task 4
  below extends the ALREADY-LANDED generator (`scripts/gen-runtime-dts.ts`) with one more output
  artifact rather than inventing a second generation path — see that task's rationale.
- **The exact filenames `RUNTIME.md` and any `*.d.ts` at the workspace root are not just this
  plan's choice — they are already hard-coded in the REAL store adapter's namespace
  classifier.** `src/store/safe-fs/model/limits.ts:99-103` (`classifyWorkspace`) special-cases
  `first === "RUNTIME.md"` and `first.endsWith(".d.ts")` as `"agent-runtime-doc"` for a
  single-component (workspace-root) path. This independently confirms — not merely suggests —
  that `RUNTIME.md` and a `*.d.ts` name (this plan uses `runtime.d.ts`) are the two filenames
  the rest of the system already expects; Task 4 was written to match this exactly, not
  invented in isolation.

---

### Task 1: Declare the `AgentPromptSource` port in `core/ports`

**Files:**
- Create: `src/core/ports/agent-prompt.ts`
- Modify: `src/core/ports/index.ts`

**Interfaces:**
- Consumes: `PageSlug` (`entities/page`), `StagingRuntimeDocV1` (`./staging`).
- Produces: `AgentPromptContextV1`, `AgentPromptSource` — consumed by Task 6
  (`KernelDeps`), Task 7 (`turn.ts`), and every file under Task 2-5 (`agent/prompt/`).

This is a pure type declaration — no runtime behavior, so there is no red/green test cycle for
this task; correctness is verified by `bun x tsc --noEmit` once every later task compiles
against it.

- [ ] **Step 1: Write the port file**

```ts
// src/core/ports/agent-prompt.ts
import type { PageSlug } from "entities/page";

import type { StagingRuntimeDocV1 } from "./staging";

/**
 * Everything `core` honestly holds about a turn's context that the agent-prompt library
 * (`agent/prompt/`) needs to compose a system prompt (phase-8 design §WP-3). Nothing here is
 * invented to fill a gap: `activePageSlug`/`pageOrder` are the SAME facts `turn.start`
 * (`core/kernel/model/handlers/turn.ts`) already reads to build the manifest slice;
 * `kitApiVersion` is the SAME constant `ExportRenderPort.runtimeDeclaration
 * .currentKitApiVersion` (`core/ports/export-render.ts`) already carries; `openPins` is
 * folded from the SAME `PinReader.fold` result `candidatePins` is built from, never a second
 * port call.
 *
 * Master spec §6.2's own list of what the prompt carries is wider than this — it also names
 * source-extracted per-page metadata, outstanding Gate/host diagnostics, and the current
 * selection. Those three are NOT here: outstanding diagnostics reach the agent through a
 * different, already-wired channel (`core/turns/model/run-turn.ts`'s retry-time append to the
 * USER message, not this context); per-page metadata and the current selection have no
 * `core/ports` channel into the prompt at all today — a documented gap, not an oversight (see
 * `docs/superpowers/plans/2026-07-25-agent-prompt-library.md`'s "Known gaps" section).
 */
export interface AgentPromptContextV1 {
  readonly activePageSlug: PageSlug | null;
  readonly pageOrder: readonly PageSlug[];
  readonly kitApiVersion: number;
  readonly openPins: readonly { readonly pageSlug: PageSlug; readonly text: string }[];
}

/**
 * Declared by `core` (the consumer), implemented by `agent/prompt/` (phase-8 design §WP-3) —
 * mirrors the `AgentBackend`/`GateRunner` precedent: the port lives where the data is
 * CONSUMED, never where it is produced. `systemPrompt` is a pure function of `context` plus
 * this module's own static prose (role, §5.8 design-code rules, page-file layout,
 * answer-style guidance). `runtimeDocs` takes no argument: the two files it names (the
 * generated `@termcraft/runtime` declaration, the hand-authored authoring guide) are
 * process-wide constants, not per-turn facts. Under npm distribution these are ordinary files
 * inside the installed package, so the returned `StagingRuntimeDocV1.sourcePath`s are real
 * paths, never staged eagerly at startup.
 */
export interface AgentPromptSource {
  systemPrompt(context: AgentPromptContextV1): string;
  runtimeDocs(): readonly StagingRuntimeDocV1[];
}
```

- [ ] **Step 2: Export it from `core/ports/index.ts`**

Insert immediately after the existing `export type { AgentRegistry } from "./agent-registry";`
line (currently line 35, in the "agent" export group):

```ts
// ---- agent prompt library (phase-8 WP-3) ------------------------------------------------
export type { AgentPromptContextV1, AgentPromptSource } from "./agent-prompt";
```

- [ ] **Step 3: Typecheck**

Run: `bun x tsc --noEmit`
Expected: exit 0 (the new file has no consumers yet, so this only proves the file itself is
well-formed).

- [ ] **Step 4: Commit**

```bash
rtk git add src/core/ports/agent-prompt.ts src/core/ports/index.ts
rtk git commit -m "feat(core): declare the AgentPromptSource port (phase-8 WP-3)"
```

---

### Task 2: `agent/prompt/` — the static prose sections

**Files:**
- Create: `src/agent/prompt/model/prose.ts`
- Create: `src/agent/prompt/model/prose.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ROLE`, `DESIGN_CODE_RULES`, `PAGE_FILE_LAYOUT`, `ANSWER_STYLE` (all `string`) —
  consumed by Task 3's `buildSystemPrompt`.

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/prompt/model/prose.test.ts
import { describe, expect, test } from "bun:test";

import { ANSWER_STYLE, DESIGN_CODE_RULES, PAGE_FILE_LAYOUT, ROLE } from "./prose";

describe("agent/prompt static prose", () => {
  test("DESIGN_CODE_RULES names the slug mask verbatim and the Windows-reserved names", () => {
    expect(DESIGN_CODE_RULES).toContain("^[a-z0-9][a-z0-9-]{0,31}$");
    expect(DESIGN_CODE_RULES).toContain("con, nul, aux, prn, com1-com9, lpt1-lpt9");
  });

  test("DESIGN_CODE_RULES names the single permitted import and the forbidden ones", () => {
    expect(DESIGN_CODE_RULES).toContain('"@termcraft/runtime"');
    for (const forbidden of ['"@reatom/*"', '"react"', '"@opentui/*"', '"node:*"', '"bun:*"']) {
      expect(DESIGN_CODE_RULES).toContain(forbidden);
    }
  });

  test("DESIGN_CODE_RULES bans setTimeout/setInterval/Math.random outside animation", () => {
    expect(DESIGN_CODE_RULES).toContain("setTimeout");
    expect(DESIGN_CODE_RULES).toContain("setInterval");
    expect(DESIGN_CODE_RULES).toContain("Math.random");
    expect(DESIGN_CODE_RULES).toContain("animation guarded by the export flag");
  });

  test("PAGE_FILE_LAYOUT names pages/<slug>.tsx, pages.json, and the two runtime docs", () => {
    expect(PAGE_FILE_LAYOUT).toContain("pages/<slug>.tsx");
    expect(PAGE_FILE_LAYOUT).toContain("pages.json");
    expect(PAGE_FILE_LAYOUT).toContain("RUNTIME.md");
    expect(PAGE_FILE_LAYOUT).toContain("runtime.d.ts");
  });

  test("ANSWER_STYLE names the markdown-lite subset and what flattens", () => {
    expect(ANSWER_STYLE).toContain("markdown-lite");
    expect(ANSWER_STYLE).toContain("bold, italic, inline code, and bullet lists");
    expect(ANSWER_STYLE).toContain("Headings flatten to bold lines");
    expect(ANSWER_STYLE).toContain("tables, code blocks, and links flatten to plain text");
  });

  test("ROLE names the fenced turn workspace and the agent's own file tools", () => {
    expect(ROLE).toContain("turn workspace");
    expect(ROLE).toContain("file tools");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/agent/prompt/model/prose.test.ts`
Expected: FAIL — `./prose` does not exist.

- [ ] **Step 3: Write the prose module**

```ts
// src/agent/prompt/model/prose.ts

/**
 * Process-wide static text — the parts of the system prompt that do not depend on any one
 * turn's context. `system-prompt.ts` composes these with the live `AgentPromptContextV1`.
 * Content sourced from master spec §5.8 (design-code rules), §6.2 (role, page-file layout),
 * §3.2 (the markdown-lite subset the chat renders), and the roadmap's Global Constraints
 * (the slug mask, quoted verbatim).
 */

export const ROLE =
  "You are termcraft's page-authoring agent. You work entirely inside one fenced turn " +
  "workspace, using your own native file tools to read and edit page modules — there is no " +
  "prefetch protocol, no read bookkeeping, and no separate \"apply\" step: whatever you leave " +
  "in the workspace when you finish is what termcraft evaluates.";

export const DESIGN_CODE_RULES = `Design-code rules, enforced by the Gate and re-checked by the design host:

Import allowlist (error): the only import a page module may use is "@termcraft/runtime". Direct imports of "@termcraft/kit", "@reatom/*", "react", "react/jsx-runtime", "@opentui/*", "node:*", and "bun:*" are forbidden, as are relative imports of other pages, imports of any other npm package, all dynamic imports, and all re-exports — including a re-export that names "@termcraft/runtime". "eval" and "new Function" are forbidden.

Page contract (error): a page file's default export must be a "reatomComponent" page, and it must export a static "meta" object literal of constants (no computed values) that includes a supported integer "kitApiVersion". The file must typecheck against the runtime types.

Conventions (warnings, fed back to you on your next attempt): keep element ids stable across iterations; give every pointable low-level element an id; never use setTimeout, setInterval, or Math.random outside animation guarded by the export flag; keep any simulated or sample data inside the component that uses it.

Page slugs: a slug must match ^[a-z0-9][a-z0-9-]{0,31}$ and must not be a Windows-reserved device name (con, nul, aux, prn, com1-com9, lpt1-lpt9) — a slug becomes a directory name on disk. A slug violating this mask is a Gate error, not a warning.`;

export const PAGE_FILE_LAYOUT = `Page-file layout inside this workspace:

- pages/<slug>.tsx — one file per page, flat by slug. Create a new file to add a page; delete a file to remove one.
- pages.json — the manifest slice: the ordered list of page slugs, and an optional requested active slug. Reorder pages or request which one becomes active by editing this file, not any other way.
- RUNTIME.md and runtime.d.ts, alongside the files above — the runtime API reference for "@termcraft/runtime". Read them before writing or editing a page.

A page's display title lives in its own source, as meta.title — retitle a page by editing that field, never pages.json.`;

export const ANSWER_STYLE =
  "Keep your final message short. The chat renders only a markdown-lite subset of your " +
  "reply: bold, italic, inline code, and bullet lists. Headings flatten to bold lines; " +
  "tables, code blocks, and links flatten to plain text — so do not rely on any of those " +
  "three for structure or meaning.";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/agent/prompt/model/prose.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/prompt/model/prose.ts src/agent/prompt/model/prose.test.ts
rtk git commit -m "feat(agent): write the agent-prompt library's static prose sections"
```

---

### Task 3: `agent/prompt/` — compose the system prompt from context

**Files:**
- Create: `src/agent/prompt/model/system-prompt.ts`
- Create: `src/agent/prompt/model/system-prompt.test.ts`

**Interfaces:**
- Consumes: `AgentPromptContextV1` (Task 1), `ROLE`/`DESIGN_CODE_RULES`/`PAGE_FILE_LAYOUT`/
  `ANSWER_STYLE` (Task 2).
- Produces: `buildSystemPrompt(context: AgentPromptContextV1): string` — consumed by Task 5's
  factory.

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/prompt/model/system-prompt.test.ts
import { describe, expect, test } from "bun:test";

import type { AgentPromptContextV1 } from "core/ports";
import type { PageSlug } from "entities/page";

import { buildSystemPrompt } from "./system-prompt";

const EMPTY_CONTEXT: AgentPromptContextV1 = {
  activePageSlug: null,
  pageOrder: [],
  kitApiVersion: 1,
  openPins: [],
};

describe("buildSystemPrompt", () => {
  test("with no active page and no pages yet, says so honestly rather than fabricating one", () => {
    const prompt = buildSystemPrompt(EMPTY_CONTEXT);
    expect(prompt).toContain("No page is currently active.");
    expect(prompt).toContain("This project has no pages yet");
  });

  test("names the active page, the full portable order, and the kit API version to declare", () => {
    const context: AgentPromptContextV1 = {
      activePageSlug: "home" as PageSlug,
      pageOrder: ["home" as PageSlug, "about" as PageSlug],
      kitApiVersion: 1,
      openPins: [],
    };
    const prompt = buildSystemPrompt(context);
    expect(prompt).toContain('The currently active page is "home".');
    expect(prompt).toContain("home, about");
    expect(prompt).toContain("meta.kitApiVersion: 1");
  });

  test("lists every open pin with its page slug and its exact text", () => {
    const context: AgentPromptContextV1 = {
      ...EMPTY_CONTEXT,
      activePageSlug: "home" as PageSlug,
      openPins: [{ pageSlug: "home" as PageSlug, text: "make this gauge red" }],
    };
    const prompt = buildSystemPrompt(context);
    expect(prompt).toContain("(home) make this gauge red");
  });

  test("says so honestly when no pins are open", () => {
    expect(buildSystemPrompt(EMPTY_CONTEXT)).toContain("No pins are currently open.");
  });

  test("still carries every static section (design-code rules, page-file layout, answer style)", () => {
    const prompt = buildSystemPrompt(EMPTY_CONTEXT);
    expect(prompt).toContain("^[a-z0-9][a-z0-9-]{0,31}$");
    expect(prompt).toContain("pages/<slug>.tsx");
    expect(prompt).toContain("bold, italic, inline code, and bullet lists");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/agent/prompt/model/system-prompt.test.ts`
Expected: FAIL — `./system-prompt` does not exist.

- [ ] **Step 3: Write the composer**

```ts
// src/agent/prompt/model/system-prompt.ts
import type { AgentPromptContextV1 } from "core/ports";

import { ANSWER_STYLE, DESIGN_CODE_RULES, PAGE_FILE_LAYOUT, ROLE } from "./prose";

/**
 * Renders the one part of the prompt that depends on THIS turn's own context — everything
 * else in `prose.ts` is process-wide static text. Every fact here traces to
 * `AgentPromptContextV1`'s own fixed shape (Task 1) — nothing invented.
 */
function renderContext(context: AgentPromptContextV1): string {
  const activeLine =
    context.activePageSlug === null
      ? "No page is currently active."
      : `The currently active page is "${context.activePageSlug}".`;
  const orderLine =
    context.pageOrder.length === 0
      ? "This project has no pages yet — the first one you create becomes active once " +
        "pages.json requests it."
      : `This project's pages, in portable order: ${context.pageOrder.join(", ")}.`;
  const kitApiLine =
    `Any page you create or rewrite must declare meta.kitApiVersion: ${context.kitApiVersion}.`;
  const pinsLines =
    context.openPins.length === 0
      ? "No pins are currently open."
      : [
          "Open pins the user placed on the currently active page — treat each as a " +
            "specific, located request:",
          ...context.openPins.map((pin) => `- (${pin.pageSlug}) ${pin.text}`),
        ].join("\n");
  return [activeLine, orderLine, kitApiLine, pinsLines].join("\n");
}

/** Composes the full system prompt: the static role/rules/layout/answer-style sections plus this turn's own honestly-held context. */
export function buildSystemPrompt(context: AgentPromptContextV1): string {
  return [ROLE, DESIGN_CODE_RULES, PAGE_FILE_LAYOUT, renderContext(context), ANSWER_STYLE].join(
    "\n\n",
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/agent/prompt/model/system-prompt.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/prompt/model/system-prompt.ts src/agent/prompt/model/system-prompt.test.ts
rtk git commit -m "feat(agent): compose the agent-prompt library's system prompt from context"
```

---

### Task 4: Materialize the runtime docs as real files

This task extends the already-landed `scripts/gen-runtime-dts.ts` (phase-8 Task 6) with one
more output artifact — a plain `.d.ts` file — and authors the hand-written guide. See "What
turned out not to be true about the brief" above for why a second generated artifact is needed
at all: `StagingRuntimeDocV1` needs a real `sourcePath` on disk, and today only the JS string
constant `RUNTIME_DTS` exists.

**Files:**
- Modify: `scripts/gen-runtime-dts.ts`
- Modify: `src/runtime/generated/runtime-dts.test.ts`
- Create: `src/agent/prompt/model/runtime-authoring-guide.md`
- Create: `src/agent/prompt/types.ts`
- Create: `src/agent/prompt/model/runtime-docs.ts`
- Create: `src/agent/prompt/model/runtime-docs.test.ts`

**Interfaces:**
- Consumes: nothing new (the generator already runs; `runtime-docs.ts` only computes paths and
  checks existence — no port, no `core` import).
- Produces: `src/runtime/generated/runtime.generated.d.ts` (a committed, generated artifact,
  mirroring `runtime-dts.ts`'s own convention); `buildRuntimeDocs(): readonly
  StagingRuntimeDocV1[]` — consumed by Task 5's factory.

- [ ] **Step 1: Extend the generator to also write a plain `.d.ts` file**

In `scripts/gen-runtime-dts.ts`, add a second output-path constant next to the existing
`OUT_FILE`:

```ts
const OUT_FILE = path.join(REPO_ROOT, "src/runtime/generated/runtime-dts.ts");
const DTS_OUT_FILE = path.join(REPO_ROOT, "src/runtime/generated/runtime.generated.d.ts");
```

Then, in `main()`, write it from the SAME `declaration` string the JS-wrapped constant is
already built from (this is the whole point: the two artifacts can never drift from each
other because they come from one generation run):

```ts
function main(): RuntimeDtsEmitError | null {
  const declaration = generate();
  if (declaration instanceof Error) return declaration;

  if (process.argv.includes("--stdout")) {
    process.stdout.write(declaration);
    return null;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, renderModule(declaration));
  // A second, plain-text artifact: the SAME declaration text as `RUNTIME_DTS` above, but as
  // an ordinary `.d.ts` file rather than a JS string constant. `RUNTIME_DTS` serves the
  // Gate's in-process `runtimeDts: string` parameter; this file serves the agent-prompt
  // library (phase-8 WP-3, `agent/prompt/model/runtime-docs.ts`), which stages a real,
  // human/agent-readable declaration file into the turn workspace BY PATH — "under npm these
  // are ordinary files inside the installed package" (phase-8 design §WP-3). Both are written
  // from the SAME `declaration` string in this one run, so they cannot drift from each other;
  // `runtime-dts.test.ts`'s own drift test pins that.
  fs.writeFileSync(DTS_OUT_FILE, declaration);
  console.log(`wrote ${OUT_FILE} (${String(declaration.length)} chars of declaration)`);
  console.log(`wrote ${DTS_OUT_FILE}`);
  return null;
}
```

- [ ] **Step 2: Write the failing companion-file test**

Add to `src/runtime/generated/runtime-dts.test.ts`, right after the existing "carries the page
contract..." test and before the `withPlatformTsc` drift check (this one needs no platform
package — it only compares two already-committed files):

```ts
test("the plain .d.ts companion file matches RUNTIME_DTS byte-for-byte (phase-8 WP-3)", () => {
  const companionPath = path.join(
    process.cwd(),
    "src/runtime/generated/runtime.generated.d.ts",
  );
  const companion = fs.readFileSync(companionPath, "utf8");
  expect(companion.trim()).toBe(RUNTIME_DTS.trim());
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bun test src/runtime/generated/runtime-dts.test.ts`
Expected: FAIL — `runtime.generated.d.ts` does not exist yet.

- [ ] **Step 4: Regenerate and verify the companion test passes**

Run: `bun run scripts/gen-runtime-dts.ts && bun test src/runtime/generated/runtime-dts.test.ts`
Expected: PASS. If the host lacks the per-platform `@typescript/typescript-<platform>-<arch>`
package, the fresh-emit drift check skips (existing behavior, unchanged) but this task's new
companion-file test still runs and passes, since it only compares two files already on disk.

- [ ] **Step 5: Write the authoring guide**

```markdown
# Authoring a termcraft page

A page is one TSX module. It imports only from `@termcraft/runtime` — see `runtime.d.ts`
alongside this file for the exact exported names and their types.

## Minimal shape

    import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"

    export const meta = definePage({
      kitApiVersion: 1,
      title: "Dashboard",
      minSize: { w: 80, h: 24 },
      theme: "dark-default",
    })

    export default reatomComponent(function Page() {
      return (
        <Panel id="root" title="Dashboard">
          <Text id="hello">Hello</Text>
        </Panel>
      )
    })

`meta` must be a plain object literal of constants — no computed values. Every visible
component needs a stable, unique `id`; selection, pins, and chat references all address the
design by id, and an id should survive edits across turns whenever the element itself
survives.

## State

Hold state in named Reatom atoms, computeds, and actions — not React hooks.
`reatomComponent` re-renders when the atoms it reads change. Keep helper models and
components in the same file as the page that uses them; pages never import each other.

## Layout and style

Layout is ordinary flexbox: `direction`, `grow`/`shrink`/`basis`, gaps, padding, and
alignment as style props on containers and primitives. `Row`/`Column` are flex-direction
presets; `Spacer` is `flexGrow: 1`. Colors come from the closed palette-token set
(`background`, `surface`, `text`, `text-muted`, `text-faint`, `border`, `primary`, `accent`,
`selection`, `ok`, `error`) — reach them through runtime context rather than raw hex values.

## What not to do

No timers or randomness outside animation guarded by the export flag — the first frame must
be deterministic. No imports beyond `@termcraft/runtime` — see `runtime.d.ts` and this
turn's system prompt for the exact allowlist.
```

Save as `src/agent/prompt/model/runtime-authoring-guide.md`.

- [ ] **Step 6: Write `agent/prompt/types.ts`**

```ts
// src/agent/prompt/types.ts

/** The two static runtime-doc source files this module ships, resolved once per process — `runtime-docs.ts`'s own local shape, not a `core/ports` type. */
export interface RuntimeDocSourcesV1 {
  readonly runtimeDeclarationPath: string;
  readonly authoringGuidePath: string;
}
```

- [ ] **Step 7: Write the failing runtime-docs test**

```ts
// src/agent/prompt/model/runtime-docs.test.ts
import { describe, expect, test } from "bun:test";
import fs from "node:fs";

import { buildRuntimeDocs } from "./runtime-docs";

describe("buildRuntimeDocs", () => {
  test("returns the runtime declaration and the authoring guide, flat at the workspace root", () => {
    const docs = buildRuntimeDocs();
    expect(docs.map((d) => d.relPath).sort()).toEqual(["RUNTIME.md", "runtime.d.ts"]);
  });

  test("every returned sourcePath resolves to a real file on disk", () => {
    for (const doc of buildRuntimeDocs()) {
      expect(fs.existsSync(doc.sourcePath)).toBe(true);
    }
  });
});
```

- [ ] **Step 8: Run it and watch it fail**

Run: `bun test src/agent/prompt/model/runtime-docs.test.ts`
Expected: FAIL — `./runtime-docs` does not exist.

- [ ] **Step 9: Write `runtime-docs.ts`**

```ts
// src/agent/prompt/model/runtime-docs.ts
import fs from "node:fs";
import path from "node:path";

import type { StagingRuntimeDocV1 } from "core/ports";

import type { RuntimeDocSourcesV1 } from "../types";

/**
 * `import.meta.dir` (Bun-specific, the same primitive `scripts/gen-runtime-dts.ts` already
 * uses) resolves to THIS file's own directory at runtime, whether the source tree is the
 * repository checkout or an npm-installed package — `package.json`'s `files: ["src", ...]`
 * (phase-8 WP-1) ships `src/` as one tree, so the relative layout between
 * `agent/prompt/model/` and `runtime/generated/` never changes. VERIFY-NOT-ASSUME: this is
 * proven here against the dev checkout (Step 10 below) and manually against `bun link`
 * (Step 11) — the full installed-package proof belongs to the parent plan's Task 5/Task 21
 * oracle (`src/entrypoint/model/installed-package.test.ts`), not a second one here.
 */
const MODULE_DIR = import.meta.dir;

const SOURCES: RuntimeDocSourcesV1 = {
  runtimeDeclarationPath: path.resolve(
    MODULE_DIR,
    "../../../runtime/generated/runtime.generated.d.ts",
  ),
  authoringGuidePath: path.resolve(MODULE_DIR, "runtime-authoring-guide.md"),
};

/** Logs (never throws — `runtimeDocs()` has no failure channel per its fixed `AgentPromptSource` signature) when a source file is unexpectedly missing, so a broken build is at least visible instead of silently staging a dangling path. */
function warnIfMissing(sourcePath: string): void {
  if (!fs.existsSync(sourcePath)) {
    console.warn(
      `agent/prompt: runtime doc source "${sourcePath}" does not exist — the turn workspace ` +
        "will be staged without it",
    );
  }
}

/** The runtime-doc file list `turn.start` stages into every turn workspace (phase-8 WP-3) — filenames match `store/safe-fs/model/limits.ts`'s own `classifyWorkspace` exactly (`RUNTIME.md`, any `*.d.ts` at the workspace root), not invented independently. */
export function buildRuntimeDocs(): readonly StagingRuntimeDocV1[] {
  warnIfMissing(SOURCES.runtimeDeclarationPath);
  warnIfMissing(SOURCES.authoringGuidePath);
  return [
    { relPath: "runtime.d.ts", sourcePath: SOURCES.runtimeDeclarationPath },
    { relPath: "RUNTIME.md", sourcePath: SOURCES.authoringGuidePath },
  ];
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `bun test src/agent/prompt/model/runtime-docs.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 11: Verify-not-assume — `bun link` path resolution**

Not a permanent test (see this task's Step 9 comment and the plan's "Known gaps" item 3): run
`bun link` in the repository root, then from a scratch directory run:

```bash
bun -e "console.log(require('node:path').resolve(require('node:path').dirname(require.resolve('termcraft/src/agent/prompt/model/runtime-docs.ts')), '../../../runtime/generated/runtime.generated.d.ts'))"
```

Expected: prints an absolute path that exists (verify with a follow-up `Test-Path`/`ls`). If
Bun's module resolution under `bun link` behaves differently from a plain relative-path
`import.meta.dir` read inside the actual module (e.g., a symlink is not transparently
followed the same way), record the discrepancy here in the plan's own "Known gaps" section
before proceeding — do not silently adjust the implementation without noting why.

- [ ] **Step 12: Commit**

```bash
rtk git add scripts/gen-runtime-dts.ts src/runtime/generated/runtime-dts.test.ts \
  src/agent/prompt/types.ts src/agent/prompt/model/runtime-docs.ts \
  src/agent/prompt/model/runtime-docs.test.ts src/agent/prompt/model/runtime-authoring-guide.md \
  src/runtime/generated/runtime.generated.d.ts
rtk git commit -m "feat(agent): materialize the runtime docs as real files (RUNTIME.md, runtime.d.ts)"
```

---

### Task 5: `agent/prompt/` — the production factory, module public entry, and the contract test

**Files:**
- Create: `src/agent/prompt/model/factory.ts`
- Create: `src/agent/prompt/model/factory.test.ts`
- Create: `src/agent/prompt/index.ts`
- Modify: `src/agent/index.ts`

**Interfaces:**
- Consumes: `buildSystemPrompt` (Task 3), `buildRuntimeDocs` (Task 4), `AgentPromptSource`
  (Task 1).
- Produces: `createProductionAgentPromptSource(): AgentPromptSource` — consumed by Task 8's
  composition-root wiring and Task 9's smoke test. This task's own test is the phase-8 Task 19
  Step 2 CONTRACT TEST.

- [ ] **Step 1: Write the failing contract test**

```ts
// src/agent/prompt/model/factory.test.ts
import { describe, expect, test } from "bun:test";

import type { AgentPromptContextV1 } from "core/ports";

import { createProductionAgentPromptSource } from "./factory";

const CONTEXT: AgentPromptContextV1 = {
  activePageSlug: null,
  pageOrder: [],
  kitApiVersion: 1,
  openPins: [],
};

describe("createProductionAgentPromptSource (phase-8 WP-3 contract test)", () => {
  test("the composed system prompt names the slug mask, the single permitted import, and the answer-style rule", () => {
    const prompt = createProductionAgentPromptSource().systemPrompt(CONTEXT);
    expect(prompt).toContain("^[a-z0-9][a-z0-9-]{0,31}$");
    expect(prompt).toContain('"@termcraft/runtime"');
    expect(prompt).toContain("markdown-lite");
  });

  test("runtimeDocs() names RUNTIME.md and runtime.d.ts, both resolving to real files", () => {
    const docs = createProductionAgentPromptSource().runtimeDocs();
    expect(docs.map((d) => d.relPath).sort()).toEqual(["RUNTIME.md", "runtime.d.ts"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/agent/prompt/model/factory.test.ts`
Expected: FAIL — `./factory` does not exist.

- [ ] **Step 3: Write the factory**

```ts
// src/agent/prompt/model/factory.ts
import type { AgentPromptContextV1, AgentPromptSource } from "core/ports";

import { buildRuntimeDocs } from "./runtime-docs";
import { buildSystemPrompt } from "./system-prompt";

/** The one production `AgentPromptSource` (phase-8 WP-3) — pure prose composition plus static file paths; no I/O beyond the existence checks `runtime-docs.ts` already performs. */
export function createProductionAgentPromptSource(): AgentPromptSource {
  return {
    systemPrompt: (context: AgentPromptContextV1) => buildSystemPrompt(context),
    runtimeDocs: () => buildRuntimeDocs(),
  };
}
```

- [ ] **Step 4: Write the module's public entry**

```ts
// src/agent/prompt/index.ts
export { createProductionAgentPromptSource } from "./model/factory";
export type { RuntimeDocSourcesV1 } from "./types";
```

- [ ] **Step 5: Re-export from `agent/index.ts`**

Add to `src/agent/index.ts`, alongside the existing `createProductionClaudeBackend`/
`createProductionAgentRegistry` re-exports:

```ts
export { createProductionAgentPromptSource } from "./prompt";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test src/agent/prompt`
Expected: PASS, every test across Tasks 2-5 (13 tests total: 6 + 5 + 2 + 2).

- [ ] **Step 7: Typecheck**

Run: `bun x tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
rtk git add src/agent/prompt/model/factory.ts src/agent/prompt/model/factory.test.ts \
  src/agent/prompt/index.ts src/agent/index.ts
rtk git commit -m "feat(agent): the agent-prompt library's production factory and public entry"
```

---

### Task 6: Thread `AgentPromptSource` through `KernelDeps` and every fixture

**Files:**
- Modify: `src/core/kernel/types.ts`
- Create: `src/core/ports/fakes/agent-prompt.ts`
- Create: `src/core/ports/fakes/agent-prompt.test.ts`
- Modify: `src/core/ports/fakes/index.ts`
- Modify (add the field to each fixture builder's `KernelDeps` literal):
  `src/core/kernel/model/handlers/chat.test.ts:212-213`,
  `src/core/kernel/model/handlers/deferred.test.ts` (inside `buildDeps()`, before its `clock,`
  line),
  `src/core/kernel/model/handlers/index.test.ts` (inside `buildDeps()`, before its `clock,`
  line),
  `src/core/kernel/model/handlers/page-pin.test.ts:142-143`,
  `src/core/kernel/model/handlers/preview-export.test.ts` (inside `buildDeps()`, before its
  `diagnosticsCache:`/`clock,` tail — read the function's current body first, since it takes
  `overrides` unlike the others),
  `src/core/kernel/model/handlers/project.test.ts:210-211`,
  `src/core/kernel/model/handlers/selection-model.test.ts:143-146`,
  `src/core/kernel/model/handlers/turn.test.ts:221-224`,
  `src/core/kernel/model/kernel.test.ts:289-290`,
  `src/core/kernel/model/kernel.integration.test.ts:54-55` (inside `buildDeps`'s `return {`
  body),
  `src/core/kernel/model/chat-relaunch.integration.test.ts:195-196`.

**Interfaces:**
- Consumes: `AgentPromptSource` (Task 1).
- Produces: `KernelDeps.agentPromptSource: AgentPromptSource` — consumed by Task 7's `turn.ts`.
  `createFakeAgentPromptSource(options?): FakeAgentPromptSource` — consumed by Task 7's own new
  test.

This task's "test" IS the compiler: `KernelDeps.agentPromptSource` becomes a required field, so
every one of the 11 fixture-builder files above fails `bun x tsc --noEmit` the moment the field
is added to the type — exactly the same shape phase-8 Task 8 already established for
`BackendCapabilities.defaultSelection` (see `turn.test.ts:144-147`'s own comment: "required now
that `BackendCapabilities.defaultSelection` is non-optional"). This is a genuine, intentional
divergence from strict TDD's usual "write a failing runtime test first": there is no runtime
behavior to test yet (nothing reads the new field until Task 7), only a type-level obligation.

- [ ] **Step 1: Write the failing fake test**

```ts
// src/core/ports/fakes/agent-prompt.test.ts
import { describe, expect, test } from "bun:test";

import type { AgentPromptContextV1 } from "../agent-prompt";
import { createFakeAgentPromptSource } from "./agent-prompt";

const CONTEXT: AgentPromptContextV1 = {
  activePageSlug: null,
  pageOrder: [],
  kitApiVersion: 1,
  openPins: [],
};

describe("createFakeAgentPromptSource", () => {
  test("records every systemPrompt/runtimeDocs call, in order", () => {
    const fake = createFakeAgentPromptSource();
    fake.runtimeDocs();
    fake.systemPrompt(CONTEXT);
    expect(fake.calls).toEqual([
      { method: "runtimeDocs" },
      { method: "systemPrompt", context: CONTEXT },
    ]);
  });

  test("defaults runtimeDocs() to an honest empty list", () => {
    expect(createFakeAgentPromptSource().runtimeDocs()).toEqual([]);
  });

  test("is programmable: a caller-supplied systemPromptText/runtimeDocs override the defaults", () => {
    const docs = [{ relPath: "RUNTIME.md", sourcePath: "/fake/RUNTIME.md" }];
    const fake = createFakeAgentPromptSource({
      systemPromptText: () => "custom prompt",
      runtimeDocs: docs,
    });
    expect(fake.systemPrompt(CONTEXT)).toBe("custom prompt");
    expect(fake.runtimeDocs()).toEqual(docs);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/ports/fakes/agent-prompt.test.ts`
Expected: FAIL — `./agent-prompt` does not exist.

- [ ] **Step 3: Write the fake**

```ts
// src/core/ports/fakes/agent-prompt.ts
import type { AgentPromptContextV1, AgentPromptSource } from "../agent-prompt";
import type { AssertConforms } from "../index";
import type { StagingRuntimeDocV1 } from "../staging";

/**
 * In-memory {@link AgentPromptSource} fake, matching every other `core/ports/fakes/` entry's
 * shape (INSPECTABLE `calls` log, PROGRAMMABLE via constructor options). No `failNext`: the
 * real port has no failure channel to model (`systemPrompt`/`runtimeDocs` are both
 * synchronous, `string`/`readonly StagingRuntimeDocV1[]`-returning, never `FailureDtoV1`).
 */

export type AgentPromptSourceCall =
  | { readonly method: "systemPrompt"; readonly context: AgentPromptContextV1 }
  | { readonly method: "runtimeDocs" };

export interface FakeAgentPromptSource extends AgentPromptSource {
  readonly calls: readonly AgentPromptSourceCall[];
}

export function createFakeAgentPromptSource(options?: {
  readonly systemPromptText?: (context: AgentPromptContextV1) => string;
  readonly runtimeDocs?: readonly StagingRuntimeDocV1[];
}): FakeAgentPromptSource {
  const calls: AgentPromptSourceCall[] = [];
  const renderSystemPrompt =
    options?.systemPromptText ?? ((context) => `fake-system-prompt:${JSON.stringify(context)}`);
  const docs = options?.runtimeDocs ?? [];

  function systemPrompt(context: AgentPromptContextV1): string {
    calls.push({ method: "systemPrompt", context });
    return renderSystemPrompt(context);
  }

  function runtimeDocs(): readonly StagingRuntimeDocV1[] {
    calls.push({ method: "runtimeDocs" });
    return docs;
  }

  return { systemPrompt, runtimeDocs, calls };
}

type _Conforms = AssertConforms<AgentPromptSource, FakeAgentPromptSource>;
```

- [ ] **Step 4: Export it from `core/ports/fakes/index.ts`**

Insert after the existing `FakeAgentBackend`/`createFakeAgentBackend` export block:

```ts
export type { AgentPromptSourceCall, FakeAgentPromptSource } from "./agent-prompt";
export { createFakeAgentPromptSource } from "./agent-prompt";
```

- [ ] **Step 5: Run the fake's own test**

Run: `bun test src/core/ports/fakes/agent-prompt.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Add the field to `KernelDeps`**

In `src/core/kernel/types.ts`, add `AgentPromptSource` to the existing `import type { ... }
from "core/ports";` list, then add the field right after `agentRegistry: AgentRegistry;` and
before `clock: Clock;`:

```ts
  /**
   * The agent-prompt library's composed system prompt and runtime-doc file list (phase-8
   * WP-3) — `turn.start` (`handlers/turn.ts`) is the one caller. Declared in `core/ports/
   * agent-prompt.ts`; implemented by `agent/prompt/` (static prose plus paths into the
   * installed package, no I/O beyond an existence check).
   */
  readonly agentPromptSource: AgentPromptSource;
```

- [ ] **Step 7: Confirm the compiler fails everywhere this field is now missing**

Run: `bun x tsc --noEmit`
Expected: FAIL — one "Property 'agentPromptSource' is missing" diagnostic per fixture-builder
file listed in this task's **Files** section, plus `src/entrypoint/model/create-shell.ts` and
`src/entrypoint/model/smoke.test.ts` (both deferred to Tasks 8/9). Read the full diagnostic
list before editing — it is the authoritative inventory of every site this task must touch,
more reliable than the file list above if the tree has moved since this plan was written.

- [ ] **Step 8: Add `agentPromptSource: createFakeAgentPromptSource(),` to every listed test file**

For each of the 11 files in this task's **Files** section: add
`createFakeAgentPromptSource` to its existing `from "core/ports/fakes"` import list, and add
one line, `agentPromptSource: createFakeAgentPromptSource(),`, to the `KernelDeps` object
literal — immediately before that file's own `clock`/`clock: makeClock(...)`/`clock,` line
(every file in this list follows that exact tail shape; `kernel.integration.test.ts` differs
only in that its `buildDeps` takes `agentRegistry`/other values as explicit parameters rather
than constructing fakes inline — the new line still goes immediately before its own `clock:
makeClock(...)` line inside the returned object).

- [ ] **Step 9: Run the affected test suites**

Run: `bun test src/core/kernel src/core/ports/fakes`
Expected: PASS — no behavior changed yet (the field exists and is threaded, but nothing reads
it until Task 7).

- [ ] **Step 10: Typecheck**

Run: `bun x tsc --noEmit`
Expected: still FAILS — `src/entrypoint/model/create-shell.ts` and `src/entrypoint/model/
smoke.test.ts` are deliberately left unfixed until Tasks 8/9, which wire the REAL production
factory there rather than a fake. Confirm the ONLY remaining diagnostics name those two files.

- [ ] **Step 11: Commit**

```bash
rtk git add src/core/kernel/types.ts src/core/ports/fakes/agent-prompt.ts \
  src/core/ports/fakes/agent-prompt.test.ts src/core/ports/fakes/index.ts \
  src/core/kernel/model/handlers/chat.test.ts src/core/kernel/model/handlers/deferred.test.ts \
  src/core/kernel/model/handlers/index.test.ts src/core/kernel/model/handlers/page-pin.test.ts \
  src/core/kernel/model/handlers/preview-export.test.ts \
  src/core/kernel/model/handlers/project.test.ts \
  src/core/kernel/model/handlers/selection-model.test.ts \
  src/core/kernel/model/handlers/turn.test.ts src/core/kernel/model/kernel.test.ts \
  src/core/kernel/model/kernel.integration.test.ts \
  src/core/kernel/model/chat-relaunch.integration.test.ts
rtk git commit -m "feat(core): thread AgentPromptSource through KernelDeps and its fixtures"
```

---

### Task 7: Wire `turn.ts`'s `runTurnStart` to the real prompt source

**Files:**
- Modify: `src/core/kernel/model/handlers/turn.ts`

**Interfaces:**
- Consumes: `context.deps.agentPromptSource: AgentPromptSource` (Task 6),
  `context.deps.exportRender.runtimeDeclaration.currentKitApiVersion: number`
  (`core/ports/export-render.ts`, already wired — no new port call).
- Produces: `baseTask.systemPrompt` and `admission.workspace.runtimeDocs` are now real.

**`kitApiVersion` sourcing — verified, not assumed.** `AgentPromptContextV1.kitApiVersion` was
NOT specified by the parent plan's fixed interfaces beyond its type (`number`). Investigation:
`core` cannot import `runtime`'s `CURRENT_KIT_API_VERSION` (module DAG: `core` imports only
`entities/` + its own `ports/`), and no page-scoped source is right for "the version NEW pages
should declare" (that is a process-wide constant, not per-page metadata). `core/ports/
export-render.ts:18-23` already declares a narrow, core-owned `RuntimeDeclarationBundleV1`
with `currentKitApiVersion: number`, and `ExportRenderPort.runtimeDeclaration:
RuntimeDeclarationBundleV1` is already a field `KernelDeps.exportRender` exposes. Confirmed the
real adapter is wired with the genuine value: `entrypoint/model/create-shell.ts:171-176`
constructs `exportRender: createExportRenderAdapter({ ..., runtimeDeclaration:
EMBEDDED_RUNTIME_DECLARATION })`, and `host/adapters/export-render.ts:154` returns `{
poolBounds, runtimeDeclaration, renderOne }` — a straight passthrough of the SAME
`EMBEDDED_RUNTIME_DECLARATION.currentKitApiVersion` (`host/protocol/model/
embedded-declaration.ts:36`, itself sourced from `runtime`'s own `CURRENT_KIT_API_VERSION`).
So `context.deps.exportRender.runtimeDeclaration.currentKitApiVersion` is the honest,
already-composed value — no new `KernelDeps` field, no new port call.

- [ ] **Step 1: Write the failing test**

Add to `src/core/kernel/model/handlers/turn.test.ts`, as a sibling to the existing
`"readSet.pins: an OPEN pin ..."` test (around line 624) — reuse its exact fixture recipe
(`withHonestChatAppendBase`, the same `buildTestContext` helper, the same
`waitForPublishedCount` pattern) rather than inventing a second one:

```ts
  test("turn.start builds the real AgentPromptContextV1 and sends the agent-prompt library's composed system prompt and runtime docs — not the placeholder, not an honest empty (phase-8 WP-3)", async () => {
    const HOME = "home" as PageSlug;
    const ABOUT = "about" as PageSlug;
    const OPEN_PIN_ID = "pin-open";

    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const pinStore = createFakePinStore();
    await pinStore.appendStandaloneEvent(HOME, {
      kind: "pin:created",
      recordId: "r1",
      pinId: OPEN_PIN_ID,
      element: "btn-1",
      fx: 0.5,
      fy: 0.5,
      text: "make this gauge red",
      ts: "2024-01-01T00:00:00.000Z",
    });

    const pageStore = createFakePageStore({
      order: [HOME, ABOUT],
      sources: new Map([
        [
          HOME,
          { sourceHash: "a".repeat(64) as Sha256Hex, bytes: new TextEncoder().encode("home") },
        ],
        [
          ABOUT,
          { sourceHash: "b".repeat(64) as Sha256Hex, bytes: new TextEncoder().encode("about") },
        ],
      ]),
    });

    const staging = createFakeStagingService();
    const turnTransactions = withHonestChatAppendBase(
      createFakeTurnTransactionService(),
      chatStore,
    );
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const fakePrompts = createFakeAgentPromptSource({
      systemPromptText: () => "the composed system prompt",
      runtimeDocs: [{ relPath: "RUNTIME.md", sourcePath: "/fake/RUNTIME.md" }],
    });

    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions,
      pinReader: pinStore,
      pinMutations: pinStore,
      pageReader: pageStore,
      staging,
      agentPromptSource: fakePrompts,
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          backend: "claude",
          model: "sonnet",
          effort: "medium",
          activeChatId: chatHeader.chatId,
          activePageSlug: HOME,
        },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    const outcome = turnHandlers["turn.start"]({ text: "make this gauge red" }, handlerContext);
    expect(outcome).toEqual({ disposition: "started", events: [] });

    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const runPromise = operation.run();

    async function waitForPublishedCount(kind: string, count: number): Promise<void> {
      for (let i = 0; i < 200; i++) {
        if (getPublishedEvents().filter((e) => e.kind === kind).length >= count) return;
        await wrap(Bun.sleep(0));
      }
      throw new Error(`waitForPublishedCount: never observed ${count} "${kind}" event(s)`);
    }

    await waitForPublishedCount("turn.attemptStarted", 1);
    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });

    const events = await runPromise;
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("turn.completed");

    // The prompt library was called with the honest AgentPromptContextV1 this handler holds.
    const promptCall = fakePrompts.calls.find((c) => c.method === "systemPrompt");
    if (promptCall?.method !== "systemPrompt") throw new Error("expected a systemPrompt call");
    expect(promptCall.context).toEqual({
      activePageSlug: HOME,
      pageOrder: [HOME, ABOUT],
      kitApiVersion: 1,
      openPins: [{ pageSlug: HOME, text: "make this gauge red" }],
    });
    expect(fakePrompts.calls.some((c) => c.method === "runtimeDocs")).toBe(true);

    // The fake's own runtimeDocs() return value reached the staged workspace input verbatim.
    const createCall = staging.calls.find((c) => c.method === "createTurnWorkspace");
    if (createCall?.method !== "createTurnWorkspace") {
      throw new Error("expected a createTurnWorkspace call");
    }
    expect(createCall.input.runtimeDocs).toEqual([
      { relPath: "RUNTIME.md", sourcePath: "/fake/RUNTIME.md" },
    ]);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/kernel/model/handlers/turn.test.ts`
Expected: FAIL — `promptCall` is `undefined` (`agentPromptSource.systemPrompt` is never
called yet), and `createCall.input.runtimeDocs` is `[]`.

- [ ] **Step 3: Build the prompt context and thread it through**

In `turn.ts`, add `AgentPromptContextV1` to the existing `import type { ... } from
"core/ports";` list. Declare the open-pins accumulator beside the existing `candidatePins`
declaration (both inside the same `if (activePageSlug !== null)` block's loop — never a second
port call):

```ts
  const candidatePins: AdmissionCandidatePinV1[] = [];
  const openPinsForPrompt: { pageSlug: PageSlug; text: string }[] = [];
  const readSetPins: { pageSlug: PageSlug; base: ReadSetAppendBaseV1 }[] = [];
  if (activePageSlug !== null) {
    const pins = await wrap(context.deps.pinReader.fold(activePageSlug));
    if ("code" in pins) {
      console.warn(
        `core/kernel/handlers/turn: turn.start refused — could not fold pins for active page "${activePageSlug}": ${pins.safeMessage}`,
      );
      return [];
    }
    for (const pin of pins) {
      if (pin.status !== "open") continue;
      candidatePins.push({ pageSlug: activePageSlug, pinId: pin.pinId });
      openPinsForPrompt.push({ pageSlug: activePageSlug, text: pin.text });
    }
    // ... the existing readSetPins block, unchanged ...
  }
```

Right before `baseTask` is built, construct the context and call the port:

```ts
  const promptContext: AgentPromptContextV1 = {
    activePageSlug,
    pageOrder: pageSlugs,
    kitApiVersion: context.deps.exportRender.runtimeDeclaration.currentKitApiVersion,
    openPins: openPinsForPrompt,
  };
```

- [ ] **Step 4: Replace the two placeholders**

Change `baseTask`'s `systemPrompt` field:

```ts
  const baseTask: Omit<AgentTask, "fence"> = {
    workspacePath: "/unset", // always overridden by runTurn from the minted turn workspace
    systemPrompt: context.deps.agentPromptSource.systemPrompt(promptContext),
    userMessage: payload.text,
    model: resolvedAgent.model,
    effort: resolvedAgent.effort,
    session: sessionPlan,
  };
```

Change `admission.workspace.runtimeDocs`:

```ts
    workspace: {
      pages,
      manifestSlice,
      runtimeDocs: context.deps.agentPromptSource.runtimeDocs(),
      readSet: {
        manifest: manifestSnapshot,
        canonicalPages,
        pins: readSetPins,
      },
    },
```

- [ ] **Step 5: Remove the now-dead placeholder constant**

Delete the `TURN_START_SYSTEM_PROMPT_PLACEHOLDER` declaration and its own doc comment
(currently lines 318-324).

- [ ] **Step 6: Rewrite the two stale header paragraphs**

Replace the `runtimeDocs: []` paragraph in the file's header (documenting it as "an honest
empty value, not a fabrication"):

```
 *   `runtimeDocs`: NOW REAL (phase-8 WP-3) — `context.deps.agentPromptSource.runtimeDocs()`
 *   (`core/ports/agent-prompt.ts`, implemented by `agent/prompt/`) returns the two files
 *   staged alongside `pages/`/`pages.json`: `runtime.d.ts` (the generated `@termcraft/runtime`
 *   ambient declaration, `runtime/generated/runtime.generated.d.ts`) and `RUNTIME.md` (the
 *   hand-authored guide). Both are ordinary files inside the installed package — under npm
 *   there is no startup staging step, only a path (phase-8 design §WP-3).
```

Replace the `baseTask.systemPrompt` paragraph:

```
 *   `baseTask.systemPrompt`: NOW REAL (phase-8 WP-3) — `context.deps.agentPromptSource
 *   .systemPrompt(promptContext)`, where `promptContext: AgentPromptContextV1` is built just
 *   above from facts this handler already holds honestly: `activePageSlug`/`pageSlugs` (the
 *   SAME `WorkspaceStateV1.activePageSlug` and `pageReader.listSlugs()` result the manifest
 *   slice above already reads), `kitApiVersion` from `context.deps.exportRender
 *   .runtimeDeclaration.currentKitApiVersion` (the SAME already-wired constant
 *   `ExportRenderPort` carries — no new `KernelDeps` field needed), and `openPins` folded in
 *   the SAME loop that builds `candidatePins` just above, from the SAME `PinReader.fold`
 *   result — never a second port call, never a fabricated pin text. `agent/prompt/`
 *   (implementing `core/ports/agent-prompt.ts`) owns the prose: role, §5.8's design-code
 *   rules including the slug mask, the page-file layout, and answer-style guidance — `core`
 *   imports only the port, never `agent/prompt/` itself. NOTE: `agent/session/model/
 *   prompt.ts`'s `buildPrompt` is a DIFFERENT function entirely — it composes the per-attempt
 *   USER message (a resume delta, or the fresh-session seed transcript), never the system
 *   prompt; the two were never in conflict.
```

- [ ] **Step 7: Run the test suite**

Run: `bun test src/core/kernel/model/handlers/turn.test.ts`
Expected: PASS, including the new test.

- [ ] **Step 8: Run the full kernel suite and typecheck**

Run: `bun test src/core/kernel && bun x tsc --noEmit`
Expected: PASS, exit 0 (both should now be clean — Task 6 Step 10 left `turn.ts`'s own
compile untouched; this step re-checks after the real wiring lands, though `entrypoint/`
remains red until Task 8).

- [ ] **Step 9: Commit**

```bash
rtk git add src/core/kernel/model/handlers/turn.ts src/core/kernel/model/handlers/turn.test.ts
rtk git commit -m "feat(core): wire turn.start to the real agent-prompt library, not the placeholder"
```

---

### Task 8: Composition-root wiring

**Files:**
- Modify: `src/entrypoint/model/create-shell.ts`

**Interfaces:**
- Consumes: `createProductionAgentPromptSource` (Task 5).
- Produces: a fully-composed, real `KernelDeps.agentPromptSource` in the shipped `interactive`
  shell.

- [ ] **Step 1: Add the import**

In `create-shell.ts`, extend the existing `import { createProductionAgentRegistry } from
"agent";` line:

```ts
import { createProductionAgentPromptSource, createProductionAgentRegistry } from "agent";
```

- [ ] **Step 2: Wire it into `kernelDeps`**

In `interactiveShell`'s `kernelDeps` object literal, add the field beside `agentRegistry`:

```ts
    agentRegistry: createProductionAgentRegistry(),
    agentPromptSource: createProductionAgentPromptSource(),
    clock: systemClock,
```

- [ ] **Step 3: Typecheck**

Run: `bun x tsc --noEmit`
Expected: exit 0 — the last diagnostic from Task 6 Step 10 (`create-shell.ts` missing the
field) is now resolved. `entrypoint/model/smoke.test.ts` is still red; that is Task 9.

- [ ] **Step 4: Run the entrypoint's non-smoke tests**

Run: `bun test src/entrypoint/model/create-shell.test.ts`
Expected: PASS — this file builds no raw `KernelDeps` literal of its own (confirmed: it only
calls `createShell(...)` and imports the type), so no fixture edit was needed here; this step
only confirms the real wiring above did not regress shell construction.

- [ ] **Step 5: Commit**

```bash
rtk git add src/entrypoint/model/create-shell.ts
rtk git commit -m "feat(entrypoint): wire the real agent-prompt library into the composed shell"
```

---

### Task 9: Smoke-test acceptance — runtime docs physically present in the turn workspace

**Files:**
- Modify: `src/entrypoint/model/smoke.test.ts`

**Interfaces:**
- Consumes: `createProductionAgentPromptSource` (Task 5).
- Produces: the phase-8 Task 19 Step 2 SMOKE-TEST acceptance oracle.

This is deliberately the REAL production factory, not a fake — the whole point of this
assertion is proving the two runtime-doc files land on disk through the REAL `store` staging
adapter, which is exactly what this smoke test already composes for everything else (see the
file's own header: "REAL: `store` ... `gate` ... `core`'s real `createKernel`").

- [ ] **Step 1: Add the import**

Add a new import to `smoke.test.ts` (it currently imports nothing from `agent`):

```ts
import { createProductionAgentPromptSource } from "agent";
```

- [ ] **Step 2: Wire it into `composeRealShell`'s `kernelDeps`**

In the `kernelDeps: KernelDeps = { ... }` literal (currently ending `exportPublish:
createExportPublishAdapter(storeAdapterDeps), agentRegistry: createFakeAgentRegistry([agentBackend]),
clock: systemClock,`), add the field before `clock`:

```ts
    exportPublish: createExportPublishAdapter(storeAdapterDeps),
    agentRegistry: createFakeAgentRegistry([agentBackend]),
    agentPromptSource: createProductionAgentPromptSource(),
    clock: systemClock,
```

- [ ] **Step 3: Write the failing acceptance assertion**

In the test body, right after the existing:

```ts
      const workspacePath = agentBackend.lastWorkspacePath();
      if (workspacePath === null) throw new Error("fixture bug: no workspace path captured");
```

insert:

```ts
      // phase-8 WP-3 acceptance: the runtime docs the agent-prompt library returns are
      // PHYSICALLY staged into the real turn workspace by the time the first attempt starts
      // — proven here against the REAL `store` staging adapter and the REAL
      // `createProductionAgentPromptSource()`, not a fake.
      expect(fs.existsSync(path.join(workspacePath, "RUNTIME.md"))).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, "runtime.d.ts"))).toBe(true);
```

(`fs`/`path` are already imported at the top of this file.)

- [ ] **Step 4: Run it and watch it fail for the right reason**

Run: `bun test src/entrypoint/model/smoke.test.ts`
Expected: FAIL before Step 2's wiring lands (`KernelDeps` missing `agentPromptSource` —
`tsc`/runtime error); after Step 2 lands but before this task existed at all, the two new
`expect(fs.existsSync(...))` assertions would have failed because nothing staged those files
— confirm the failure is specifically the `existsSync` assertions if you run the steps out of
order for verification purposes; in the prescribed order, Steps 1-2 land together with Step 3
so there is no intermediate red state to observe here beyond the initial "field missing"
compile failure already covered by Task 6/Task 8.

- [ ] **Step 5: Run it and verify it passes**

Run: `bun test src/entrypoint/model/smoke.test.ts`
Expected: PASS. This is a slower, real-process-free but real-disk integration test; give it
the file's own existing timeout budget (no new timeout needed — the two `existsSync` checks
are synchronous and add no wait).

- [ ] **Step 6: Typecheck the whole tree**

Run: `bun x tsc --noEmit`
Expected: exit 0 — every site Task 6 Step 7 originally flagged as missing the field is now
resolved (11 test fixtures in Task 6, `create-shell.ts` in Task 8, `smoke.test.ts` here).

- [ ] **Step 7: Commit**

```bash
rtk git add src/entrypoint/model/smoke.test.ts
rtk git commit -m "test(entrypoint): prove the runtime docs are physically staged into the turn workspace"
```

---

### Task 10: Architecture-doc anchors this change touches

**Files:**
- Modify: `docs/architecture/code-structure.md`

This is a scoped update to the anchors THIS change creates, not the full sweep — the parent
plan's Task 21 owns the comprehensive `docs/architecture/` Source-anchor re-run.

- [ ] **Step 1: Add the port to the "Ports and the composition boundary" bullet list**

In the section starting `**Ports and the composition boundary (items 4, 5, 7, 9, 10)**`
(currently line 498), add a new bullet:

```
- `src/core/ports/agent-prompt.ts` — `AgentPromptContextV1`/`AgentPromptSource` (phase-8
  WP-3): `core` declares the port, `agent/prompt/` implements it, mirroring the
  `AgentBackend`/`GateRunner` placement precedent this section already documents
```

- [ ] **Step 2: Add the module to the "`agent/` and the shared-vs-vendor split" bullet list**

In the section starting `**\`agent/\` and the shared-vs-vendor split (items 1, 5, 8)**`
(currently line 374), immediately after the existing `src/agent/session/model/prompt.ts`
bullet (currently line 402), add:

```
- `src/agent/prompt/index.ts` — the agent-prompt library (phase-8 WP-3):
  `createProductionAgentPromptSource`, implementing `core/ports/agent-prompt.ts`'s
  `AgentPromptSource`. Composes the turn's SYSTEM prompt (role, §5.8 design-code rules
  including the slug mask, the page-file layout, answer-style guidance, plus the live
  `AgentPromptContextV1`) and returns the two runtime-doc files (`RUNTIME.md`,
  `runtime.d.ts`) as paths into the installed package. Distinct from, and does not
  replace, `agent/session/model/prompt.ts` above — that file composes the per-attempt
  USER message; this one composes the SYSTEM prompt
```

- [ ] **Step 3: Verify the edits render sensibly**

Run: `rtk read docs/architecture/code-structure.md` (or open it) and confirm both bullets sit
naturally inside their surrounding lists, matching the existing bullet style (one dash, wrapped
prose, no trailing period inconsistency with neighbors).

- [ ] **Step 4: Commit**

```bash
rtk git add docs/architecture/code-structure.md
rtk git commit -m "docs(architecture): anchor the agent-prompt library (phase-8 WP-3)"
```

---

### Task 11: Close the sub-plan

- [ ] **Step 1: Run every gate fresh**

```bash
bun test
bun x tsc --noEmit
rtk npm run lint
rtk npm run fmt:check
```
Expected: 0 failures, exit 0 for each.

- [ ] **Step 2: Verify the phase-8 Task 19 acceptance criteria explicitly**

- The contract test (Task 5 Step 1, `src/agent/prompt/model/factory.test.ts`) asserts the
  composed system prompt names the slug mask, the single permitted import, and the
  answer-style rule: confirm it is present and passing.
- The smoke-test assertion (Task 9 Step 3, `src/entrypoint/model/smoke.test.ts`) asserts the
  runtime docs are physically present in the turn workspace: confirm it is present and
  passing.

- [ ] **Step 3: Re-read the "Known gaps" section above and confirm nothing was silently closed**

Outstanding diagnostics into the SYSTEM prompt, source-extracted per-page metadata, and the
current selection remain out of scope, exactly as recorded — this step is a final check that
no implementation step quietly widened `AgentPromptContextV1` to paper over one of them without
updating this plan's own record of the decision.

- [ ] **Step 4: Commit**

```bash
rtk git add docs/superpowers/plans/2026-07-25-agent-prompt-library.md
rtk git commit -m "docs: close the phase-8 WP-3 agent-prompt-library sub-plan"
```

---

## Self-review notes

**Spec coverage.** Parent plan Task 19 Step 1's required scope: the port declaration (Task 1);
the `agent/prompt/` module in `model/` + `types.ts` + `index.ts` shape (Tasks 2-5); the prose
content for role/design-code rules/slug mask verbatim/single permitted import/timer-randomness
ban/page-file layout/answer-style (Tasks 2-3); the runtime docs list combining `RUNTIME_DTS`
with an authoring guide (Task 4); replacing `TURN_START_SYSTEM_PROMPT_PLACEHOLDER` and
`runtimeDocs: []` (Task 7); the composition-root wiring (Task 8). Step 2's acceptance: the
contract test (Task 5) and the smoke-test assertion (Task 9).

**Known softness, stated rather than hidden.** Task 6's fixture-builder updates (Step 8) are
described by pattern (11 files, one line each, before the existing `clock` field) rather than
individually transcribed in full, because transcribing 11 near-identical multi-hundred-line
test files here would dwarf the plan without adding information beyond what Step 7's compiler
diagnostic list already gives the implementer authoritatively. Task 4 Step 11's `bun link`
check is manual, not a permanent test — see "Known gaps" item 3 for why the full installed-
package proof is deliberately left to the parent plan's own Task 5/Task 21 oracle. Task 9 Step
4's "watch it fail" description is looser than usual because this task's steps are ordered to
land together (wiring plus assertion in the same task), so there is no clean single intermediate
red state to describe beyond the compile failure Tasks 6/8 already produce and resolve.

**Type consistency check.** `AgentPromptContextV1`/`AgentPromptSource` (Task 1) are used
identically in Tasks 3, 5, 6, and 7 — same field names, same optionality. `buildSystemPrompt`
(Task 3) and `buildRuntimeDocs` (Task 4) are composed, unchanged, inside `createProduction
AgentPromptSource` (Task 5). `KernelDeps.agentPromptSource` (Task 6) is read exactly once, in
Task 7, as `context.deps.agentPromptSource`. `RUNTIME.md`/`runtime.d.ts` as `relPath` values
appear identically in Task 2's prose test, Task 4's generator/docs/test, Task 5's contract
test, Task 7's turn.test.ts fixture, and Task 9's smoke-test assertion — verified against the
real `store/safe-fs/model/limits.ts` classifier, not merely internally consistent.
