# Red-window debt ledger (tracked copy)

**Provenance.** This file is promoted from the git-ignored workspace ledger at
`.superpowers/sdd/2026-07-28-design-tree-canonical-source/red-debt.md`
(`.gitignore:1` excludes `/.superpowers/`), by Task 11 of
`docs/superpowers/plans/2026-08-02-design-tree-phase-1-closeout.md` — operator ruling 3 of that
plan's own progress ledger. Without this file the entire closeout — which rows closed, by what
evidence, and which rows are still open — would disappear the moment the workspace is cleaned,
since the workspace copy is never committed. Rows still open carry their evidence in BOTH this file
and the workspace original; this file is the durable one. Future updates to either copy should keep
them in sync, but if they drift, this tracked copy is the one to trust.

Everything below this notice is the ledger itself, reproduced verbatim from the workspace copy as
it stood at the end of design-tree-phase-1-closeout (commit range `1cc6431..d57c2a3`).

## READ THIS BEFORE THE LEDGER: it is a HISTORICAL record, not a description of HEAD

Everything below the horizontal rule was written DURING plan 1's red window and during this
closeout, and much of it is phrased in the present tense about a state that no longer exists. It is
kept unedited because a debt ledger's value is its record of how things actually were — but nothing
below may be read as a live claim about HEAD without checking it first. The final whole-plan review
(recorded in the closeout's `progress.md`) found six such stale claims; these are the ones most
likely to mislead:

- **"Every currently-failing test…", "82 tsc errors, 73 test failures"** (the section head below,
  and the Task 6/7/9 owner lists) — describes plan 1's red window. **At HEAD the suite is 4376 pass
  / 2 skip / 0 fail across 364 files and `bun x tsc --noEmit` prints nothing.** The red window is
  closed; this plan's own acceptance bar was real green throughout.
- **"the Gate is currently not enforcing its own security perimeter"** — the loudest sentence in
  this file, and **false at HEAD**. `runTreeImports` has production callers; see
  `core/kernel/model/handlers/preview-export.ts:1396` and `core/turns/model/validation.ts`. It was
  true when written, between the scan moving out of `runGate` and Task 13/14 wiring the new caller.
- **The "temporary scaffolding that MUST be deleted" row** — `core/ports/fakes/legacy-page-store.ts`
  no longer exists and `DesignTreeStoreNotWiredError` has zero matches in `src/`. (One stale prose
  reference to that deleted file survives at `store/types.ts:223`; it is a comment, not code.)
- **The `NO_TREE_CONTEXT` / "FLAGGED FOR TASK 12" row** — zero matches in `src/`;
  `entities/design-tree/model/manifest.ts:69-74` already drops numeric segments.

**State at HEAD (`258a32e`, branch `design-tree`):** plan 1 and the phase-1 closeout are both
landed, 11 of 11 tasks. The rows this closeout genuinely closed are marked as such further down,
each saying whether it closed by a FIX, by a MEASURED NARROWING, or by a DECISION. The rows still
open are the ones marked NEEDS AN OWNER — of which the aliased-`require` route is the only one that
is a live, measured security gap.

---

# Red-window debt ledger

Every currently-failing test, tagged with the task that must clear it.
The hard gate: this ledger must be EMPTY by Task 14. A failure with no owner is a BLOCKED
escalation, not a deferral.

Frozen lists: red-baseline-after-task-4.txt (16), red-baseline-after-task-5.txt (30).

## Owner: Task 6 (store/transaction — deletes canonicalPagePath, pageCommentsPath, buildManifestOperation)
- TransactionEngine > renamePageTitle replaces one canonical page's source bytes
- TransactionEngine > reorderPages rewrites project.toml's page order
- buildRestoreTransaction > replaces the canonical source and appends exactly one system:restore record
- finalizeTurn — full successful finalization > canonical pages (sorted), derived manifest, ...
- finalizeTurn — mandatory pre-intent CAS > canonical page drift yields a typed source_changed error
- finalizeTurn — mandatory pre-intent CAS > manifest drift yields a typed source_changed error
- createPinStoreAdapter > findPageForPin() finds the owning page
- createTurnTransactionsAdapter > finalize() commits an agent record
- createTurnTransactionsAdapter > finalize() returns APPLY_STALE
- crash-injection sweep > multi-page finalization (x3)

## Owner: Task 9 (store/model/factory.ts — DesignTreeStore; PageStore.listSlugs reads pages.json)
- createPageStoreAdapter > (all 5 contract tests)
- openProject > load stores + open: every port is present and minimally functional
- createProject > mints projectId, the format-1 layout, the gitignore
- TransactionEngine > removePage drops a page from the manifest and deletes its files
- TransactionEngine > removePage on a page with no canonical source/comments yet
  (REGISTRY GAP found by Task 6's implementer: these two were in the baseline from Task 4 on
  with no owner. Same DesignTreeStore dependency as the rest of this section.)
- MUST ALSO DELETE: `DesignTreeStoreNotWiredError` in store/model/factory.ts (added by Task 6 as
  an honest typed placeholder so a dead import would not make Bun abort whole test files).
  renamePageTitle / reorderPages / removePage / readSource must stop returning it. It cannot
  survive Task 9 — implementing those four methods necessarily removes the four `return`s.

## Owner: Task 7 (core/ports rekey) — ADDED BY CONTROLLER, not in the brief
- createProjectStoreAdapter > readManifest returns the same shape from both the fake and the real
  Root cause: src/store/adapters/project-store.ts:29 `toManifestV1()` does `pages: manifest.pages`,
  bridging into core/ports' ProjectManifestV1. That DTO must ALSO drop `pages` — project.toml no
  longer carries page order, and the Kernel's page enumeration comes from the DesignTreeReader port
  Task 7 itself introduces (`readManifest()`). Task 7 owns both halves.

## Owner: Task 9 — ADDED BY CONTROLLER, not in the brief
- createShell > (5 tests)
- the `termcraft export` CLI > refuses an untrusted project (reaches the same crash via interactiveShell)
  Root cause: src/entrypoint/model/create-shell.ts:401 `probeProjectContent` does
  `manifest.pages.length > 0` to decide "does this project have content". It must ask the design
  tree instead. Task 9 is the first task that has a DesignTreeStore with readManifest() to ask.
  Design call the implementer correctly refused to make alone: a design-tree read failure in
  probeProjectContent routes the same as a corrupt-manifest read — the project has no readable
  content, so it is treated as empty, and the failure is logged, never silently swallowed.

## Owner: pre-existing, NOT this plan
- src/ui/workspace/ui/Workspace.test.tsx — one tsc error, present on clean phase-8

# tsc debt (added after Task 6)

`bun x tsc --noEmit` is also red, for the same reason the suite is: types moved ahead of their
consumers. Frozen list: tsc-debt-after-task-6.txt (13 lines). Same rule — empty by Task 14.

- src/ui/workspace/ui/Workspace.test.tsx (1) — pre-existing on clean phase-8, NOT this plan
- src/store/adapters/project-store.ts (1) — TASK 7 (ProjectManifestV1 must drop `pages`)
- src/store/adapters/turn-transactions.ts (1) — TASK 7 (ChangedPageOpV1 -> tree file ops)
- src/store/model/factory.ts (1) — TASK 9 (DesignTreeStore)
- src/store/model/transaction-engine-methods.test.ts (6) — TASK 9
- src/entrypoint/model/create-shell.ts (1) + create-shell.test.ts (2) — TASK 9
  (probeProjectContent must ask the design tree, ruling already recorded above)

# REVISION after Task 7 — ownership is now by FILE, not by test name

Task 7 re-keyed `core/ports`, which every `core/*` ring consumes. Frozen lists:
red-baseline-after-task-7.txt (89 failures), tsc-debt-after-task-7.txt (101 tsc errors).
Test-name-level tracking no longer scales; ownership is per file, and every tsc-error file
below is accounted for. Same hard rule: EMPTY BY TASK 14 for everything except the Task 16
and pre-existing rows. A file appearing here that is not listed is a BLOCKED escalation.

| file(s) | owner |
| --- | --- |
| src/store/adapters/staging.ts, staging.test.ts | Task 8 |
| src/store/model/factory.ts, transaction-engine-methods.test.ts | Task 9 |
| src/entrypoint/model/create-shell.ts, create-shell.test.ts | Task 9 |
| src/core/project/model/page-mutations.ts | Task 9 (PageMutations' implementations, per Task 7's brief) |
| src/core/project/model/open-sequence.ts, open-sequence.test.ts | Task 9 |
| src/core/turns/model/candidate.ts, read-set.ts, admission.ts, finalize.ts, run-turn.ts + types.ts and their tests | Task 13 |
| src/core/kernel/** (project.ts/test, turn.ts/test, kernel.test, preview-export.test, selection-model.test, page-pin.ts, chat-relaunch.integration.test, types.ts) | Task 14 |
| src/core/export/model/snapshot.ts, publish.ts | Task 16 |
| src/ui/workspace/ui/Workspace.test.tsx | pre-existing on clean phase-8, NOT this plan |

## Owner: Task 12 (`gate/adapters/gate-runner.ts`, `core/ports/gate-runner.ts` — `runManifestSlice`'s `treePaths` rewiring) — ADDED BY TASK 10

Task 10 changed `gate/model/manifest.ts`'s `checkManifestSlice` from `{ manifestText,
presentSlugs }` to `{ manifestText, treePaths }` (design §4, §8 step 1: entry resolution needs
the tree's file inventory, not the staged page slugs) — precisely what Task 12's own brief
already plans to rewire (its Files list names `src/gate/adapters/gate-runner.ts` and
`src/core/ports/gate-runner.ts` — `runManifestSlice`/`runPage` inputs). There is no honest
minimal patch inside Task 10's own scope: `gate/adapters/gate-runner.ts`'s `runManifestSlice`
bridges to `core/ports`' `GateRunner.runManifestSlice(input: { manifestText, presentSlugs })`,
and a bare slug list cannot honestly produce `treePaths` without fabricating
`pages/<slug>.tsx` — the exact anti-pattern this whole plan exists to remove. Left untouched
rather than patched around; Task 12's own brief already owns the real fix (`runTreeImports`,
`entryRelPath`, `closure` all land together there).

- `src/gate/adapters/gate-runner.ts` — 2 tsc errors: TS2741 (`treePaths` missing from the
  input `runManifestSlice` forwards) and TS2322 (`ManifestScanResult` no longer assignable to
  `ManifestSliceResultV1`, since `ManifestSlice.pages` is now `PageEntryV1[]` not `PageSlug[]`)
  at `runManifestSlice`'s `return checkManifestSlice(input);`.
- `src/gate/adapters/gate-runner.test.ts` — 2 test failures: `runManifestSlice() validates a
  clean manifest slice` and `runManifestSlice() rejects a manifest listing a page absent from
  staging`. Both seed the OLD `{ pages: ["slug"] }` manifest shape and the OLD `presentSlugs`
  input; `{ pages: ["slug"] }` no longer decodes under Task 1's schema (`pages` must be
  `{ slug, entry }[]`), so both now fail cleanly on a `schemaVersion`/shape decode error
  instead of the old permutation-check codes they assert on.

New totals as of Task 10: 82 tsc errors (was 80), 73 test failures (was 71). Both deltas are
exactly these two files, confirmed by diffing the full `bun test`/`tsc --noEmit` runs against
`red-baseline-after-task-9.txt`/`tsc-debt-after-task-9.txt`.

## Temporary scaffolding that MUST be deleted, with its owner

- `src/core/ports/fakes/legacy-page-store.ts` — created by Task 7 to stop Bun aborting 16 test
  files on a missing named export (which silently loses ~254 passing tests). Owner: **Task 14**,
  the task that rewires the last of those files. It cannot be allowed to survive the plan.
- `DesignTreeStoreNotWiredError` in `src/store/model/factory.ts` — created by Task 6. Owner: **Task 9**.

## Fake-fidelity gaps with owners (opened by Task 7's review)

- `createFakeDesignStore` has no fake-vs-real contract test anywhere. Owner: **Task 9** — the task
  that gives the real `DesignTreeStore` something to be contract-tested against.
- `readManifest()`'s behaviour on a project with no `design/pages.json` (a freshly created project)
  is unspecified by the plan, and the fake cannot model it — `createFakeDesignStore` requires
  `manifest`. Owner: **Task 16**, which owns project creation and the workspace skeleton and is
  therefore the task that decides what a tree-less project looks like.
- `src/entrypoint/model/smoke.test.ts` emits "Unhandled error between tests" (1-2 per run, count
  floats). Not a `(fail)` line, so the frozen baselines do not catch it. Owner: **Task 14**.

## Added after Task 7's fix round (controller)

- `src/store/adapters/page-store.ts`'s LEGACY HALF — `readSource`/`listSlugs` + `LegacyPageSourceV1`
  (page-store.ts:150-154,179-189) and the deliberately-dropped return annotation (:169-176).
  Owner: **Task 14**. Forced out by tsc when Task 14 retypes `KernelDeps.pageReader` to
  `DesignTreeReader`, but it belongs in this section by the ledger's own rule.
- Stale row correction: the Task 9 row "createPageStoreAdapter > (all 5 contract tests)" is now
  "4 of the file's 6 tests" — the two reader-refusal tests are green as of Task 7's fix round.
- `src/core/kernel/types.ts:62` still declares `pageReader: PageReader` against a deleted export,
  so `KernelDeps.pageReader` degrades to `any` and every kernel handler's reader call is currently
  UNCHECKED. Owner: **Task 14** — flagged loudly because a degraded-to-any port hides real defects.

## Handed to Task 12 by Tasks 10 and 11

- `src/gate/adapters/gate-runner.ts` + its test — 2 failures, 2 tsc errors. The `presentSlugs ->
  treePaths` signature change breaks the bridge to `core/ports`' `GateRunner` port, whose shape is
  Task 12's own Files-list item.
- `scanImportAllowlist`'s optional `context` (`import-scan.ts:262-266`, `FLAGGED FOR TASK 12`).
  `gate.ts:65` calls it with no context, so relative imports are unusable through the per-page path
  until Task 12 supplies a closure-backed `{from, has}`. Delete the optional shape, `NO_TREE_CONTEXT`,
  and `messageFor`'s no-context branch together.
- `src/gate/model/tree-scan.ts:19-21 vs :33-34` — SELF-CONTRADICTORY CONTRACT, and it is aimed
  squarely at Task 12: the doc grants callers permission for `has` broader than `files` (naming
  Task 12's own `runTreeImports` as the example), then `effectiveHas` makes exactly that fatal, with
  a message that lies ("no file at X" when X is demonstrably in the tree). `listTree` enumerates every
  file under `design/` regardless of extension, so `treePaths` legitimately contains non-TS files.
  Task 12 must decide the real contract and make the doc and the code agree.
- `entities/design-tree/model/manifest.ts:58-62`'s `fromZod` emits the ZOD PATH as `GateError.code`
  (`pages.0.entry`) — index-dependent, so agent feedback cannot branch on it. Needs a stable code.

## SECURITY-CRITICAL must-wire — owner: TASK 14

`runTreeImports` (gate/model/gate.ts:182 — line moved by fix-round doc comments since this was
first written; the function itself is unchanged) has NO non-test caller. The import allowlist and the
§5.8 eval/Function ban therefore run NOWHERE in the shipped pipeline as of Task 12: a page with
`import x from "lodash"`, `require("fs")`, `eval(...)`, `new Function(...)` or a dynamic import()
passes runPage and reaches the smoke render. Moving the scan out of runGate was mandated by Task
12's brief; wiring the new whole-tree caller is core/turns/model/validation.ts's job, i.e. Task 13/14.
THIS IS THE SINGLE MOST IMPORTANT ITEM LEFT IN THE PLAN — the Gate is currently not enforcing its
own security perimeter. It must be wired and proven by a test that a forbidden import in a shared
module fails the turn, not merely that scanTreeImports can detect it in isolation.

## Added by Task 12b (controller-created perimeter fixes) — owner: TASK 14

`scanJsx`'s recursive-descent read is polynomial, not linear, and the element memo added by
task-12b bounds the exponent, not the cost. Measured end to end through `scanTreeImports` on
`"<a>{".repeat(k)`, a shape an agent produces by running away mid-page, with ZERO errors to show
for any of it:

```
 4 000 chars    196 ms
 8 000 chars    638 ms
16 000 chars  1 541 ms
24 000 chars  3 774 ms
32 000 chars  ->  the JS stack is exhausted (see below)
```

`runTreeImports` (`gate/model/gate.ts`) is SYNCHRONOUS and Task 14 gives it its first caller, so
those seconds are paid on the event loop, once per turn, with no timeout and no cancellation.
NOT a regression (the pre-memo reader was far worse — 96 chars took 13 s), and NOT a crash any
more: `tree-scan.ts`'s `TreeFileUnscannableError` converts the stack exhaustion into a fail-closed
`UNSCANNABLE_SOURCE` fatal, pinned by an out-of-process test, so nothing escapes into the caller.

What is left for Task 14 to decide, because it owns the wiring and the error surface: whether a
per-turn scan needs an input bound at all (a source-size or nesting-depth refusal), and if so
where it belongs. Task 12b deliberately did NOT add one: any bound changes what the security scan
sees on some input, which is exactly the class of change that task's own bar forbade, and the
honest place to draw a budget is the caller that knows the turn's budget.

**CLOSED by FIX — design-tree-phase-1-closeout, Task 3 (commit `cc85c87`, base `9ae0a64`).** Task
14's own report (`task-14-report.md` §9 item 1) escalated this to exactly ~77 minutes: 512 files ×
~9s worst case, comfortably inside the store's 512-file/64 MiB budget, with "the fix belongs in
`gate`'s reader" as its own stated resolution. Task 3 IS that fix, drawn where Task 14 said it had
to be: `gate/model/jsx.ts` gained a DELIBERATE recursion ceiling, `MAX_JSX_NESTING_DEPTH = 64`,
which throws a typed `JsxNestingTooDeepError` before the reader ever reaches the engine's own
call-stack limit — replacing an unbounded synchronous read with a fixed, cheap refusal.
`gate/model/tree-scan.ts` converts that throw into a fail-closed `TreeFileUnscannableError`/
`UNSCANNABLE_SOURCE` diagnostic, never a partial scan. Reviewed and confirmed correct: the guard
precedes the descent, every recursion cycle is charged through `readElement`, a memo hit is free,
the decrement covers every controlled path, and no `try`/`catch` in `jsx.ts` can strand the
counter. The stochastic engine `RangeError` this ceiling preempts is not eliminated as a class —
Task 4's `TreeFileUnscannableError` still catches whatever residual route reaches it — but the
DOMINANT, ~9s-per-file cost is gone: nesting now fails at 65 levels, thousands of characters before
the old boundary, not after seconds of event-loop block.

### Task 12b round-1 re-review, Minor M4 — owner: TASK 14, and it is not a doc nit

`gate/model/tree-scan.ts:166-167`'s `isTrustedTarget` treats "the path is a key in `files`" as
"this pass actually read that file's source". That is FALSE when the file's own scan threw:
`TreeFileUnscannableError` turns the throw into an `UNSCANNABLE_SOURCE` error attributed to THAT
file, and the file stays in `files`, so an importer of it is vouched for by a file nothing read.

Measured by the reviewer: tree = `pages/home.tsx` importing `../lib/deep.tsx`, plus `lib/deep.tsx`
= 20 000-deep JSX followed by `import lodash`. Result: `lib/deep.tsx:UNSCANNABLE_SOURCE` only —
`pages/home.tsx` gets ZERO errors of its own.

NOT exploitable today, and that is the whole point of the ownership: `runTreeImports` returns one
flat list and every consumer decides on `errors.length === 0`, so the turn fails anyway. It becomes
a FAIL-OPEN the moment Task 14 attributes rejections per page or per file — which is exactly what
`GateError.file` invites and what design §8's per-entry reporting implies. Task 14 must either keep
the verdict whole-tree, or make a file that failed to scan poison every closure that reaches it,
and must land a test for whichever it chooses.

**CLOSED by FIX (implementing an OPERATOR DECISION) — design-tree-phase-1-closeout, Task 4
(commit `8b59b9c`, fixed-point round commit `d4f175f`, base `f1088bc`).** Task 4 escalated this
exact gap to the operator (measured live on this checkout: `home -> b -> c` with `c` unscannable
gave errors on `b` and `c` only, `pages/home.tsx` got ZERO — verbatim the bug above, moved one step
out) rather than pick a resolution unilaterally. OPERATOR RULING: close it properly rather than keep
the verdict whole-tree — the taint becomes a FIXED POINT. A file cannot vouch for an import if its
own scan failed OR it resolves that import into a file that cannot vouch, iterated to a fixed point
(append-only, bounded by `scans.size`, so termination is structural with no iteration cap). A clean
tree still pays zero re-scans and one O(n) sweep. Re-review verified the sweep resets its `added`
flag per FULL pass so no file can be left untainted by ordering. Whole suite fully green for the
first time on this branch immediately after landing: 4354 pass / 2 skip / 0 fail. Task 11 (this
closeout) may therefore state §8's per-entry reporting as safe to build in plan 2 WITHOUT
weakening — that claim was false at depth 1 and is true now.

### Task 13 re-review, Minor M-d — owner: TASK 14

`core/ports/fakes/gate-runner.ts:127-131` defaults to `closures: []` for any `pages`, while the real
adapter returns one closure per resolving entry. Any `core` test running on the default fake
therefore sees `selectChangedPages(...) === []` — "nothing changed for any page", which is the exact
silent mode Task 13 exists to kill.

Ruled to KEEP as behaviour (an entry-only echo would be a worse lie), but it becomes the default for
Task 14's fixtures unless each one remembers `queueRunTreeImportsResult`. Task 14 must queue real
closures in every fixture that asserts on changed pages, and must not let a green test rest on the
fake's empty default.

### Task 13 round-3 re-review, Minor M-4 — owner: TASK 14, with the obstacle named

`GateErrorV1`/`GateError` gained an optional `blockedPages` in task 13 round 3: it carries WHICH page
slugs a closure blocker blocked, so one underlying fact yields one diagnostic with N attributions
instead of N near-identical copies. The fail-open it closes is real, but it is closed **at the port
surface only** — the field cannot reach any consumer today, for two concrete reasons:

- `src/core/turns/model/validation.ts:113-121`'s `toGateErrorDto` lists fields BY NAME
  (`kind/code/message/file/line/column`) and silently drops `blockedPages`.
- `src/core/protocol/model/event-payload.ts:803-810`'s `turnGateErrorV1Schema` is a
  `z.strictObject` with no such key, so the field cannot be added to the wire DTO without widening
  the schema.

`grep -rn blockedPages src/` finds no reader outside the gate adapter, the types and its test. There
is no live defect only because `runTreeImports` still has no production caller — which Task 14 fixes.

Task 14 must decide whether to CARRY the field across both boundaries or DERIVE the attribution at
the DTO boundary, and must not drop a diagnostic it cannot attribute to a page. Dropping the
unattributable would be a silent fail-open: the page is already excluded from `closures`, so losing
its diagnostic loses the only signal that it was excluded.

### RAW NUL BYTES in two tracked sources — pre-existing, NOT this plan, but it must reach the final review

`grep` and ripgrep classify a file containing a raw NUL as BINARY and print `Binary file … matches`
instead of the matching lines. Any review, audit or codemod sweep that greps `src/` therefore
SILENTLY SKIPS these files' contents:

- `src/core/ports/fakes/session-checkpoint.ts` — 1 NUL
- `src/host/supervisor/model/restart-policy.test.ts` — 2 NULs

Verified with `tr -dc '\000' < file | wc -c` over every tracked `.ts`/`.tsx`; those two are the only
ones. Task 13 round 4 introduced and then removed six more in `gate/adapters/gate-runner.ts` (in
`ClosureBlockerV1.key` template literals, replaced by `JSON.stringify([...])`, which is injective for
the same reason and needs no escape).

Confirmed by the controller that `grep -qP '\x00'` does NOT reliably detect this — the first
controller sweep using it reported zero files. Use `tr -dc '\000' | wc -c`.

No owner assigned: neither file is in this plan's scope. Raised for the FINAL WHOLE-BRANCH REVIEW,
which must not run a grep-based sweep believing it covered `src/`.

**CLOSED by FIX — design-tree-phase-1-closeout, Task 2 (commit `3d70e88`, base `d468fa8`).** Both
raw NULs were ESCAPED, not stripped (the commit subject's own word choice was inaccurate — there
were three NULs across the two files, and every one became a `\0` escape sequence inside an
ordinary string/template literal, changing zero runtime bytes). Verified today with the same
`tr -dc '\000' | wc -c` measurement this entry specifies: both files report **0**. A `grep`/`rg`
sweep over `src/` no longer misclassifies either file as binary.

### UI: the repair prompt names a path that cannot exist — NO OWNER, raised by task-14 review round 1 (I3)

`src/ui/preview/model/repair-prompt.ts`'s `relativePageSourcePath(slug)` returns
`.termcraft/pages/<slug>/page.tsx`. After this plan that directory DOES NOT EXIST: canonical
storage is `.termcraft/design/<entry>`, and `entry` is whatever `design/pages.json` binds to
the slug — always inside `design/`. There is no project for which the current string is right.

NOT COSMETIC. It is user-visible on two surfaces: the composer text F6 writes
(`repair-prompt.ts:67`, `file: …` followed by "Fix the render error in that file" — line 50 before this branch's doc-block expansion; corrected in round 2, M5) and the
crash panel on screen (`ui/preview/ui/HostCrashPanel.tsx:91`). The app tells the user to edit a
file that cannot exist. `src/ui/preview/model/repair-prompt.test.ts`'s `relativePageSourcePath`
case PINS the wrong string — the same category as `gate-runner.test.ts:68`, which task 14's own
supplement required be corrected; it is annotated in place rather than silently left.

NOT FIXED BY TASK 14, and the blocker is authority rather than effort:

1. `ui` cannot name the real file. `PageDescriptorV1` (`core/protocol/model/event-payload.ts`)
   carries `pageSlug`/`sourceHash`/meta and NO `entry`, so an honest path means widening a wire
   DTO plus its producer and fixtures — outside task 14's Files list.
2. **`design/termcraft-engine.js:1153` (`wsHostCrash`) still draws `· .termcraft/pages/main/page.tsx`.**
   The design is this project's source of truth for what this frame says and has not been
   updated for the design tree. CLAUDE.md's rule for a case the design does not cover is to
   flag the gap, never to guess a replacement — so a unilateral string change here would
   violate the project's own governing constraint.

NEEDS A CONTROLLER DECISION: update the design frame first (then the code follows it), or
assign both to Task 16/17 as one unit. Whoever takes it must also unpin `repair-prompt.test.ts`.

**CLOSED — and it was already closed BEFORE design-tree-phase-1-closeout began.** Corrected after
the final whole-plan review: the closeout itself appended "Still open, still needing the controller
decision above" to this row (commit `258a32e`, confirmed by `git log -S`), which was simply wrong —
nobody re-checked the row's own subject before writing that line.

What actually happened: plan 1's Task 16 fixed it, and fixed it in the order this row demanded
rather than around it. `src/ui/preview/model/repair-prompt.ts:20-42` now carries
`relativePageSourcePath(entryRelPath)` returning `.termcraft/design/<entry>`, and its doc block
records that the DESIGN was updated first and the code followed —
`design/termcraft-engine.js`'s `wsHostCrash`, git-history caption, diff and restore frames all drew
`.termcraft/pages/main/page.tsx` and now draw `.termcraft/design/pages/main.tsx`. The controller
decision this row asked for was therefore made and executed; no decision is outstanding.

### The §5.8 dynamic-code ban is only partly enforceable by a token scan — CLOSED for eval/Function by Task 10, raised by task 14b

**NARROWED in task 14b fix round 1, after the review showed the first version of this entry was
wider than what had been proved.** Five spellings it lumped into "unclosable" needed neither alias
tracking nor constant folding, and each is now CLOSED and pinned by a test:

```
new (Function)("...")()        (Function)("...")()        (0, Function)("...")()
globalThis.eval("...")         (globalThis as any).eval("...")     window/self/global.eval("...")
```

The `Function` check had required `(` as the very NEXT token, so one pair of parentheses walked
past it; the `eval` check excluded EVERY `.`-prefixed occurrence, so the most obvious spelling of
indirect eval was never looked at. Both were measured live first (Bun accepts, `await import()`
executes, the perimeter reported nothing) and are measured caught now.

**WHAT REMAINS LIVE, and this is the part that is genuinely not closable at this layer.** Four
shapes, each re-tested the way the brief requires — transpiled, EXECUTED from its own directory,
and run through the real `scanTreeImports`:

```
1  const F = Function; new F("<payload>")()             bun=OK exec=YES gate=[]   LIVE
2  const k = "eval"; globalThis[k]("<payload>")         bun=OK exec=YES gate=[]   LIVE
3  globalThis["ev" + "al"]("<payload>")                 bun=OK exec=YES gate=[]   LIVE
4  [].constructor.constructor("<payload>")()            bun=OK exec=YES gate=[]   LIVE
5  ((Function))("<payload>")()                          bun=OK exec=YES gate=[]   LIVE (nested parens)
```

**FIX ROUND 2 CLOSED THREE MORE that the first version of this entry did not even list**, and
**FIX ROUND 3 CLOSED SIX MORE STILL** — so the earlier claim that the live set was "exactly
these five and nothing wider" was FALSE when it was written, twice over. The measured set is
below; the closed rows are listed so the next reader can see what the claim actually covers:

```
6  \u0065val("<payload>")                               bun=OK exec=YES  -> now EVAL_CALL
7  new \u0046unction("<payload>")()                      bun=OK exec=YES  -> now FUNCTION_CALL
8  eval ("<payload>") inside a FICTIONAL JSX prose run    bun=OK exec=YES  -> now EVAL_CALL
```

The escaped-identifier rows were silent on EVERY revision because `Tok.value` carried the raw
source text; they are closed by reading the scanner's cooked value, which fixes every check that
compares an identifier at once rather than one at a time. The prose-run rows were silenced by a
suppression filter that is now deleted outright — see `import-scan.ts`'s "NO PROSE SUPPRESSION"
section for the trade that replaced it.

**FIX ROUND 3 (Critical 2) closed six LITERAL key spellings**, every one written in exactly the
form the computed-access check claimed to catch, every one measured accepted, executed and
silent:

```
 9  globalThis?.["eval"]("<payload>")        `?.` was absent from the receiver set
10  globalThis?.["Function"]("<payload>")()  same
11  globalThis[`eval`]("<payload>")         a template key is not a StringLiteral
12  const { ["eval"]: v } = globalThis       before `[` in a pattern the token is `{`
13  const { "eval": v } = globalThis         no bracket at all — a string property key
14  Reflect.get(globalThis,"eval")("<pl>")   `get` lexes as GetKeyword, not Identifier
```

None of them needed alias tracking or constant folding, which is why the previous entry's
boundary between "closable here" and "inherent" was drawn in the wrong place. The boundary as
measured now: a spelling that writes `eval` or `Function` as SOURCE TEXT is catchable at this
layer and is caught; a spelling that reaches the capability without writing either — through an
alias, a variable or concatenated key, an arbitrary parenthesis nest, or a
`constructor.constructor` chain — is not, because that is not a lexical question.

**THE REAL FIX IS ABOVE THIS LAYER, and this entry should be read as asking for it:** a runtime
facade from which a saved page cannot reach `eval`, `Function`, `require` or the network at
all. Until that exists the perimeter is a reliable barrier against accidental and casual
violation of §5.8, a reliable barrier against forbidden module edges, and NOT a sandbox.

Each `<payload>` incremented a global; the counter moved, so these are executions, not
transpiles.

**ROW 4 IS THE PROOF, not the hardest case.** It writes neither `eval` nor `Function` anywhere in
the source, so no token-level rule has anything to key on. Rows 1-3 and 5 reach the same
capability through alias tracking, constant folding and arbitrary parenthesis nesting — each of
which is a binder or a constant-folder, not a lexer. Because row 4 is open regardless, hardening
the others buys no additional security; that argument is now made only about what it actually
covers, which is the correction this round owed.

Two directions that would close it, neither in task 14b's scope:

1. **Capability denial at the runtime**, not detection at the gate — the saved-page mount
   (`host/session/model/source-mount.ts`) runs page code in this process with the ambient realm.
   Denying `eval`/`Function` where the page executes makes every spelling above inert, including
   ones nobody has enumerated.
2. **A real binder-level analysis** (TypeScript's own program, which `gate/model/type-check.ts`
   already builds for the type check) instead of a token walk.

`import-scan.ts`'s inventory carries the measured verdict on every row, so it no longer reads as
"handled". NEEDS AN OWNER. **UPDATE (Task 10, design-tree-phase-1-closeout, see
`.superpowers/sdd/2026-08-02-design-tree-phase-1-closeout/task-10-report.md`): direction 1 above
is now DONE for `eval` and the `Function` family.** `host/session/model/capability-denial.ts`'s
`denyDynamicCodeCapability()` runs in the `_host --stdio` child (wired from
`host/session/model/entry.ts`, as the first statements of the `loadPage` dependency handed to
`createHostSession` — i.e. immediately before `loadPage` ever `import()`s a page's source) and
closes not only `Function`/`eval` but the three "function kind" intrinsics
`Function.prototype.constructor` alone cannot reach — `AsyncFunction`, `GeneratorFunction`,
`AsyncGeneratorFunction`, each measured LIVE and executing during this task's own probing before
being closed. All eight rows above (5 from this entry, 3 more from task 14b fix rounds), plus the
three new intrinsics, are covered. Measured end-to-end: a page that runs the AsyncFunction route
in module scope, mounted through the real `loadPage`, never moves its payload marker and the
mount fails with `DynamicCodeDeniedError` (`host/session/model/source-mount.test.ts`). **This
does NOT close every dynamic-code route** — see the new entry immediately below for a route Task
10 found and could NOT close with this technique.

**FIX ROUND 1 CLOSED A SIXTH ENTRY POINT, `Worker`, found the SAME way as the require gap below
(the task was told to keep probing rather than trust its own exhaustiveness claim) but — unlike
`require` — closable with this same technique.** `new Worker("data:text/javascript," +
encodeURIComponent(code))` loads and runs a string of code in a FRESH realm this function never
touched — measured through the real `loadPage`, with the rest of the denial already installed, the
payload still answered back. `Worker` reaches the capability through none of `eval`/`Function` (no
import, no `require`, straight from a page's module scope) but unlike `require` it IS an ordinary
`globalThis` property, so the same callable-but-throwing replacement closes it. A 12-scenario
census (both real `examples/clock` pages with full post-mount traffic, smoke/export modes, a
multi-file closure, all six `loadPage` failure branches) with an OBSERVING wrapper installed before
any static import found ZERO constructions in this process's own code, so it is denied
UNCONDITIONALLY, no warm-up needed (commit `d57c2a3`, fix round 1 of Task 10, base `68d20fc`).
Regression-checked: disabling it gives 3 failures including a really-constructed `Worker` with a
live `threadId`. Denied entry points are now SIX: `eval`, `Function`, the three function-kind
intrinsics, and `Worker`. Do not list `Worker` as an open route — it is closed, unlike `require`
immediately below.

### `require` reaches arbitrary Node built-ins from a page's module scope, invisible to the import scanner and NOT closable by realm-level capability denial — OWNED BY design-tree-phase-2 Task 1 — NARROWED at the Gate, host residual still open, raised by Task 10

Task 10 (design-tree-phase-1-closeout) set out to close the `eval`/`Function` gap above and was
told explicitly to keep probing for OTHER routes that turn a string into running code, rather than
trust the doc block's own claim of exhaustiveness. It found one, and could not close it with the
technique that closed everything else in this file.

**MEASURED LIVE**, from a scratch probe run against Bun 1.3.14, in a `.tsx` module loaded the same
way `host/session/model/source-mount.ts`'s `loadPage` loads a page (`await import()`, no explicit
`require` import anywhere in the source):

```ts
const r = require                              // `require` is ambient — no import statement
const vm = r("node:vm")                         // aliased call, NOT `require("node:vm")` literally
vm.runInNewContext("globalThis.x = 'PAYLOAD'")  // EXECUTES — sandbox.x === "PAYLOAD"
```

Two separate facts make this unlike every row above:

1. **`Bun.Transpiler.scanImports` — the AST scan BOTH the gate's `import-scan.ts` and this
   module's own `scanClosureImports` are built on — only pattern-matches the LITERAL syntax
   `require(<call>)`.** Measured directly: `scanImports` on `const r = require; r("node:vm")`
   returns an EMPTY record array — zero import/require-call entries — while the literal
   `require("node:vm")` on the same line is correctly flagged `require-call`. This is the exact
   same alias-vs-literal-token gap that made `[].constructor.constructor` invisible to the
   `eval`/`Function` token checks, but reached through `require` instead.
2. **Unlike `eval`/`Function`, `require` is NOT a `globalThis` property.**
   `Object.getOwnPropertyDescriptor(globalThis, "require")` is `undefined`, and `"require" in
   globalThis` is `false` — Bun injects it per-module (the way Node's CJS wrapper injects
   `require`/`module`/`__filename`/`__dirname` as function parameters, not globals), confirmed by
   probing `typeof require` inside a nested function scope too (still `"function"`). Realm-level
   capability denial works by replacing a property on `globalThis` or a shared prototype object;
   there is no such object here to replace. `denyDynamicCodeCapability()` was checked and does NOT
   and STRUCTURALLY CANNOT touch this — there is nothing in the `_host --stdio` child's own realm
   for it to redefine.

**Severity is wider than "more dynamic code":** `node:vm`'s `runInNewContext` is one require away,
but so is `node:fs`, `node:child_process`, and every other Node built-in the import allowlist
(§5.8, "`node:*` ... forbidden") exists to keep out. This is an import-allowlist bypass with a
code-execution payload attached, not merely another eval/Function spelling.

**Two directions that would close it, neither attempted by Task 10:**

1. **Scanner-level fix**: make `scanFileImports`/`scanClosureImports` (and the gate's
   `import-scan.ts`) refuse ANY bare reference to the identifier `require` — not only a literal
   call — since reading the value at all is enough to alias and later invoke it. Needs checking
   against the `COMPILER_INJECTED_JSX_SPECIFIERS` exemption (the JSX transform's own injected
   `require-call` records) to confirm a blanket identifier-reference ban does not also flag those.
2. **Structural**: run page code in a REAL isolated context (a `node:vm` context, or a separate
   JS engine/isolate) that never receives a `require`/`module`/`__filename` binding at all, instead
   of the ambient realm the `_host --stdio` child's own trusted code runs in. This is the same
   "real fix is above this layer" the entry above gestures at, now with a second capability
   (`require`) that realm-mutation cannot reach, reinforcing that direction over patching realm
   objects one at a time.

NEEDS AN OWNER. Still open at the end of design-tree-phase-1-closeout.

**NARROWED — design-tree-phase-2 Task 1.** Direction 1 above is now done at the Gate:
`gate/model/import-scan.ts`'s `RequireKeyword` branch flags a bare `require` REFERENCE, not only
the literal call, mirroring the `eval` guard's existing precedent — `const r = require; r("node:vm")`
is now fatal, proven both at the unit (`import-scan.test.ts`) and through the real turn
(`turn-import-perimeter.test.ts`'s "a bare `require` reference" row, placed in a shared module no
page names directly). WHAT DOES NOT HOLD: the host's own rescan, `scanClosureImports`, is still
built on `Bun.Transpiler.scanImports`, which pattern-matches only the literal `require(...)` call
syntax — an aliased reference stays invisible to it, so the host side remains the residual this fix
does not touch. Direction 2 (a real isolated context with no `require` binding at all) remains
unowned. THE COST: `require` is a far more common English word than `eval`, so display copy
containing it — `<Text id="t">These settings require a restart</Text>` — is now a Gate rejection
too, the same accepted over-approximation `eval` already takes, taken knowingly rather than
exempted (see `import-scan.ts`'s "NO PROSE SUPPRESSION" section).

### `runPage` accepted the tree coordinates OPTIONALLY, falling back to a fabricated empty tree — raised by task 15, CLOSED by MEASURED FIX in design-tree-phase-1-closeout Task 5

Task 15 (`gate/adapters/gate-runner.ts`'s `runPage`) left `treeRoot`/`expectedFiles`/`entryRelPath`
optional and, when absent, handed the smoke stage `treeRoot: ""` with an empty inventory so
`loadPage` would refuse on its first check. Honest — a refusal naming a missing input, never a
mount of a fabricated path — but a shape only a caller with no tree could produce. Task 16 noted
both production callers already supplied the tree by the time it landed and asked whoever closed
it to make the pair required and delete the fallback (`progress.md:659-664`, `:692-695`, "FOR A
LATER PLAN").

**CLOSED by FIX — design-tree-phase-1-closeout, Task 5 (commit `1a8dd58`, fix round `d07c24b`, base
`f1088bc`).** `GateRunner.runPage`'s tree coordinates are now REQUIRED, and the `treeRoot: ""`
fallback is deleted along with it — the commit subject is literally "require the tree coordinates
and delete the last slug-derived path guesses." Verified by the review (scoped re-review over
`1a8dd58..d07c24b`) via MUTATION TESTING, not reading: hardcoding the old fallback shape back in
fails the new test pair; removing the `errore.try` that replaced the leak fails the companion test
with an uncaught `JsxNestingTooDeepError`. `entryRelPath`/`source.relPath` provenance verified
against the code (`core/project/model/descriptors.ts:170-184`'s `entry.entry`), not the comments.

### The fake design-store's fake-vs-real contract test could not catch a hash/size divergence — raised by (old plan) Task 9's own review, CLOSED by MEASURED MIGRATION in design-tree-phase-1-closeout Task 7

Recorded only as a "minor (deferred)" in plan 1's own progress log, never promoted to its own row
here: "the fake-vs-real contract test compares only relPath lists and identically-seeded bytes, so
it cannot catch a hash/size divergence (the fake seeds `"0".repeat(64)`)"
(`2026-07-28-design-tree-canonical-source/progress.md:150`). Every `core` test built on
`createFakeDesignStore`/`fakeDesignTreeFile` saw a FABRICATED `sha256`, never one derived from the
bytes the fixture actually seeded — a path/content swap was invisible to the whole fake-vs-real
contract by construction.

**CLOSED by MEASURED MIGRATION, not merely a capability add — design-tree-phase-1-closeout, Task 7
(commits `be98b53`, `e331ceb`, `3dc0f92`; base `756d8e8`).** The first round added a real
`computeSourceHash` helper (`entities/design-tree/model/hashing.ts`) and an OPTIONAL `sha256` on
the fake's seed type, but the reviewer MEASURED the purpose as unachieved: replacing
`Bun.CryptoHasher` through `--preload` and counting constructions through `hashing.ts` across all
17 pre-existing `core` files/280 tests consuming the fake found **ZERO** calls — every path but the
two new tests still ran through a type where `sha256` could not be omitted. Ruled by the controller
to be FINISHED rather than ledgered as a partial win, per this plan's own precedent that the brief
is normative in substance, not literal wording. Fix round 1 (`e331ceb`, 17 files, +269/-118)
migrated 12 `core` test files plus 2 `store` test files off fabricated seed constants; re-measured
by the implementer and independently reproduced by the re-reviewer: **181 of 288**
`Bun.CryptoHasher` constructions now route through `computeSourceHash`, 167 of those 181 from the
fake's own LIVE `seededSha256` fallback (not module-scope constants), so the number is carried by
the real path. A scoped re-review checked for the obvious trap — hashing a result's own bytes
against itself — EXHAUSTIVELY across all 31 call sites: zero tautologies, zero weakened assertions.
One discrimination hazard the migration itself introduced (`page-pin.test.ts`'s `home`/`about`
fixtures both hashing to the same empty-bytes digest) was caught and fixed in `3dc0f92`. The
migration agrees with `store`'s real `sha256Hex` byte-for-byte, including over a `Uint8Array` view
with a non-zero `byteOffset` — the one input shape where two independent hashers can genuinely
diverge — so the decision NOT to make `store` delegate to the new helper (parity-pinned test
instead, following `gate/model/smoke.test.ts`'s existing precedent) is sound.

### (superseded) The §5.8 dynamic-code ban cannot be enforced by a token scan — raised by task 14b

Task 14b re-tested all seven KNOWN GAPS pinned in `gate/model/import-scan.ts` the way the brief
required — transpiled with `Bun.Transpiler`, EXECUTED with `await import()` from its own
directory, and run through the real `scanTreeImports` perimeter. Three were closed and two were
proved unreachable (Bun refuses the source). **Four are LIVE: Bun accepts them, Bun executes
them, and the perimeter reports nothing.**

```
1  const F = Function; new F("<payload>")()             bun=OK exec=YES gate=[]   LIVE
2  const k = "eval"; globalThis[k]("<payload>")         bun=OK exec=YES gate=[]   LIVE
3  globalThis["ev" + "al"]("<payload>")                 bun=OK exec=YES gate=[]   LIVE
4  [].constructor.constructor("<payload>")()            bun=OK exec=YES gate=[]   LIVE
```

Each `<payload>` incremented a global; the counter moved, so these are executions, not
transpiles. Artifacts: `oracle/gaps-before.txt`, `oracle/gaps-final.txt` (task 14b's scratch).

**NOT CLOSABLE AT THIS LAYER, and that is the escalation rather than an excuse.** Row 4 writes
neither `eval` nor `Function` anywhere in the source, so no token-level rule has anything to key
on — this is a proof, not a difficulty. Rows 1-3 reach the same capability through alias
tracking and constant folding, which need a binder; and since row 4 is open regardless, hardening
1-3 buys no security while adding false-rejection risk on ordinary code (`Function` is also
TypeScript's callback type, so flagging a bare reference rejects `Map<string, Function>`).

Two directions that would actually close it, neither in task 14b's scope:

1. **Capability denial at the runtime**, not detection at the gate — the saved-page mount
   (`host/session/model/source-mount.ts`) runs page code in this process with the ambient realm.
   Denying `eval`/`Function` where the page executes makes every spelling above inert, including
   ones nobody has enumerated.
2. **A real binder-level analysis** (TypeScript's own program, which `gate/model/type-check.ts`
   already builds for the type check) instead of a token walk.

Task 14b's own contribution is that the inventory no longer reads as "handled": each row in
`import-scan.ts` now carries its measured verdict, and this entry exists so the four live ones
are acted on rather than re-documented. NEEDS AN OWNER.

## Debt accumulated by design-tree-phase-1-closeout itself (recorded here by its own Task 11)

These postdate every row above — none were owned by plan 1, all were found and measured DURING
this closeout plan's own tasks. Ledgered rather than silently left in a task's fix-round notes, per
this plan's whole purpose: closing a debt row must not create a fresh, untracked one. Full evidence
for each is in `.superpowers/sdd/2026-08-02-design-tree-phase-1-closeout/progress.md`.

- **`PageMetaKeyV1` omits `entryRelPath`** though page-meta extraction now depends on it (Task 5,
  commit `1a8dd58`) — a page whose entry is renamed `.tsx` -> `.ts` with UNCHANGED bytes keeps its
  cache key and can be served the `.tsx` reading. CALIBRATED LATENT, not user-visible: the reviewer
  probed 7 candidate divergent sources and found none diverge (the lexer's boundary-only window
  rewrite makes ordinary sources agree); the one real divergence (64-level JSX nesting) runs
  fail->succeed, which is cache-safe. RULED not to widen the key now: `entryPathSchema` forbids
  backslashes/leading-`/`/drive-letters/`.`/`..` but NOT spaces, so `pages/my page.tsx` would break
  the on-disk key's space-separated "no field can forge a boundary" invariant — a `store/projections`
  schema/generation-bump change, out of scope for the task that found it. Owner: whichever task next
  touches `store/projections`' key encoding.
- **The root `*.d.ts` admission is still by EXTENSION, not exact name** (Task 6, commit `d3c49cb` +
  `756d8e8`) — `limits.ts`'s single-component branch admits ANY `*.d.ts` at a workspace/candidate
  root, one level up from the NESTED wildcard this task deleted. Evidence the wildcard admits
  unstaged names: `limits.test.ts:59` asserts `runtime.generated.d.ts` -> `agent-runtime-doc`, yet
  `buildRuntimeDocs` maps that source basename to the relPath `runtime.d.ts` — the asserted name
  never reaches a workspace root. Measured INERT today: a root `.d.ts` an agent writes is filtered
  out of the design diff (`core/turns/model/candidate.ts:118-125`) and bounded by the
  `agent-runtime-doc` budget (32 files / 16 MiB). Fix when taken: add `runtime.d.ts` to
  `AGENT_DOC_FILES`, drop the `endsWith`, flip `limits.test.ts:59` to `expectUnknown`.
- **Task 8's performance framing is OVERSTATED and must not be repeated as a user-visible win**
  (commit `f6d42e6`). MEASURED, not argued: a warm `lstat` here costs ~38.5µs; a realistic closure
  (entry + 5 shared modules at depth 3) goes 18 stats -> 9, saving ~0.35ms; the only real design tree
  in this repo (`examples/clock/.termcraft/design/`, a single-file closure at depth 2) saves EXACTLY
  ZERO. The asymptotic change is real (O(members×depth) -> O(distinct components)) and matters at
  hundreds of members, but "the preview mount path, the one the user waits for on every page switch"
  overstates it against a mount that also pays N file reads, N transpiles and an `import()`.
- **"The last production `make*` factory" is FALSE** (Task 9, commits `a111c09`/`bea93e1`).
  **CORRECTED after the final whole-plan review — this row's first version was itself wrong twice,
  which is worth stating plainly since the row exists to correct a false claim.** It said 14; it is
  **15**, the list below missing `makeHandle` (`core/ports/fakes/chat-store.ts:151`). And its own
  proposed narrowing — "only 'the last EXPORTED production `make*`' is true" — is ALSO false:
  `makeDesignTreeStore` was never exported (`git show a111c09^:src/store/model/factory.ts` line 892
  is a bare `function`, no `export`), and there are **no exported production `make*` functions in
  this repository at all**. The accurate statement is simply that 15 production `make*` declarations
  survive against the repo's `create*` rule, and that Task 9 renamed the one the brief happened to
  name. Separately, `makeScratchDir` survives as an option key on the exported `createBunSpawn`
  (`spawn.ts:179`) — a field name, not a factory, listed here only so the next sweep does not
  double-count it. The 15: 11 in `store/model/factory.ts` (`makeLeaseStore`,
  `makeTransactionEngine`, `makeManifestStore`, `makeWorkspaceStateStore`, `makePinStore`,
  `makeChatIndexCache`, `makeChatStore`, `makeProjectionStore`, `makeTrustStore`,
  `makeStagingStore`, `makeBackupStore`) and 3 in `store/transaction/model/write-mutex.ts`. Only
  "the last EXPORTED production `make*`" is true — the commit message and the closeout plan's own
  wording both repeat the unqualified claim. Visible cost today: `factory.ts:1429` reads
  `pins: makePinStore(...)` / `pages: createDesignTreeStore(...)` / `trust: makeTrustStore(...)` —
  one `create*` among `make*` neighbours. Bounded follow-up: rename the remaining 14 (deliberately
  NOT done inside Task 9, which would have buried its real change).
- **`DesignTreeTooDeepError`'s branch has no test** (surfaced by Task 9's move, PRE-EXISTING not a
  regression). Substance verified at HEAD: zero matches in any `*.test.ts` across `src/`.
  **Coordinates corrected after the final whole-plan review** — the row first said `:152` and "appears
  only in its own declaration and `failure.ts`", and both were wrong. The declaration is
  `store/model/design-tree-store.ts:34`, the throw is `:144` (`:152` went stale one commit after the
  row was written), and the class is also referenced at `store/types.ts:57,259,631`,
  `store/index.ts:94` and `store/adapters/failure.ts:6,277`. The untested thing is the depth-refusal
  BRANCH, not the class's reachability.
- **`computeSourceHash` is exported from both `entities/design-tree` and `host/session`** (Task 7,
  cosmetic) — identical semantics (`Bun.CryptoHasher` over the same window-respecting bytes), no
  collision today; the repo already handles the overlap by aliasing at the import site
  (`gate/model/smoke.test.ts` imports the `host/session` one as `hostComputeSourceHash`). Rename to
  `computeDesignFileHash` only if a future reader trips on it.

Recorded as a GAIN, not a gap, so it is not mistaken for one: **Task 8 gave the symlink refusal in
`host/session/model/source-mount.ts` its FIRST regression net.** The brief claimed "the existing
symlink-refusal tests"; none existed — before Task 8, `src/host` had no symlink/junction/lstat
coverage at all. Its three new tests are the first, and a mutation-testing review confirmed one of
them (the ordering pin between `verified.add(walked)` and `isSymbolicLink()`) is load-bearing, not
decorative: the mutation passed all 363 `src/host` tests until fix round 1 closed that gap.

## Added by the final whole-plan review (2026-08-03) — open, low severity

- **Depth off-by-one: the tree walk emits what the limits will later refuse, PRE-EXISTING and not
  this branch's doing.** `store/model/design-tree-store.ts:136-144` walks directories to depth 8 and
  therefore emits files with 9 path components, while `ROOT_LIMITS.workspace.maxDepth = 8`
  (`store/safe-fs/model/limits.ts:83`) and `NAMESPACE_LIMITS["design-source"].maxDepth = 8` (`:58`)
  reject them only at candidate freeze (`store/safe-fs/model/candidate.ts:257-262`); staging does not
  check depth at all (`store/sandbox/model/staging-store.ts:256-282`). Fail-late rather than
  fail-early, and unreachable today. Owner: whichever task next touches the walk or the freeze.

- **Task attribution across this closeout's 23 commits is inconsistent — decode it before trusting a
  "(task N)" marker in code.** Three conventions are in use. Task 5 signed its OWN work "(task 16)",
  because plan 1's Task 16 had merely FLAGGED the items it closed (`core/ports/gate-runner.ts:116,189,200`,
  `gate/adapters/gate-runner.ts:77,572`, `core/kernel/model/handlers/turn.ts`); Task 3 wrote a bare
  "(task 3)" that collides with plan 1's own Task 3; Task 7 wrote the unambiguous
  "design-tree-phase-1-closeout task 7" (`gate/model/lexer.test.ts:352`). The last form is the one to
  use from now on. No code change — history is written — but a reader resolving a marker to the wrong
  plan will misread why a line exists.

- **`gate/model/lexer.oracle.test.ts:556` carries the corpus count "893" in a test NAME while
  asserting nothing about it**, so it rots silently on the next added source file, unlike its
  neighbour `lexer.test.ts:359` which actually asserts. Relatedly, `lexer.test.ts:357` instructs the
  reader to update "the counts quoted in `lexer.ts`" — `lexer.ts` contains no such number. The count
  was bumped three times in this plan alone (Tasks 7, 9, 10: 888 → 890 → 891 → 893), so the
  instruction is exercised often enough to be worth correcting. Left as a follow-up rather than fixed
  here, because this pass was markdown-only by construction.
