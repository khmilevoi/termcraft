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
  **CLOSED — design-tree-phase-2 Task 6 (commit `352fdbe`).** The task this row named as its owner
  ("whichever task next touches `store/projections`' key encoding") arrived, and it closed the row
  WITHOUT widening the key: `PageMetaKeyV1` is now `(pageSlug, closureHash, extractorVersion)`
  (`core/ports/projections.ts:33-37`, mirroring `store/projections/model/page-meta-cache.ts`), and
  `closureHash` already carries the entry's PATH. Proof, read off the code rather than argued:
  `resolveClosure` seeds its visited set with the entry itself (`entities/design-tree/model/
  closure.ts:38`, `new Set([input.entry])`), so a closure always transitively contains its own entry;
  `computeClosureHash` folds each member as a `(relPath, sha256)` PAIR (`closure.ts:124-135` through
  `foldMerkle`), so the entry's `relPath` is inside the hash. The `.tsx` -> `.ts` rename with
  unchanged bytes this row was written about therefore MOVES the key. The row's own reason for not
  widening also evaporates rather than being overridden: nothing path-shaped is encoded on disk — the
  new field is a hex `Sha256Hex` — so `pages/my page.tsx`'s space cannot forge a key boundary. The
  generation bump the row anticipated was paid as part of the re-key.
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

## Debt accumulated by design-tree-phase-2 (closure graph everywhere), recorded here by its own Task 11

Plan `docs/superpowers/plans/2026-08-03-design-tree-phase-2-closure-graph.md`, tasks 1-10, commits
`0360b94..70a29dd`. Everything below postdates every row above. It is the complete set of
deferred/parked items its ten task reviews produced, minus the ones that already have a better home
than a ledger row — those are listed at the end of this section by their exact site, so a reader can
tell "considered and homed" from "forgotten". Full per-task evidence is in
`.superpowers/sdd/2026-08-03-design-tree-phase-2-closure-graph/progress.md`.

Same rule this file has followed since the phase-1 closeout: closing a debt row must not create a
fresh, untracked one. This plan closed one row (`PageMetaKeyV1` above) and narrowed another (the
aliased-`require` row above); these are what it opened.

### `diagnosticsCache` has no production caller — NO OWNER, and here is the evidence

**MEASURED, before and after Task 7's re-key.** `DiagnosticsCache` is constructed and injected at
the composition root (`entrypoint/model/create-shell.ts:189`, `diagnosticsCache:
projections.diagnostics`) and declared on the Kernel's deps (`core/kernel/types.ts:80`), but
`grep -rn "diagnosticsCache\." src` finds **zero** call sites — no `get`, no `put`, anywhere outside
the store's own tests (`store/adapters/projections.test.ts:86,106,124`). The other half of the same
measurement: nothing in `src/` emits `diagnostics.changed` either, so even the event this cache was
shaped around (`core/ports/projections.ts:13-16`) has no producer.

Task 7 re-keyed the store `sourceHash` -> `closureHash` and bumped it to generation 2
(`store/projections/model/diagnostics-store.ts:61`) anyway, and said so in the port's own doc rather
than implying a fix: "UNLIKE {@link PageMetaKeyV1}'s Task 6 re-key, this cache has NO PRODUCTION
CALLER TODAY … this re-key buys correctness ahead of a future caller, not a fix for a live
invalidation defect" (`core/ports/projections.ts:51-58`). That framing is the honest one and must
not be upgraded on retelling.

**The trap this leaves for whoever wires the first caller**, already flagged inline at the write site
(`store/adapters/projections.ts:99-108`): `toDiagnosticDtoV1` writes `key.closureHash` into
`DiagnosticDtoV1.sourceHash`. Both are `Sha256Hex`, so it type-checks; the WIRE field was not renamed
because `core/protocol`'s DTO was out of Task 7's scope. Dead on two independently unreached paths
today — hence cosmetic, not a live bug — but a reader of `DiagnosticDtoV1.sourceHash` must not assume
it holds the page's own source bytes' hash.

NO OWNER: wiring a caller is a product decision about where diagnostics are surfaced, not something a
re-key gets to make. Named as deliberately-undone in the plan's own closing table.

### A closure never contains `pages.json`, so a manifest repoint to byte-identical bytes reads as "skip" — NEEDS AN OWNER

Pre-existing, and inherited by Task 9 rather than introduced by it. Closures are resolved by walking
IMPORT EDGES from the entry (`entities/design-tree/model/closure.ts:38-52`), so `design/pages.json`
is never a member of any closure. Edit the manifest to point `home` at a different file whose bytes
happen to equal the old entry's and no closure hash moves: Task 9's `selectChangedPages` reuse then
selects "skip" for smoke, and the `changedPages` report says nothing, although the page now renders
different content. Task 9 could not fix it without violating its brief's explicit "reuse
`selectChangedPages` verbatim" requirement, and the identical gap already existed in the changed-pages
report it reused.

What DOES cover the case, so the severity is not overstated: `treeRevision` folds the ENTIRE inventory
including `pages.json` (`closure.ts:144-149`), so the live preview session re-establishes on such an
edit (Task 10's key). Only the smoke-selection and `changedPages` halves are blind to it.

### `buildPageDescriptors` never reads the tree pass's `warnings` — owner: whoever next touches `page-descriptors.ts`

Found by Task 5's own fix round, in a function that round did not touch. `routePassErrors` and
`buildPageDescriptors` (`core/kernel/model/handlers/page-descriptors.ts`) read `index.errors` only —
`.warnings` has zero matches in that file — so the `import-cycle` and `dead-module` warnings Task 4
added reach the TURN path (`core/turns/model/prompt.ts:65-68`) but never a descriptor publish. Same
class as the Important finding Task 5's round 1 fixed for dropped tree-pass ERRORS, one function over.

### `export.start` runs two whole-tree passes, and a third whole-tree reader still exists — owner: plan 3 (§11)

`resolveExportPageInputs` reads the canonical index (`core/kernel/model/handlers/preview-export.ts:
1452`), which runs `GateRunner.runTree` — a full allowlist scan and one `tsc` program — for page
order, inventory and `closureHash`. `resolveExportClosures` (`:1515`) then runs a SECOND `runTree`,
over the FROZEN snapshot's bytes, after the write permit is released. They cannot be cleanly
collapsed: different trees (live vs. snapshot) and different lock phases, which is exactly the point
of the second one. The first pass's `runTree` output beyond the index is unused — its diagnostics feed
only the warn at `:1454`.

Why this is a ledger row and not just a cost: `resolveExportClosures`'s own doc block
(`:1480-1498`) argues the second pass is proportionate but never says the FIRST one exists, so a
future reader who spots the duplication can "fix" it by collapsing them and silently break the
package's revision identity.

Related, and named in the plan's own closing table: `core/export/model/snapshot.ts`'s private
`readWholeTree` remains a THIRD whole-tree reader alongside the shared `readCanonicalTreeIndex` Task 5
introduced. Folding it in is a clean follow-up, not a correctness fix.

**CLOSED (design-tree phase 3 Task 8), the documentation half.** `resolveExportClosures`'s own doc
block now states, at the site, that it is deliberately the SECOND whole-tree pass and names the first
by function (`preview-export.ts`, its own header). The duplication itself is unchanged and still
proportionate for the reason already given above — this closes only the "a future reader silently
collapses them" risk, not the pass count. `core/export/model/snapshot.ts`'s private `readWholeTree`
remains the THIRD reader, still open, still no owner: it is a clean follow-up, not a correctness fix,
and Task 8's scope was the two passes named here plus the `settingsStillMatch` row below, not a third
reader this row already flagged as out of scope.

### `publish.ts`'s `settingsStillMatch` never compares `expectedFiles`/`closureHash` — owner: plan 3 (§11)

Pre-existing, confirmed by Task 8 as not worsened by the re-key. `core/export/model/publish.ts:112-129`
compares `pageSlug`, `manifestIndex`, `theme`, `kitApiVersion` and `minSize` — nothing about the tree.
A SHARED-MODULE drift between snapshot capture and publish therefore does not surface as
`EXPORT_SNAPSHOT_STALE`, while an ENTRY drift does (the per-page `readPageEntrySource` re-read at
`:166`). Practical risk stays low — the host's mount verification fails on a drifted closure, so a
SUCCESSFUL export always describes one revision — but it is a policy asymmetry now that a page is its
whole closure rather than its entry file.

**CLOSED (design-tree phase 3 Task 8).** `settingsStillMatch` now compares `closureHash` too, in
addition to the five settings fields above: a captured/current mismatch is `EXPORT_SNAPSHOT_STALE`,
and `null` on EITHER side is treated as a mismatch — never a match — inheriting phase 2 decision 3's
own rule that an uncomputable closure hash means "cannot prove which bytes this page is made of."
`expectedFiles` itself stays uncompared: the per-page `readPageEntrySource` re-read already catches an
ENTRY drift, and the closure comparison above now catches every OTHER member, so comparing the raw
inventory array too would be redundant with both.

### Bare `await`s on helpers that `wrap` internally — eight RTM-A04 sites, NEEDS AN OWNER

Opened as one item because it is one pattern, and because this closeout's own `/reatom-audit` run is
what measured its extent. Task 5's review flagged the first site and noted "Reatom audit clean";
**that note does not hold** — auditing the nine Reatom-touching files this plan changed, by EXPLICIT
PATH rather than by `--changed` (the router consumes its cache, so a second `--changed` run reports
"already audited" without auditing), returned seven RTM-A04 findings plus one RTM-S02. The rule in
every case is the same: an inner `wrap()` inside a helper does not cover the caller's outer `await`
over that helper, so everything after the await resumes outside the Reatom frame.

- `core/project/model/tree-index.ts:153` — `await readTreeSources(...)` bare, while all three of its
  neighbours go through `wrap` (`:138`, `:150`, `:156`). This is Task 5's flagged site.
- `core/kernel/model/handlers/preview-export.ts:361, 364` (`resolvePageSettings`), `:1459`
  (`resolveExportPageInputs`' per-page loop), and the `resolvePageMeta` chain's port calls at
  `:209, 251, 254, 296`.
- `core/kernel/model/handlers/turn.ts:508, 512` — inside `createContentCachingStaging`, contradicting
  that file's own stated rule at `:425-426` that every port call is wrapped.
- `core/project/model/descriptors.ts:117`; `core/turns/model/candidate.ts:293`.
- RTM-S02, `ui/app/model/deps.ts:634` — `lastKernelPageSlug` plus a `mirror.project.subscribe` is a
  hand-rolled sync effect keeping `pageOverride` aligned with the Kernel's slug; the same factory
  already does the owned-by-the-atom form at `:735`.

**NOT A REGRESSION FROM THIS PLAN, verified by blame and by reading the pre-images.** Every flagged
shape predates it: `git blame` puts four of the sites on this plan's commits, but the code they
replaced awaited the same helpers just as bare (`page-descriptors.ts:218`'s
`await readTreeSources(...)` and `preview-export.ts:1331/1336/1342`'s three bare awaits at
`bf7a1ae`), and the four remaining sites blame to commits outside this plan's range entirely. The
plan ADDED wraps (`await wrap(readCanonicalTreeIndex(...))`, `await wrap(readPageOrder(...))`) rather
than removing any. Left unfixed here because this closeout is a docs-only commit and a fix is a code
change across five files in four modules; ledgered rather than dropped because this repository has
already paid once for exactly this shape.

### `page-descriptors.ts:270` branches on `errors.length === 0` rather than `result.ok` — owner: whoever next touches that branch

Task 3's rewrite. Production-equivalent, because `createGateResult` derives `ok` from `errors.length`
— but a scripted fake (`queueRunPageResult({ ok: false, errors: [] })`) now publishes `status: "ready"`
where it used to publish `"invalid"`. Fixture-only today. Recorded so the next reader treats it as
intentional rather than as an accident nobody noticed.

### `resolveExportClosures`'s dropped-diagnostic warning also fires for `type`-kind diagnostics — owner: whoever next touches that warning

`preview-export.ts:1522-1526` tells the operator that pages "it could not resolve ship without a
closure listing" for ANY error the pass reports. Since Task 3 folded the type check into the same
pass, that now includes `type`-kind diagnostics, which do not affect closure resolution at all. The
VERDICT is right (the pass did report errors); the message misdescribes why.

### The double entry-file read in `buildPageDescriptors`, and its one new consequence — owner: whoever next touches `page-descriptors.ts`

Pre-existing and already documented inline as a "KNOWN, OWNED COST"
(`core/kernel/model/handlers/page-descriptors.ts:222-228`): `readPageEntrySource` re-reads the entry
file the tree index above already read. Two notes this plan adds rather than the cost itself. (1) The
inline reason given ("`readPageEntrySource` is what owns 'the manifest binds this slug to this file,
and here is its hash'") describes the manifest lookup, not the second READ, so the comment
under-describes what it is defending — and the second read slightly widens the TOCTOU window between
the `runTree` verdict and the published `sourceHash`. (2) Task 10's consequence specifically: in the
narrow window where the entry moved but the inventory read has not caught up, the new
`(pageSlug, treeRevision)` key can miss a re-ask the old entry-hash key would have made. Self-corrects
on the next publish, and `treeRevision` is the more authoritative of the two values.

### `export`'s `resolveMountTreeRevision` recomputes a `treeRevision` `core` already holds — no owner, cost named

`host/adapters/mount-tree-revision.ts:30`, called from `export-render.ts:55` and `smoke-renderer.ts:40`.
Self-flagged by Task 10 as its own Concern 1. No behavior consequence — the derivation is over the same
`expectedFiles` inventory — purely a duplicated fold. Closing it is more expensive than it looks: the
value would have to be threaded through `ExportPageSnapshotV1`, not just `ExportRenderTaskV1`, and the
smoke path would need the Gate's `runPage` port widened to carry it.

### Tests this plan left thinner than they read — no owner, each named at its own file

Coverage breadth, not defects; grouped because no one of them is worth a row.

- **Task 1**: no regression test pins the `require(nonLiteralArg)` behavior CHANGE (it used to be
  silently dropped, it is now flagged). The bare-reference branch itself is tested at both the unit and
  turn levels; this is the neighbouring case the same edit moved.
- **Task 2**: `createTreeTypeChecker`'s crash path (`TYPE_CHECK_UNAVAILABLE`) has no direct test. It was
  verified as a structural mirror of the already-tested `createTypeChecker` crash path — which Task 3
  then deleted, so the mirror no longer has an original.
- **Task 9**: the end-to-end, turn-level "skip" assertion is unreachable in the harness because the
  fixture's staging and design-store hashes disagree. Verified test-infrastructure-only: production runs
  the same `sha256Hex` over the same normalized paths on both sides, and "skip" does fire there.
- **Task 10**: `deps.test.ts`'s "fallback biases toward more asks" is a FORWARD guard only — the
  pre-task code produced the same slug-only key at the same point (`snapshot()` defaults to
  `pageDescriptors: []`), so it does not reproduce a RED without the fix. A true guard needs a snapshot
  carrying the active page's descriptor with a matching `sourceHash`.

### Stale prose the re-keys left in code comments and test names — no owner, fix in passing

Comments and names only; no behavior depends on any of them. Listed so a reader who trips on one knows
it was seen.

- `gate/model/smoke.ts:38-41` still says it "Mirrors `createTypeChecker`'s factory shape
  (`type-check.ts:242-253`)" — Task 3 deleted `createTypeChecker`.
- `entrypoint/model/smoke.test.ts:617-619`'s TODO still tells a future extension to seed the page-meta
  cache under `sourceHash`; the key has been `closureHash` since Task 6.
- `core/kernel/model/kernel.integration.test.ts:335` seeds `closureHash` from a constant still named
  `HOME_SOURCE_HASH` (correctness moot — that value is proven dead in the test).
- `preview-export.ts`'s `entryRelPath` JSDoc moved to `extractPageMetaOnly` in Task 6 and was not
  restored on `extractAndCachePageMeta`, which still takes and forwards the parameter.
- `gate/model/type-check.ts:245` cites TypeScript's own `FileSystem` interface as
  `node_modules/typescript/dist/api/fs.d.ts:5-21`; the interface is 5-19 — 20-21 are the
  `fsCallbackNames` const and its comment.
- `store/projections/model/render-cache.ts:62-70`'s generation-bump justification overstates what the
  bump buys — schema validation already treats a parse failure as a clean miss, and the field rename
  moves `keyHash` anyway. The bump itself is correct and required; only the reasoning is imprecise.
- `gate/model/import-scan.ts`'s `require(nonLiteralArg)` message reads "reading the binding at all…"
  at what is an actual call site, inherited verbatim from the brief's prescribed code.
- `core/turns/model/validation.ts:363`'s `closure === undefined` branch is defense-in-depth against a
  contract violation (`runTree`'s own contract says an unclosured slug always carries a fatal), and its
  test does not say so — a reader may mistake it for a second change-rule. It can only err toward an
  extra smoke, never toward skipping one that should run.

### Accepted consequences this plan chose knowingly — recorded, not open

Neither needs an owner; both are documented at the site that causes them.

- **A crash-looping page now gets a fresh restart budget on ANY tree edit**, not only an edit to its own
  entry file — the direct consequence of Task 10's session key, documented in
  `host/supervisor/model/restart-policy.ts:53-57`. The budget follows `supervisor.ts`'s key by design
  and derives nothing itself.
- **The Gate now rejects display copy containing the word `require`** — Task 1's over-approximation,
  the same one `eval` already took, argued in `gate/model/import-scan.ts`'s "NO PROSE SUPPRESSION"
  section and restated in the aliased-`require` row above.

### Erratum in the plan's own text — no code change

The plan's Task 4 Step 4 says `DETERMINISM_WARNING_KINDS` "must stay exactly the four it names". It
holds exactly TWO (`unguarded-timer`, `unguarded-randomness`, `core/turns/model/prompt.ts:59-62`);
"four" is a different set, the header's excluded-kinds list. The implementer read past the wording
correctly: the two-kind set was left untouched and Task 4's new `import-cycle`/`dead-module` warnings
were routed through a separate `GRAPH_WARNING_KINDS` and header (`prompt.ts:64-68`), which is the
semantically right call — a cycle is not a wall-clock or randomness fact. Recorded because the plan
file is a historical record that will be read again, not because anything in `src/` is wrong.

### Considered and homed elsewhere — deliberately NOT given a row here

- Task 7's `DiagnosticDtoV1.sourceHash` trap — inline at the write site
  (`store/adapters/projections.ts:99-108`), and restated in the `diagnosticsCache` row above because
  that is when it would bite.
- Task 10's restart-budget consequence — inline at `restart-policy.ts:53-57`; listed above as an
  accepted consequence rather than a gap.
- Task 5's `PAGE_NOT_JUDGED` guard without a test, its mirror-direction race, and the tree pass's
  dropped diagnostics on the preview/export paths — all three were FIXED in Task 5's own fix round
  (`64fb46a..fba7c2c`), not deferred.
- Task 3's file-less-pass-error fail-open — FIXED under a human ruling in Task 3's fix round
  (`61a51ab..91f5a34`); a file-less `TYPE_CHECK_UNAVAILABLE` now invalidates every descriptor.
- The three separate task reviews flagging `docs/architecture/storage.md` as stale (Tasks 6, 7, 8) —
  FIXED by this closeout's own Step 3, so there is nothing left to track.

## Debt accumulated by design-tree-phase-1b (migration), recorded here by its own Task 11

Plan `docs/superpowers/plans/2026-08-04-design-tree-phase-1b-migration.md`, tasks 1-10, commits
`802a980..72d003d`. Full per-task evidence, including the fix rounds and the deferred minors
listed in each task's own line, is in
`.superpowers/sdd/2026-08-04-design-tree-phase-1b-migration/progress.md`. This plan shipped the
first real migration a termcraft project ever runs; the five rows below are what it deliberately
left open rather than closed, each with the evidence for why it is real.

### The four `migration.*` Kernel commands and `MIGRATION_TRANSITION_TABLE` are still dead — real divergence, not a scheduling gap

A migration now runs in production (`store/model/factory.ts`'s `migrateProject`), and it drives
NONE of `migration.plan`/`migration.confirm`/`migration.discardPlan`/`migration.retryRecovery` —
all four still route to the well-formed `migrationPostMvpHandler` no-op
(`core/kernel/model/handlers/index.ts`), and the `MigrationState` machine
(`core/machines/model/migration-machine.ts`) is instantiated but never transitioned. This is
because the migration happens entirely BEFORE a Kernel exists: `entrypoint/model/create-shell.ts`
catches `ManifestMigrationRequiredError` and offers the `migrate-80` dialog pre-Kernel
(`docs/architecture/flows/migration.md` item 12), so nothing in its path can ever dispatch a
Kernel command. That makes this a real, permanent divergence between
`docs/superpowers/specs/2026-07-16-kernel-command-contract-design.md` §7.7 (which describes
`migration.plan`/`migration.confirm` minting `migrationPlanId`/`migrationActionId` through a
Kernel-mediated two-step flow) and the shipped path (which mints both ids directly inside
`migrateProject` at commit time, with no Kernel involved) — not a scheduling gap waiting for a
future task. `core/kernel/model/handlers/index.ts`'s own header comment (task 18, MVP phase-8)
still frames the no-op as waiting on "a second storage format version" shipping; one has now
(`project.toml` 1 -> 2), so that comment is itself stale and was flagged rather than edited
(`docs/architecture/flows/migration.md`'s own source-anchor entry for this file says so) — this
plan's scope is docs-only, so the code comment was left for whoever next touches that file.
NO OWNER: closing this means deciding whether a FUTURE migration shape (one that runs against an
already-open project) is worth building the Kernel-command family for; nothing in this plan needs
it.

### `project.retryOpen`'s `{kind: "migration", migrationActionId}` branch has no producer

`core/protocol/model/command-payload.ts:99`'s `projectRetryOpenPayloadSchema` types this
discriminated-union member, and `core/project/model/recovery-routing.ts:71` and
`core/project/model/open-sequence.ts:229` both branch on `"migration"` as one of three legal
recovery domains — but `grep -rn '"migration"' src/ui src/entrypoint` finds no caller that ever
constructs a `project.retryOpen` command carrying it, in `ui` or `entrypoint`. In practice this is
not a live gap because the two crash windows it would matter for are both already covered by
OTHER, correct machinery: a migration interrupted AFTER its commit intent is durable is rolled
forward by the fully generic `recoverTransactions` scan (same as any other transaction `kind`),
and a migration interrupted BEFORE commit intent is simply discarded — the next launch re-reads
whatever `pages/**` files remain and re-offers the `migrate-80` dialog from scratch
(`docs/architecture/flows/migration.md` item 11). Both outcomes are CORRECT. What is missing is
narration: neither path tells the user "a migration was interrupted and recovered" or "your
previous migration attempt did not complete" — they just silently resume as if nothing happened.
NO OWNER: wiring this recovery domain's UI is a product decision about whether that narration is
worth a dedicated screen, not something this plan's scope covers.

### `esc later` exits the process — recorded as a UX defect against design §12.1, not an accepted limitation

Design §12.1 states plainly: "`esc later` returns to Home having written nothing." The shipped
behavior (`entrypoint/model/run-migration.ts`'s `MigrationDeclinedError`) exits the process with
one printed line instead — nothing is written, matching half of the design sentence, but there is
no return to Home. This is NOT a documentation nit to wave through: it is undeliverable as
specified, and per this repository's own standing rule, an outcome that looks broken from the
design's stated behavior is a defect to record where it will be acted on, not a "known
limitation" to launder past review. The root cause is structural, not an oversight — Home renders
inside an app built from a Kernel, which is itself built from an `OpenProject`, and §12.1's own
premise is that a version-1 project cannot produce one, so there is no Kernel and no Home to
return to. Fixing it for real needs a project-less Kernel mode (a Kernel, and therefore a Home
screen, that can exist without any `OpenProject` behind it) — a structural change larger than this
migration itself, which was ruled out when this plan was written
(`entrypoint/model/run-migration.ts`'s own doc comment on `MigrationDeclinedError` records the
same reasoning). NO OWNER: gated on that project-less Kernel mode, which is its own piece of work.

### No pre-flight free-space check before the backup — pre-existing, now reachable in production for the first time

Pre-existing gap (`docs/architecture/flows/migration.md` item 5, tracked before this plan under
the MVP-phase-8 ledger too), but this plan is the first time it is reachable through a live user
action rather than only through the store's own tests: `store/migration/model/backup-store.ts`'s
`createBackupStore` has no pre-flight free-space check, so a backup that runs out of disk on a
real, user-triggered migration just fails the copy step it is on, like any other I/O error — the
project is left untouched (the backup-then-transaction ordering guarantees that much), but the
message the user sees is a generic I/O failure, not "not enough space for the backup". NO OWNER:
adding a free-space probe is a straightforward addition to `createBackupStore`'s own pre-flight
sequence, but it is new code this docs-only closeout does not add.

### Headless `termcraft export` still refuses a version-1 project outright, with no migration path — unlike the interactive path

`entrypoint/model/run-export.ts`'s `runHeadlessExport` composes the same `createShell("interactive",
...)` graph the interactive root uses, and when that call reports `"kind" in shell` (a version-1
project, `ManifestMigrationRequiredError`), it returns a `ShellCompositionError` naming the reason
"the project is on format 1 and the migration surface is not wired yet" — a straight refusal, with
no `runMigrationPrompt` call and no way for a headless run to migrate the project and continue. The
interactive path (`bootstrap.ts`) no longer has this gap: it now draws the real `migrate-80` offer
and, on `⏎ migrate`, drives `store.migrateProject` before re-running `createShell`. Headless export
was left behind — `runHeadlessExport`'s own comment still calls this "the same temporary refusal as
`bootstrap.ts`", which was true before this plan and is no longer true after it. A user who only
ever drives `termcraft export <dir>` against a version-1 project — never opening it interactively
first — has no way to get past this refusal short of running `termcraft` interactively once. NO
OWNER: wiring a migration offer into a non-interactive CLI path (no terminal, no keypress to answer
`⏎ migrate` / `esc later` with) is a real design question — an unattended CLI cannot show a dialog
and wait for a key the way the interactive root does — not a mechanical port of the interactive fix.

## Debt accumulated by design-tree-phase-3 (host O2), recorded here by its own Task 9

Plan `docs/superpowers/plans/2026-08-04-design-tree-phase-3-host-o2.md`, tasks 1-8, commits
`0b6ccdc..c4a520b`. Everything below postdates every row above.

### The warm spare is booted, NOT handshaked — a deliberate divergence from §9.3's literal wording

§9.3 says the spare is "booted, handshaked, un-mounted." `client.hello` is a `z.strictObject`
requiring `mode`/`pageSlug`/`sourceHash`/`sourceKitApiVersion` (`host/protocol/model/hello.ts:
50-60`), all facts about a mount the spare does not have yet — making them optional would be a
host-supervision §5.1 wire change for one message round trip on top of a boot the spare already
removes. Recorded, not open: `spare-pool.ts`'s own header carries the same argument at the site.

M2 (measured against a real `_host --stdio` child, Bun 1.3.14, 2026-08-09, five runs each,
spawn-to-first-stdout-byte): `client.hello` sent immediately, 584.4-685.7ms, median 596.5ms (boot
+ handshake); deferred 3000ms, the round trip past that wait was 31.1-41.7ms, median 36.8ms
(handshake alone, post-boot). The implied boot cost a spare removes is ~560ms, ~94% of the
cold-start total — the spare was built, not declined, on this evidence.

### `frame-broker.ts` is no longer "unchanged" — corrects §9.3's own claim

§9.3 states "the frame broker and relay (`frame-broker.ts`, `preview-relay.ts`) are unchanged."
`preview-relay.ts` is; `frame-broker.ts` is not. `createFrameBroker`'s guard used to be a
construction-time-fixed `{sessionId, nonce, sourceHash}` (rejecting any frame whose `sourceHash`
differed); Task 3 made the expected `sourceHash` a mutable local and added `expect(sourceHash)`,
re-seeded the instant the pump observes an accepted mount's `ready`. Necessary the moment §9.2
retired "one incarnation renders one page forever" — the construction-time guard was correct
exactly under that retired invariant. Corrected here rather than in the spec's own prose (Task 9
Step 2 also updates the spec directly); this row is the ledger's copy of the same correction.

### Per-page hang isolation is gone — ACCEPTED (§13's first bullet), not open, mitigation shipped

§13 accepts the trade explicitly: one incarnation now serves a whole tree revision, so a hang in
one page blocks previewing every other page until the incarnation is replaced. Task 4 shipped the
mitigation §9.4 asks for: a mount deadline and a first-frame deadline (`timeouts.ts`'s
`MOUNT_TIMEOUT_MS`/`FIRST_FRAME_TIMEOUT_MS`), both naming the page that was mounting on expiry, and
`ui/preview/model/failure-class.ts` routes a `MOUNT_TIMEOUT` to the design-at-fault `wsHostCrash`
panel rather than `wsHostUnavailable`. The trade itself is not reversed and has no owner — it is
the cost §9.1's "one incarnation per revision" buys, recorded as accepted per this ledger's own
"accepted consequences" convention (see the phase-1 closeout section's row of the same shape).

### A lint for module-scope mutable state in a shared module — NO OWNER, "likely warranted" only

§13's closing bullet: "a lint warning for module-scope mutable state in a shared module is likely
warranted." Not required, and this plan does not add one. The behaviour it would warn about
(module-level state in a shared module survives a page switch and resets only when the design
changes) is documented to three different readers instead: the agent, in the system prompt's
`DESIGN_CODE_RULES` (`agent/prompt/model/prose.ts`, "Shared module state"); the implementer, in
the export prompt's `## Shared modules` section (Task 7, `core/export/model/package.ts`); and the
codebase's own reader, in `host-state-machine.ts`'s repeated-mount header note (Task 1). A user is
told before they are surprised on all three paths a design's behaviour reaches someone. NO OWNER:
the lint itself is still unwritten.

### §9.3's prefetch of neighbouring tabs' closures — deliberately not built, no owner

§9.3 itself calls this "second phase, optional." It needs a new control kind on the wire (importing
a closure without mounting it), a new idle-detection rule in the child, and an abandonment rule
("abandoned the moment any control message arrives, and never runs on a stale revision") — a whole
subsystem whose entire benefit is removing the `import()` of an already-verified closure from a
switch that Task 5 already made in-process (65.9ms median, M1). Ledgered with this argument,
carried verbatim from the plan's own closing table; no owner.

## Added by the final whole-branch review (design-tree phase 3, 2026-08-09) — read before trusting `session.ts`/`supervisor.ts` in isolation

Dispatched at the full `0ca25dd..HEAD` range per Task 9's own instruction, pointed at the six named
risk questions plus a free sweep for anything else. Four findings were real, verified bugs and are
FIXED in this same closeout commit (each carries its own test, listed for the next reader who wants
the regression pin rather than re-deriving it):

- **A mount `session.ts`'s pump never committed (a `kind !== "ready"` reply) used to read as a
  success to `supervisor.ts`'s `reconcileMount`.** The generic `responseTo` routing
  (`session.ts:424-427`) resolves the request table with the RAW envelope regardless of `kind` —
  including a typed `error` reply to a repeated `mount()`, which is not `instanceof Error` and so
  passed `reconcileMount`'s `result instanceof Error` check straight through as a mounted page.
  FIXED: `mount()` now runs the same `mapHostError` conversion `awaitReady`'s own `kind === "error"`
  branch already applied to the FIRST mount. Pinned by `session.test.ts`'s "a repeated mount() the
  child refuses with a typed error resolves to that typed error, never a ControlEnvelope success".
- **A page-specific mount refusal the incarnation SURVIVES (`checkKitApiVersion`'s pre-flight
  `KIT_API_MISMATCH`, or `buildMountBody`'s pre-flight `ProtocolError`) used to kill the whole live
  incarnation.** `reconcileMount`'s `.then()` treated ANY `Error` result from `mount()` as grounds to
  call `onIncarnationFatal` — including a refusal that never reached the wire and left the child
  fully alive, still correctly serving every OTHER page sharing the incarnation. This is exactly the
  blast-radius regression a revision-keyed incarnation (§9.2) must not have: one page's own static
  incompatibility must not respawn a healthy sibling page's session. FIXED: `reconcileMount` now
  checks `current.phase === "ready"` before escalating — a refusal the session itself survived logs
  a warning and fails only the switch. Pinned by `supervisor.test.ts`'s "a mount refusal the
  incarnation survives fails only the switch, not the incarnation or its other pages".
- **`pendingMount` was never cleared on an early `sendRequestWithId` rejection** (`TOO_MANY_REQUESTS`,
  a full outbound queue) that never reaches the wire and therefore never correlates through the
  pump's inline hook. Left stuck, every LATER `mount()` on that incarnation was permanently refused
  as "already in flight" — a narrow, defensive-only path (256-entry request table), but a genuine
  dead end once triggered, and one the phase-check fix above made more likely to matter (an
  incarnation that survives a refusal keeps running, instead of the pre-fix behaviour of killing and
  replacing it, which incidentally cleared the stuck slot via a fresh incarnation). FIXED: `mount()`
  defensively clears its own `pendingMount` slot (by requestId) once its own promise settles,
  regardless of outcome. Pinned by `session.test.ts`'s "a mount() refused by the pre-send
  TOO_MANY_REQUESTS guard does not leave a later mount() stuck as 'already in flight'".
- **The export prompt's `## Shared modules` section undercounted a page importing ANOTHER page's
  entry** (legal: design §4/§7's "two slugs may share one `entry`"), and mis-stated "every page is
  self-contained" when zero closures resolved at all rather than saying shared modules could not be
  checked. FIXED in `core/export/model/package.ts`'s `readersByModule` (a path is dropped only when
  the SOLE reader is the page whose own entry it is, never merely because it happens to be *an*
  entry) and in the zero-closures branch of `buildDesignPrompt`. Pinned by `package.test.ts`'s "a
  page importing ANOTHER page's entry as a module is visible as shared, from both sides" and "zero
  resolved closures says shared modules could not be checked, never that none exist".

Four more were confirmed real but are NOT fixed here, each with the reason:

- **`preview.retry` never reaches `supervisor.retry()` in production.** `core/preview/model/
  session-commands.ts`'s `handleRetry` (`:311-322`) calls `establishSession(lastSpec)` →
  `HostSupervisorPort.preview` → `adapters/host-supervisor.ts:183-187` → `supervisor.ts:preview()`,
  whose "key exists and is not closed" branch (`:567-571`) returns the SAME circuit-open session as
  a non-error, without ever calling `policy.retry`/`startIncarnation`. The Kernel then reports
  `sessionReady`; the retry panel clears; no frame ever arrives, forever. `SupervisedPreviewSession
  .retry()` — the method whose own internals this plan verified correct in isolation
  (`restartKeyOf` reads the CURRENT `ks.spec.pageSlug`, so it clears the right page's budget in
  every state the circuit opens from, `supervisor.test.ts:684-712`) — has exactly one call site
  (`adapters/host-supervisor.ts:161`) that nothing in `core` ever calls. VERIFIED PRE-EXISTING: the
  same branch shape was already present at `0ca25dd`, before this plan's first commit — not
  introduced or worsened by design-tree phase 3. NO OWNER. The green suite exercises `retry()`
  directly (`supervisor.test.ts:363,671`), which is why this reached HEAD undetected: the tested path
  and the production path diverge before `supervisor.retry()` is ever reached.
- **`project.close` leaks the live host incarnation AND, since this plan, the warm spare too.**
  `core/kernel/model/kernel.ts:613-616`'s null branch of `setActivePreviewSession` calls only
  `noteSessionClosed()`, never closing the session it displaces; `project.ts:210` is its one caller.
  `sparePool.drain()` is reachable only from `supervisor.ts`'s `stopAll()` (`:606`), called solely at
  application exit. So closing a project leaves BOTH the live incarnation and its warm spare running,
  each holding a slot against §13's ≤10 cap, until the app itself exits. The incarnation half is
  PRE-EXISTING (same gap before this plan); the spare half is new, added by Task 6 onto the same
  unfixed gap. NO OWNER: fixing `project.close`'s teardown path touches `kernel.ts`'s session
  lifecycle outside anything Tasks 1-8 changed, and is a decision about when a project-scoped
  resource should release, not a mechanical host-side fix.
- **A narrow race can misattribute an incarnation's real fatal cause to a generic `TRANSPORT_ERROR`.**
  Between `session.ts`'s `phase = "failed"` (synchronous, inside `failFromReady`) and its
  `deps.onFatal` call (async, after `await teardown(true)` — up to ~1s) there is a window where
  `session.phase` already reads "failed" but the supervisor does not know it yet. A `reconcileMount`
  triggered in that window calls `mount()`, which immediately refuses with a generic `TRANSPORT_ERROR`
  ("mount requires a ready session") — `current.phase !== "ready"`, so this plan's own phase-check
  fix above does NOT suppress it, and it reaches `onIncarnationFatal` first, before the real
  originating error arrives via the slower `deps.onFatal` path. `onIncarnationFatal`'s own
  idempotency guard (`ks.incarnationFailed`) then discards the real cause. Diagnostic-only — the
  incarnation is correctly killed and restarted either way, only the reported REASON is wrong. NO
  OWNER: a correct fix needs the failure-notification path to prefer whichever error actually
  originates the failure over one that is a downstream symptom of it, which is a bigger change than
  this closeout's own scope; a hasty fix risks a worse bug in the sequencing it would touch.
- **`supervisor.ts`'s `spawnFor(ks.spec)` is computed and discarded on spare adoption.** `:175-176`
  calls `deps.spawnFor(ks.spec)` inside `sessionDepsFor` even when `sessionDepsFor`'s own
  `spawn` wrapper is about to serve a pre-spawned spare (`sparePool.take() ?? deps.spawn(command)`) —
  the computed `command` is simply unused in that branch. Safe today only because the production
  `spawnFor` ignores its `spec` argument entirely (`entrypoint/model/create-shell.ts:190`); the
  widened type signature (`HostSessionSpec | null) => SpawnCommand`, Task 6) invites a future
  `spawnFor` that DOES depend on `spec` to silently compute the wrong command for an adopted spare.
  NO OWNER — recorded so a future `spawnFor` implementer reads this before assuming `ks.spec` is
  used uniformly.

## WP-9: no design screen for a backend-failed turn / no re-send affordance — NO OWNER, raised by Task 11 (design-agent-feedback-loop repair, 2026-08-09)

`design/12-errors-edge-states.dc.html` has TEN error screens and none of them is a backend-failed
turn or a re-send affordance. The design's own answer to a failed generation is the system line
`⟲ generation failed after 3 tries — current design unchanged` (`design/termcraft-engine.js:793`,
`wsErrRetry`'s scene) — a statement that the turn failed, nothing offering to retry it.
CLAUDE.md's "Design is a source of truth — never invent it" forbids drawing the missing screen
unilaterally, so Task 11 shipped ONLY the half of WP-9 that needs no new visual language at all:
**on a terminal turn failure (`turn.failed`, never `turn.cancelled`), the failed turn's own sent
text is restored into the EXISTING composer draft** — reusing the composer's already-designed
held-draft state (`design/03-workspace-generating.dc.html`'s `ws-gen-typing-120`) and the SAME
append-never-overwrite mechanism `compose-repair` (F6) already established
(`src/ui/app/model/primary-input.ts`'s `applyTurnTerminal`, built on `setPrimaryInput`). This
alone satisfies WP-9's own done-when: the user is one keystroke (⏎) from retrying.

**NOT shipped, and NOT invented:** a new attach line, a new status-bar hint, or a "retry"/
"re-send" affordance drawn ON the failed chat record itself. Each needs a design decision this
plan does not have. A real retry affordance needs, at minimum, these screens/states to exist
first — none of them do today:

- A failed-turn chat record's own visual treatment (color, glyph, whether it reads as a
  `system:error` line or something new) — `design/12-errors-edge-states.dc.html` has no such row.
- A re-send key hint on the status bar or the composer attach line, and its wording — the
  existing attach-line vocabulary (`ws-gen-typing-120`, `wsHostCrash`'s F6 line) is for a
  DIFFERENT case (a live repair prompt, not a settled failure record).
- Whether re-send targets the SAME turn (retry) or opens a fresh one — a decision `design/`
  nowhere states, and the two read very differently in a chat transcript.

NO OWNER. Whoever picks this up must design the screen(s) first (per CLAUDE.md's own rule: design
updates before code follows it, exactly as `docs/superpowers/red-debt.md`'s "UI: the repair
prompt names a path that cannot exist" row above was eventually closed), then wire it — never the
reverse.

## Debt accumulated by the design-agent feedback-loop repair, recorded here by its own Task 13

Plan `docs/superpowers/plans/2026-08-09-design-agent-feedback-loop.md`, spec
`docs/superpowers/specs/2026-08-09-design-agent-feedback-loop-design.md`, tasks 1-13, base
`4612cea`. Full per-task evidence — every reviewer verdict, every fix round, every deferred minor —
is in `.superpowers/sdd/2026-08-09-design-agent-feedback-loop/progress.md` and the twelve
`task-N-report.md` files beside it. The plan's four spikes are
`docs/spikes/{10-reatom-dts-inline,11-sdk-mcp-tool,12-resume-rejection,13-determinism-blast-radius}/SPIKE.md`,
all four RUN, all four carrying a real verdict.

**The WP-9 row immediately above belongs to this plan too** — Task 11 wrote it directly rather than
deferring it to this closeout, so it is not repeated below. Everything else this plan opened is
here.

Same rule this file has followed since the phase-1 closeout: closing a debt row must not create a
fresh, untracked one. This plan closed none and opened the rows below.

### The Gate's declaration copy grew 11× and one whole-tree type check costs ~17 ms more — MEASURED, accepted, with the follow-up named

Task 7 inlined `@reatom/core`'s ambient module into the Gate's copy of the generated runtime
declaration, so an `atom<readonly T[]>` read finally types instead of degrading to `any`. What it
cost, both figures measured on this machine (win32-x64, Bun 1.3.14) and both an exact match for
spike 10's own prediction:

| | before | after |
| --- | --- | --- |
| Gate copy of `RUNTIME_DTS` | 30,480 chars | **346,435 chars** |
| one `runTree` type check, five-page tree with a shared module (median of five) | 46 ms | **63 ms** |

The prompt copy is untouched at 30,480 chars / 30,744 bytes — verified by independent regeneration
twice, once per review round, zero changed lines. Spike 10 measured the same size pair and
48 → 61 ms; Task 7 measured 46 → 63 ms. **+17 ms against the spike's +13 ms is NOT filed as a
regression** and must not be retold as one: the two runs bracket each other (Task 7's baseline was
2 ms faster than the spike's, its inlined 2 ms slower), the min/max spreads overlap heavily on both
sides (44-67 vs 53-68), and the parsed text is the same 316 KB. The diagnostics count moved the
right way at the same time: 5 manufactured `TS7006`s → 0.

The named follow-up, if this ever does regress materially: `gate/model/type-check.ts:340` constructs
a fresh compiler API per check (`new API(...)`), so the 316 KB is re-parsed every whole-tree pass.
Reusing that snapshot across Gate runs is a caching decision with its own invalidation story — named
in the plan's own "deliberately left undone" table, deliberately NOT taken here, and it is the first
thing to reach for rather than trimming the inline. No owner, because nothing today triggers it.

### `@reatom/core`'s DOM references degrade to the error type inside the `.d.ts` — bounded, and widening `lib` to `dom` is explicitly NOT the answer

C4, and spike 10 measured the prediction rather than assuming it: the inline introduced **ZERO**
DOM-global diagnostics. `skipLibCheck: true` silences them entirely; each unresolved reference
degrades to the error type INSIDE the declaration and never reaches an authored page's diagnostics.
Counted in the inlined declaration: `AbortController` ×16, `AbortSignal` ×11, `EventTarget` ×5,
`Element` ×6, `document` ×7, `localStorage` ×8.

**Do not "fix" this by widening `lib`.** `SYNTHESIZED_COMPILER_OPTIONS` pins `lib: ["esnext"]` and
`types: []` (`src/gate/model/type-check.ts:73-83`), and the pin is load-bearing — its own comment
says `document` must not exist in a TUI. Making `document` visible to authored pages so that
Reatom's own internals type would trade a real guarantee for a cosmetic one. The degradation does
not touch the failure this task existed to fix: `atom<readonly T[]>(…)` → `Atom<readonly T[]>` →
call → `readonly T[]` → `.map` has real signatures throughout.

Recorded as a bounded, documented degradation, not as an open gap. No owner, and none is wanted.

### S1: every lowercase raw JSX element is a fatal `TS7026` — a DEFECT, not a limitation, and NO OWNER

`TS7026: JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements'
exists.` — two per element, on **every fixture, in every variant, baseline included**. Found
incidentally by spike 10 while probing something else. **Task 7's inline neither caused it nor
fixed it**: it is present at baseline, before the inline, and structural —
`JSX.IntrinsicElements` lives in the JSX namespace of `@opentui/react/jsx-runtime`, which the
generated declaration re-exports BY SPECIFIER and which does not resolve hermetically (see the C5
row below for why those types cannot be supplied).

**Why this is a defect and not a documented limitation, which is the whole point of this row.** The
system prompt actively TEACHES the escape hatch — `agent/prompt/model/prose.ts`'s
`DESIGN_CODE_RULES` describes lowercase tags as "a low-level/raw OpenTUI primitive (the runtime's
escape hatch, e.g. `<box>`/`<text>`)" — and `gate/model/lints.ts`'s `lintUnpointedElements` exists
specifically to WARN about a lowercase tag carrying no `id`, which presumes such tags are legal and
expected. A page that follows this project's own documented guidance is rejected by this project's
own Gate, naming an interface its author has never heard of and cannot supply. Per this
repository's standing rule, that is a defect recorded where it will be acted on, never a
"limitation" waved through.

**Why nobody noticed, verified three ways** (all three re-checked by Task 7, not inherited):

1. `src/gate/model/type-check.test.ts:20-22`'s stand-in declaration says so out loud: it covers
   "exactly what those fixtures use — **no JSX**, so no jsx-runtime resolution is dragged in."
2. The real-declaration suite at `type-check.test.ts:183` DOES use JSX, but every fixture uses only
   **capitalized** Kit components (`<Panel>`, `<Text>`), which are declared inside the ambient
   module and therefore resolve. Lowercase intrinsics appear in no fixture in that file.
3. The real, **Gate-ACCEPTED** pages in `examples/clock/.termcraft/design/pages/` contain **zero**
   lowercase JSX tags — `grep -oE "<[a-z][a-zA-Z]*"` returns five hits and all five are generic type
   arguments (`atom<number>`, `atom<readonly …>`). The authoring agent happened to use Kit
   components throughout.

**Pinned, not fixed.** Task 7 added the fixture the Gate's own suite was missing:
`src/gate/model/type-check.test.ts:396-435`, `describe("PINNED DEFECT: lowercase raw JSX elements
are rejected (spike 10, S1)")` → "a page using the documented `<box>` escape hatch comes back with
TS7026". It asserts the code with `.some()` rather than pinning the diagnostic list, because the
compiler emits it twice per element and a count assertion would rot on an unrelated change. The
fixture asserts the CURRENT BROKEN behaviour deliberately; whoever fixes the defect must flip it.

**Two candidate fixes, and choosing between them is a declaration decision, which is why this has
NO OWNER:** either the generated declaration supplies a `JSX.IntrinsicElements` sourced from
`@opentui/react`'s own `jsx-namespace.d.ts`, or lowercase tags stop being advertised as an escape
hatch at all (prompt prose and `lintUnpointedElements` both follow). Both change what the runtime
promises page authors; neither belonged inside this plan.

### `@reatom/react`, `@opentui/react` and unqualified `React.ReactNode` stay UNCHECKED — NO OWNER, and it cannot be closed until React types exist in this project

C5. Task 7 inlined `@reatom/core` and stopped there, on evidence rather than on the spec's size
argument. `@reatom/react`'s declaration is only 2,748 bytes, so size was never the obstacle — its
first three lines are `import { … } from "@reatom/core"`, `import React, { ChangeEvent } from
"react"` and `import { JSX } from "react/jsx-runtime"`, and it closes with a nested
`declare module '@reatom/core' { interface RouteChild extends JSX.Element {} }` augmentation.
**`@types/react` is not installed and `react@19` ships none.** Inlining it would mean INVENTING
React's declarations, which this repository's honest-values rule forbids outright.

The practical consequence, stated plainly so it is not rediscovered: a page's use of
`@reatom/react`, `@opentui/react` or an unqualified `React.ReactNode` is not type-checked by the
Gate. `type-check.ts`'s per-specifier header records which specifiers stay unresolved, including
`@standard-schema/spec`, which Task 7's fix round documented as an explicit kept-not-stripped
decision with nil practical cost (nothing a design page can name reaches `StandardSchemaV1` — no
persistence, no forms, no routing).

NO OWNER. This is not deferred work someone can pick up: it is blocked on React types existing in
this project at all.

### The turn-durability §6.3 rebinding probe is NO LONGER unwritten — spike 12's observation D IS that probe, and it now takes evidence to change the value BACK

`docs/superpowers/specs/2026-07-16-turn-durability-staging-design.md:600-620` (§6.3) expected a
rebindable session and required a probe to establish it. That probe was carried as unwritten debt
for months. **It has now been run** — deliberately, against the real SDK, as spike 12's observation
D (`docs/spikes/12-resume-rejection/SPIKE.md`, SDK `0.3.212`):

- **B** — run a real one-turn session in cwd X, note its session id → succeeded, yielded an id.
- **C** — resume B's real id from **the SAME cwd** → **succeeded**, with positive proof it really
  resumed (the cache figures, not merely a non-error).
- **D** — resume B's real id from a **DIFFERENT** temp cwd → **REJECTED**, with the identical shape
  a fabricated id produces (observation A): a `result` message with
  `subtype: "error_during_execution"`, `num_turns: 0`, `total_cost_usd: 0`, `duration_api_ms: 0`,
  `modelUsage: {}`, a dedicated `errors: string[]` field, and then a throw.

RC6 confirmed: **the SDK indexes sessions by cwd.** That is why
`agent/claude/backend/model/capabilities.ts:31` advertises `sessionWorkspaceBinding: "fixed"`, and
the value is now set from an experiment rather than from an assumption — the comment at `:28-30`
says exactly that.

**What a future probe would have to show to change it back to `"rebindable"`:** a session id created
in cwd X and successfully resumed from a DIFFERENT cwd, with positive proof it really resumed (the
cache-creation-token comparison observation C used, not merely the absence of an error), against the
SDK version actually installed at that time. Anything weaker — a non-throwing call, a resume in the
same cwd, an SDK changelog line — does not clear the bar this probe already met in the other
direction. The row exists so nobody reopens the question on prose.

### S4: `canUseTool` is NOT consulted for every tool the CLI runs — this measurably contradicts a standing, load-bearing claim. NO OWNER

`docs/spikes/08-agent-confinement/FINDINGS.md:18` records, as the verdict it went on to accept,
that "the SDK's per-call permission callback gives termcraft an **in-process veto on every tool
use**, platform-independent" — and its own question 2 asked whether that holds for **every** tool
use. Spike 11 tier 2 (one live, paid turn, `$0.2098`, with `canUseTool` instrumented to log every
call) measured that it does not.

**What was measured.** The model emitted **two** `tool_use` blocks — `ToolSearch` first, then
`mcp__termcraft__check_design` — while `canUseTool` was asked about **only the second**. The MCP
tool was surfaced as a DEFERRED tool the model had to search for first, and the search itself ran
without passing through the in-process veto.

**The caveats, stated honestly, because they bound the finding without dissolving it:**

- `ToolSearch` is a schema-fetching meta-tool. It loads tool definitions and does **no I/O of its
  own**, so nothing escaped confinement in this probe.
- The probe set no `disallowedTools` entry for `ToolSearch`, so what it demonstrates is that the
  **callback was skipped**, not that a deny would have been overridden.
- Other CLI-internal tools were not probed. The finding is "at least one tool runs unvetoed", not a
  census of which ones.

**This is not a limitation row.** The claim it contradicts is load-bearing for the whole confinement
story: the Claude backend's confinement rests on `canUseTool` being the enforcement point, and
`docs/spikes/08-agent-confinement/FINDINGS.md` is what the rest of the project cites for that. A
future SDK that DOES route `ToolSearch` through `canUseTool` would flip the risk to the opposite
face — deny-by-default would refuse the search and `check_design` would become unreachable — which
is why spike 11's own consequence list asks that the deferred-tool path be exercised against the
real production `canUseTool` rather than asserted from the table's contents.

NO OWNER. Closing it means either re-establishing the "every tool use" claim against the installed
SDK (and correcting `FINDINGS.md` where it does not hold), or moving the enforcement point somewhere
the SDK cannot route around — neither of which is a follow-up to this plan.

### `sessionWorkspaceBinding` still has no production reader — C6, re-confirmed after Task 9

Task 9 made the advertised VALUE honest (see the §6.3 row above); it did not make it consumed.
Re-measured at this closeout, `grep -rn sessionWorkspaceBinding src/` finds: the type
(`agent/types.ts:139`), the lifted port field (`core/ports/agent-backend.ts:167`), the one
production WRITE (`agent/claude/backend/model/capabilities.ts:31`), one assertion
(`capabilities.test.ts:12`) and ten test fixtures. **Zero production reads.** In particular
`evaluateSessionPlan` (`core/turns/model/session-plan.ts`) — the comparison that decides whether a
resume is proposed — never consults it, which is exactly what C6 predicted and why flipping the flag
changed no behaviour.

**Whether anything SHOULD read it is the open question, and it is a real one, not a cleanup.** Two
honest resolutions, and the row is deliberately neutral between them:

1. **Make it load-bearing** — `evaluateSessionPlan` refuses to propose a cross-workspace resume when
   the backend advertises `"fixed"`, instead of proposing one and degrading after the SDK rejects it
   (which is what Task 9 shipped). That moves the decision earlier and saves a wasted attempt, but it
   puts a backend capability check inside `core/turns`, which is a layering decision about where the
   resume decision belongs.
2. **Say it is documentation** — mark the field explicitly as advertised-for-humans and stop implying
   a consumer exists. Cheaper, honest, and it closes this row without pretending to close the
   question.

NO OWNER for either. Named as deliberately-undone in the plan's own closing table.

### After a session fallback fires, a Gate rejection has only 2 real retries left, not 3 — DISCLOSED and deliberately not reconciled

Task 9's own disclosed gap, and the most likely of this plan's rows to be misread as a bug report.
Two independent counters exist and were never reconciled:

- `TurnFence.beginAttempt()` (`core/turns/model/fence.ts`) increments its own hard
  `MAX_TURN_ATTEMPTS = 4` ceiling on EVERY attempt, including the session fallback's fresh attempt,
  which does not spend a Gate-retry slot.
- `run-turn.ts`'s local `attempt` counter tracks only Gate retries and does not count the fallback.

Walk the sequence: one rejected resume (fence use #1) → the fallback's fresh attempt (fence use #2,
local counter still "1") → three Gate rejections (fence uses #3 and #4, local counter climbing) —
the local `canRetryAfterGate(3)` still says "you have budget" for what would be the fence's 5th
`beginAttempt()`, which the fence refuses. **So a turn that fell back gets 2 real Gate retries, not
3.**

**What Task 9 DID fix:** the error code is now honest. That exhaustion terminalizes as
`GATE_RETRY_EXHAUSTED`, not the generic `PERSISTENCE_FAILED` it produced before — a user-visible lie
about the cause, fixed in fix round 1. Both sites that used to claim the budget survives intact (the
call site's comment and the test's own name) were corrected in fix round 2 to state plainly that 2
real retries remain, so the tradeoff lives in the code and not only in a report.

**Why the counters were NOT reconciled, which is the part this row exists to preserve.** Reconciling
them means changing `fence.ts`'s semantics — either the fence stops charging an attempt that is not
a Gate retry, or the driver learns the fence's count — and `fence.ts` was outside Task 9's
authorized scope. The fence's hard ceiling is an existing structural property, unrelated to and
unchanged by this task, and relaxing it is a materially larger change than making one error code
honest. The accepted minimum bar for Task 9 explicitly allowed deferring the reconciliation IF it
was documented; it is, at the call site and here.

Owner: whichever task next touches `core/turns/model/fence.ts`'s attempt accounting.

### `selectSeed` bypasses `buildSeed`'s current-user-record exclusion, and Task 9 made it reachable mid-turn — NO OWNER, needs a port-signature change

Pre-existing and latent; Task 9 is the first production caller to expose it, found by the reviewer
and recorded rather than fixed on explicit instruction.

`src/store/adapters/session-checkpoint.ts:88-107`'s `selectSeed(chatId)` calls
`selectSeedRecords(doc.records)` DIRECTLY (line 98) — never
`buildSeed(records, currentUserRecordId)` (`src/store/jsonl/model/checkpoint.ts:173-180`), which is
the function that exists to exclude the CURRENT turn's own user record from the seed. Harmless for
as long as `selectSeed` was only ever called BEFORE `runAdmission` had durably committed the turn's
own user record: there was nothing to exclude yet.

**Task 9's `fallbackToFreshSession` calls it mid-turn, POST-admission.** At that point the chat
document already contains the current user message, so `selectSeedRecords` includes it in the
fallback's own seed — and the fresh session then also receives the same message as its prompt. The
agent can see the current user message twice.

**Why it was not fixed here.** `selectSeed(chatId: string)`'s PORT SIGNATURE takes no
`currentUserRecordId`, so an honest fix widens the port and every implementation and fake of it —
outside Task 9's `Files:` scope, and a change to a contract several rings consume. Note also that
`buildSeed` itself is called (`checkpoint.ts:212`, inside `evaluateSessionResume`) but its result is
not used by any current production caller, so the two are separate channels and fixing one does not
fix the other.

NO OWNER.

### An unresolvable compiler path's async spawn error can escape `type-check.ts`'s try/catch — pre-existing `gate` hazard, first tracked here

Disclosed by Task 12 and, until this row, tracked nowhere but that task's report and one test
comment. Making the real `typescript/unstable/sync` API fail to spawn (a bogus compiler path) raises
an **asynchronous** `error` event that escapes `gate/model/type-check.ts`'s own try/catch and fails
the run for an unrelated reason. Task 12 hit it while trying to provoke a `TYPE_CHECK_UNAVAILABLE`
result honestly, discarded that approach, and used a scripted `GateRunner` instead — which is the
right call for that test, and is why the hazard would otherwise have gone unrecorded.

**Verified unreachable in production TODAY:** `entrypoint/model/create-shell.ts` resolves and
validates the compiler path (`existsSync`) before any project I/O, and aborts the whole shell if it
cannot, so no runner is ever built against an unresolvable path.

**The "unreachable" claim is slightly stronger than what was proven, and that is the reason for the
row.** Startup validation covers a path that is wrong when the app launches. It does NOT cover the
binary being deleted, moved, or made unreadable (EACCES) mid-session, after validation has already
passed — at which point the escaping async error is the failure mode, and it presents as an
unrelated run failure rather than a `TYPE_CHECK_UNAVAILABLE`.

NO OWNER. The fix is small in principle (attach an `error` handler to the spawn, map it to the
existing `TYPE_CHECK_UNAVAILABLE` path) but it is new behaviour on the Gate's failure surface, which
is not something a closeout commit gets to add.

### Deferred minors from this plan's own twelve reviews — each with its evidence, none blocking

Every Minor a reviewer flagged as "deferred, not blocking" across tasks 1-12, listed so the set is
closed rather than scattered across twelve reports. None is a defect; each is named at its own site.

- **Task 1** — `PAGES_MANIFEST_RELPATH` ("pages.json") stays a hardcoded literal in
  `PAGE_FILE_LAYOUT`. Out of the brief's scope (C1 scoped Task 1 to `DESIGN_DIRNAME` only), but a
  future manifest-filename rename would leave that prose stale by exactly the mechanism this task
  just fixed for the tree root. Owner: whoever renames the manifest, if anyone ever does.
- **Task 3** — the file-header paragraph and `toWorkspacePath`'s own doc comment restate overlapping
  context about the two path vocabularies. Both were explicitly requested by the brief; redundant
  prose, not a defect. No action wanted.
- **Task 4** — `docs/architecture/*` still cited the OLD `unguarded-timer`/`unguarded-randomness`
  kind names after the rename to `nondeterministic-time`/`nondeterministic-randomness`. **CLOSED by
  this closeout's own Step 3** (`docs/architecture/flows/export.md`,
  `flows/generation-turn.md`, `flows/interactive-prototype.md`, `modules.md`). The plan, the spec and
  this ledger's own historical rows still carry the old names ON PURPOSE — they are dated records of
  what was measured, not live claims.
- **Task 6** — `examples/clock`'s `stopwatch.tsx`/`timer.tsx` carry `tick` action bindings that are
  currently unused (a future interactive driver's hook). Inert by design, and not currently
  type-checked at all, since `examples/` sits outside the root tsconfig's `include`. Would need
  addressing if that scope ever changes.
- **Task 7**, four from the re-review: (a) `scripts/gen-runtime-dts.ts`'s doc comment and Task 7's
  report both say "twelve" references to the orphaned-if-stripped declarations; the verified count is
  **nine** — a wording fix, ironic given that round's own subject was verification accuracy;
  (b) `checkInlinability`'s `/// <reference>` branch tests the RAW string while the import/export
  branches test the COMMENT-STRIPPED string, so a `*//// <reference …>` form would slip both — the
  same blind spot as the finding that round fixed, compressed to a triple slash; no such form exists
  in the real file today; (c) `checkInlinability` has no direct unit test (`main()` runs on import
  and the function cannot easily be extracted) — only the emitted block's shape is pinned, and the
  re-reviewer verified the logic by hand instead; (d) Task 7's report says "9 tests" where there are
  11, including its two new ones.
- **Task 9**, three from the round-2 re-review: a documented, consciously-accepted third variant of
  the promptDelta conflation, gated behind the already-flagged type-impossible defensive branch; a
  slightly under-inclusive doc list; and one test-strength nit. All three are recorded in
  `.superpowers/sdd/2026-08-09-design-agent-feedback-loop/progress.md`'s Task 9 entry.
- **Task 10** — `SurvivingWarningV1`'s `file`/`line`/`column`/`blockedPages` fields are speculative
  flexibility, unexercised by the only real caller (`ChatWarningSnapshot` only ever supplies
  `kind`/`message`). Defensible because `TurnGateWarningDtoV1` is module-private; recorded so a
  reader does not mistake the wider shape for a populated one.
- **Task 11**, two: a test-comment discoverability nit and cosmetic spacing in the ledger entry it
  wrote. Neither blocking.
- **Task 12**, two from round 2: an orphaned doc-comment ordering in `gate/model/type-check.ts`, and
  the report's own "every surviving line" table missing one dated-but-accurate historical doc line.
  Neither blocking.

### Considered and homed elsewhere — deliberately NOT given a row here

- **Task 5's residual duplication** (a warning `runPage` and `runTree` both produced for an entry
  rendering TWICE in the retry fold) was **FIXED under a human ruling**, not deferred —
  `dedupeWarnings` in `core/turns/model/validation.ts`, scoped to the three overlap-capable kinds,
  keeping the `blockedPages`-attributed copy, with a genuine RED→GREEN regression test
  (`9c44663..819a6b7`). `gate/adapters/gate-runner.ts`'s "WHAT THIS DOES NOT CLAIM" section says
  fixed, not still-open.
- **Task 8's defensive-path asymmetry** (the `userMessage` sub-path does not accumulate across
  repeated defensive fires, unlike the `promptDelta` sub-path) — pre-existing, unchanged by the fix
  that surfaced it, and documented-unreachable either way.
- **Task 12's `check_design` freeze** — measured (~0.1-0.2 s, zero event-loop ticks during the call),
  disclosed in five places, and mitigated by a content-keyed memo. Homed at its own sites, not a
  ledger row.
- **Task 12's `silencing-any` asymmetry** (`check_design` renders warnings the actual retry fold
  excludes) — a correct, disclosed asymmetry that closes an `: any`-exploit path against the fatal
  `TS7006`, kept under its own non-fatal header. Upheld by the reviewer; documented at the site.
