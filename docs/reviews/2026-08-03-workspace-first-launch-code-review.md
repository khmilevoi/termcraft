# Workspace-first launch — code review findings (2026-08-03)

Source: `/code-review medium` run against the `workspace-first-launch` branch diff (8 finder
agents + a verification pass). Two confirmed bugs, four code-quality observations. Each entry
lists the files to read, in order, to reconstruct why the finding is real.

**Status (2026-08-03, same day): findings 2–6 fixed via parallel subagents, verified (typecheck
clean, affected suites green, `/reatom-audit` clean, `docs/architecture/` synced). Finding 1 left
open on purpose — see its own status line below.**

## 1. `HostCrashPanel` overflow deepened by the `agentBlocked` line — CONFIRMED

**File:** `src/ui/preview/ui/HostCrashPanel.tsx:220`

Adding the `agentBlocked` line makes the panel need 22 rows against the 18-row region it is
handed at a 120×24 terminal (vs. an exact 18/18 fit with `agentBlocked: null`) — the block's top
border overwrites the tab-strip rule and its bottom border row is lost. At 80×24 the deficit is
13 rows, at 100×24 it is 9.

**Not a new regression.** This is already tracked in-code as **"KNOWN DEFECT (branch review
finding 1, 2026-08-02 fix wave)"** — a previous review round found the same thing, and it was
deliberately left open because a real fix needs predicting wrapped-row counts across a
`flexDirection="row"` `KeyRow` *before* OpenTUI's layout pass runs, which the comment calls "a
bigger change than this fix wave carries."

**Read for context, in order:**
1. `src/ui/preview/ui/HostCrashPanel.tsx:159-219` — the DIVERGENCE 3 comment: why OpenTUI wraps
   instead of truncating, the engine's under-budgeted `bh += agentDead ? 2 : 0`
   (`design/termcraft-engine.js:1207`), and the exact overflow math at all three supported
   terminal widths.
2. `src/ui/preview/ui/HostCrashPanel.test.tsx:171-181` — the pinned "KNOWN DEFECT" test; this
   review's numbers should match it exactly.
3. `src/ui/workspace/ui/Workspace.tsx` (the `ws-preview` box, `overflow="hidden"`) — the clipping
   ancestor that turns the row deficit into the specific border/padding loss described above.
4. `design/termcraft-engine.js:1207` — the design's own (undercounted) row budget for this branch.

**Status: left open, deliberately.** Not attempted in the 2026-08-03 fix wave — the comment above
is explicit that a real fix needs predicting wrapped-row counts across a `flexDirection="row"`
`KeyRow` *before* OpenTUI's layout pass runs, which is a bigger change than a review-response
patch should carry. Forcing it through a subagent risked exactly the half-finished-implementation
failure mode this project's own conventions warn against. Tracked here as still open, not silently
dropped; needs its own scoped plan if picked up.

## 2. Failed startup `project.open` returns to a silent Home — CONFIRMED

**File:** `src/entrypoint/model/run-app.ts:168`

If the Gap D startup `project.open` (for an existing project) fails to dispatch or is rejected,
`root.abandonStartupOpen()` runs and `deriveScreen` drops the user back on Home — but
`HomeOpenFailurePanel` never fires, because it is gated on `ProjectMirror.openFailure`, which is
only set by a genuine Kernel `blockOpen`, a state this path never reaches. The user sees a bare,
unexplained Home and can only retry blindly via Enter.

**Also already flagged**, in the same file's header comment, as an open design gap — but per
[[dont-launder-ux-defects-as-known-gaps]], "documented" isn't the same as "acceptable": it still
makes the retry experience look broken and is worth tracking as an actionable defect rather than
dismissing it because the gap is named.

**Read for context, in order:**
1. `src/entrypoint/model/run-app.ts:128-180` — the Gap D dispatch and its own comment, which
   explains exactly why `HomeOpenFailurePanel` cannot fire on this branch.
2. `src/ui/app/model/deps.ts:606-646` — the *other* failure path (Kernel `blockOpen` →
   `recoverFromBlockedOpen`), which DOES surface `HomeOpenFailurePanel`; contrasting the two
   shows why this one is silent by construction, not by oversight.
3. `src/ui/home/ui/HomeOpenFailurePanel.tsx` — what the "diagnosed" version of this recovery looks
   like when `openFailure` is set.
4. `src/ui/mirror/model/screen.ts:41-53` — `deriveScreen`: confirms `projectId === null` routes
   back to `"home"` once `startupOpenPending` clears.
5. `docs/architecture/flows/launch.md:257` — the architecture doc's own prior account of this
   exact gap ("Gap D").

**Status: fixed.** `UiLocalState.startupOpenFailure` is a new, separate UI-local reading (never
folded into `ProjectMirror.openFailure`, keeping that field's kernel-truth invariant intact);
`run-app.ts`'s two failure branches now hand `abandonStartupOpen` a `ProjectOpenFailure`-shaped
value, and `App.tsx` composes it with the mirror's own `openFailure` (`??`) into Home's single
prop — the two sources are mutually exclusive by construction. `HomeOpenFailurePanel` now fires
for this path with an honest, non-invented message (the dispatch error's own text, or the
Kernel's rejection code). All comments this made stale (`run-app.ts`, `intent.ts`, `deps.ts`,
`HomeOpenFailurePanel.tsx`, `docs/architecture/flows/launch.md`) were rewritten, not just the
code. New regression coverage in `App.test.tsx` proves the panel now renders on this path.

## 3. `startupOpenPending` is a manually-cleared atom, not a `computed()`

**File:** `src/ui/app/model/deps.ts:661`

The monotonic `true → false` flag is a mutable atom with two independent, manually-wired
clearers — `abandonStartupOpen` (failure path) and a guarded branch inside
`mirror.project.subscribe` (success path) — instead of a `computed()` derived from
`mirror.project().projectId`. Not a bug today (both paths are covered and tested), but any future
`projectId: null → non-null` transition that doesn't go through this one wired subscription would
leave the flag stuck `true`.

**Read for context, in order:**
1. `src/ui/app/model/deps.ts:301-305` — the atom declaration and its `startupOpenPending()` reader.
2. `src/ui/app/model/deps.ts:661-686` — the success-path clearer and its guard, with the comment
   explaining why it lives on this subscription rather than a dedicated effect.
3. `src/ui/app/model/deps.ts:811, 830-832` — the failure-path clearer (`abandonStartupOpen`) and
   final wiring.
4. `src/ui/mirror/model/mirror.ts`, `src/ui/mirror/types.ts` — `ProjectMirror`'s shape, to see what
   a `computed()` version would read.
5. `src/ui/app/model/deps.test.ts` — existing coverage of this flag's transitions, i.e. what a
   refactor would need to keep passing.

**Status: fixed.** `startupOpenPending` is now `atom(env.projectExists, ...).extend(withComputed(
(state) => (mirror.project().projectId !== null ? false : state)))` (RTM-S02) — the success-path
clearer (the `clearStartupOpenPending` bind plus its branch inside `mirror.project.subscribe`) is
deleted; the derivation reads `mirror.project()` directly, so any future route to a non-null
`projectId` clears the flag automatically rather than depending on one specific wired
subscription. `abandonStartupOpen`'s manual `.set(false)` (failure path) is untouched and still
works on a `withComputed`-extended atom. New test in `deps.test.ts` proves this by driving
`projectId` non-null through a path that bypasses the old subscription entirely.

## 4. Workspace's `filling` fact threaded manually into 6 call sites

**File:** `src/ui/workspace/ui/Workspace.tsx:421`

`const filling = mirror.project().projectId === null` is computed once but then passed as an
explicit parameter into six separate derivations: `modeChip` (`:813`), `hintKeys` (`:854`), the
preview-region branch (`:820`), the composer placeholder (`:594`), and the status-bar `size`
gate (`:832`) — six places a future "opening" UI change has to remember to touch, rather than one
consolidated view-model.

**Read for context, in order:**
1. `src/ui/workspace/ui/Workspace.tsx:77-135, 286-300, 420-421, 594, 805-854` — every `filling`
   call site listed above, in file order.
2. `src/ui/workspace/types.ts` — `WorkspaceLocalState`, the natural home for a consolidated
   "screen state" derivation.
3. `src/ui/workspace/ui/Workspace.test.tsx` — coverage of each of the 6 sites individually.

**Status: fixed (5 of 6).** A new `workspaceOpeningChrome(w)` bundles the five scalar branches
(`modeChip`, `hintKeys`, `composerPlaceholder`, the status-bar `page` text, the `size` gate) into
one derivation computed once per render; `modeChip`/`hintKeys` lost their `filling` parameter
entirely. The sixth site, `previewRegion`'s own `filling` branch, was deliberately left
untouched — it returns a full JSX subtree, not a small value, so folding it into the same
abstraction wasn't a genuine win. All design-anchored comments on the five branches were carried
over verbatim onto the new function; `Workspace.test.tsx` passes unmodified (zero behavior
change).

## 5. `agentHealthBadge` duplicates `Home.tsx`'s `homeStatusBadge`

**File:** `src/ui/agent-health/model/badge.ts:32`

Both functions build a `StatusBarHintBadge` from the same `AgentHealth` five-branch precedence.
The plan's own documented divergences (Task 6/7 wording differences) are intentional, but the
branching structure itself is duplicated rather than shared with per-screen wording overrides.

**Read for context, in order:**
1. `src/ui/agent-health/model/badge.ts:32-63` — `agentHealthBadge`.
2. `src/ui/home/ui/Home.tsx` — `homeStatusBadge` (search for the function definition) — the
   duplicate branch, plus the two documented wording divergences (see `Home.tsx:56` and the
   F6-detail comment cited in the plan).
3. `src/ui/agent-health/model/badge.test.ts` and `src/ui/home/ui/Home.test.tsx` — tests for both,
   to see which cases would need to stay screen-specific if these were merged.

**Status: fixed.** Both functions now call a shared `buildAgentHealthBadge(health, options,
wording)` (exported from `ui/agent-health`) that holds the one copy of the five-branch precedence;
the two documented divergences (`checking`'s Home-only `" — ⏎ disabled"` suffix, and the
`latched` wording split) are passed in as a small `wording` object per call site rather than
unified away. `homeStatusBadge` keeps an explicit `missing -> null` guard (documents intent
instead of relying on Home simply never reaching that branch). All divergence-rationale comments
were preserved and relocated onto the shared builder / the two wording constants. Every existing
assertion in `badge.test.ts`, `Home.test.tsx`, `HostCrashPanel.test.tsx`, and `Workspace.test.tsx`
still passes unmodified.

## 6. `resolveShellLaunch` is now a no-op pass-through

**File:** `src/entrypoint/model/create-shell.ts:358`

After `probeProjectContent` was removed (spec 2026-08-02: route on `existing`, not `hasContent`),
`resolveShellLaunch` is `return { existing }` with no remaining logic — kept only to pin the
`ShellLaunchV1` contract in a dedicated test. Not a runtime bug, just an indirection that could be
inlined at its one call site.

**Read for context, in order:**
1. `src/entrypoint/model/create-shell.ts` — `resolveShellLaunch` and its one call site.
2. `src/entrypoint/model/create-shell.test.ts` — the test asserting this exact contract, the
   stated reason the function still exists.
3. `src/entrypoint/types.ts` — the `ShellLaunchV1` type this function's return shape pins.

**Status: fixed.** Inlined at the one call site (`const launch: ShellLaunchV1 = { existing };`);
the function and its dedicated pinning test are deleted. The `{ existing }` contract stays covered
by the existing `createShell`/`openOrCreateProject` integration tests, which already assert
`shell.launch` with `toEqual` (exact-shape, so a stray field still fails loudly). Doc references
in `docs/architecture/flows/launch.md` and `modules.md` updated; the dated historical entries in
`docs/mvp-remaining-work.md` were left as-is on purpose (they describe a past state, not current
code).
