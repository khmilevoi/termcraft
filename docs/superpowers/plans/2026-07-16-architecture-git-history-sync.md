# Architecture Git-History Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every document under `docs/architecture/` into exact agreement with the approved Git-backed page-history continuation specification.

**Architecture:** Close two source-spec gaps first, then update the component model, storage/lifecycle flows, central generation/history/export flows, and peripheral interaction flows. Keep the existing documentation template and treat `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md` as authoritative wherever it supersedes private page versions, history, rollback, or Git integration.

**Tech Stack:** GitHub-flavored Markdown, Mermaid, PowerShell verification, Git.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-07-13-termcraft-design.md` plus `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md`; the continuation wins for page storage, history, rollback/Restore, chat change records, and Git controls.
- MVP has one canonical `.termcraft/pages/<slug>/page.tsx` per page and no history or Git UI.
- v1 history uses the current `HEAD` first-parent chain and exposes explicit scoped commit controls; Git remains optional.
- Agent records use `changedPages: string[]`; no architecture document may retain private `vN`, version-valued `applied`, copy-forward rollback, or auto-rollback behavior.
- A whole turn is not crash-atomic. Only individual tmp-plus-rename file replacement is atomic until a separate Turn Transaction design exists.
- Preserve the architecture document form: opening paragraph, Mermaid diagram where present, `## Walkthrough`, and `## Source anchors`. `README.md` remains the index exception without Source anchors.
- Add the continuation spec to every architecture document whose behavior it governs.
- Do not edit application code or visual prototype files.
- Do not stage or restore the pre-existing deletion of `docs/superpowers/plans/2026-07-13-termcraft-mvp.md`.

---

### Task 1: Close source-spec gaps and update the system/component model

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md`
- Modify: `docs/architecture/README.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/modules.md`

**Interfaces:**
- Produces: the authoritative Git adapter placement, canonical-source startup failure behavior, and export-source rule consumed by Tasks 2–4.
- Produces: an eight-component architecture with `Git adapter` implementing `GitHistory` and `GitCommitter` ports for the Kernel.

- [ ] **Step 1: Close the continuation-spec gaps**

Add explicit decisions:

- the Git adapter is the eighth top-level component and is the only module that invokes the installed Git CLI;
- a broken canonical `page.tsx` is never replaced automatically at launch: Workspace opens with a preview error panel, sending a repair turn remains possible, and v1 additionally offers explicit Git Restore when history exists;
- export always uses canonical current sources from disk, including uncommitted changes, never Git `HEAD` merely because it is committed and never the selected historical snapshot.

- [ ] **Step 2: Update the architecture index**

In `README.md`, distinguish MVP from v1, replace append-only/copy-forward wording with Git history/Restore/scoped commits, and point readers to the continuation as a governing specification.

- [ ] **Step 3: Update system context**

In `overview.md`, make Git optional, add the installed Git CLI and target repository interaction to the Mermaid diagram, describe history and user-confirmed scoped commits as v1-only, and clarify workspace trust is about executing project code regardless of how the folder arrived.

- [ ] **Step 4: Update component ownership**

In `modules.md`:

- change seven components to eight;
- add `Git adapter` and Kernel `GitHistory`/`GitCommitter` ports;
- replace Project store versions with canonical page sources;
- describe the host as executing a selected source snapshot (current, staging candidate, export, or historical);
- assign commit split-button presentation to UI and planning/revalidation/mutex orchestration to Kernel;
- state commit remains available during a turn while Restore is locked and historical Send/Tweaks are disabled;
- narrow “no other channel” to the UI–Kernel–host runtime loop.

- [ ] **Step 5: Verify Task 1**

Run:

```powershell
git diff --check -- docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md docs/architecture/README.md docs/architecture/overview.md docs/architecture/modules.md
Select-String -Path docs/architecture/modules.md -Pattern 'Git adapter|GitHistory|GitCommitter|canonical|project-write mutex'
Select-String -Path docs/architecture/README.md,docs/architecture/overview.md,docs/architecture/modules.md -Pattern 'vN\.tsx|copy-forward|append-only page versions'
```

Expected: diff check exits 0; required new terms are present; stale-term search returns no matches.

- [ ] **Step 6: Commit Task 1**

Commit only the four Task 1 files with message:

```text
docs(architecture): add Git integration boundaries
```

---

### Task 2: Update storage, launch, chats, and migration

**Files:**
- Modify: `docs/architecture/storage.md`
- Modify: `docs/architecture/flows/launch.md`
- Modify: `docs/architecture/flows/chats.md`
- Modify: `docs/architecture/flows/migration.md`

**Interfaces:**
- Consumes: Task 1's canonical-source launch behavior and Git adapter boundary.
- Produces: the durable layouts and record schemas referenced by the remaining flows.

- [ ] **Step 1: Replace the persisted page/version model**

Rewrite `storage.md` around `pages/<slug>/page.tsx`, remove numbered versions/head numbering/create-new collision handling, define Git as optional, and document the three v1 commit scopes. Use `*.local.*` for local-state exclusion. Keep chats, pins, trust, staging, format counters, and export layout where still current.

- [ ] **Step 2: Replace chat schemas**

Document agent `changedPages: string[]`, an empty list for no change, and a Restore system record naming page and source commit. Remove rollback and version-valued `applied` fields.

- [ ] **Step 3: Update launch behavior**

Remove last-valid-private-version fallback. Show canonical source load, preview error on broken source, repair-turn availability, optional v1 Git Restore, and Git/non-repository states that do not block startup. Correct the Mermaid diagram so the MVP path does not require the v1 wizard.

- [ ] **Step 4: Update chats and migrations**

Use current/canonical sources in `chats.md`; remove rollback terminology. In `migration.md`, state kit codemods target canonical current sources only, never historical Git objects; historical sources may fail the current Gate and remain unrestorable. Because the project is pre-code, no shipped `vN`-layout migration exists or is required.

- [ ] **Step 5: Verify Task 2**

Run:

```powershell
git diff --check -- docs/architecture/storage.md docs/architecture/flows/launch.md docs/architecture/flows/chats.md docs/architecture/flows/migration.md
Select-String -Path docs/architecture/storage.md,docs/architecture/flows/launch.md,docs/architecture/flows/chats.md -Pattern 'v1\.tsx|vN\.tsx|applied map|"applied"|copy-forward|auto-rollback|last valid version'
Select-String -Path docs/architecture/storage.md -Pattern 'page\.tsx|changedPages|Commit infrastructure|Commit entire project|\*\.local\.\*'
```

Expected: diff check exits 0; stale-term search returns no matches; required storage terms are present.

- [ ] **Step 6: Commit Task 2**

Commit only the four Task 2 files with message:

```text
docs(architecture): replace private version storage
```

---

### Task 3: Rewrite generation, history, and export flows

**Files:**
- Modify: `docs/architecture/flows/generation-turn.md`
- Modify: `docs/architecture/flows/versions.md`
- Modify: `docs/architecture/flows/export.md`

**Interfaces:**
- Consumes: Task 2's canonical source and chat schemas.
- Produces: the central Git browsing, Restore, scoped-commit, and current-source export behavior.

- [ ] **Step 1: Rewrite generation apply semantics**

Replace `vN` creation with canonical `page.tsx` replacement, `version-applied` with page/source change events, and `applied` with `changedPages`. Remove whole-turn atomicity claims and say individual files use tmp-plus-rename. Keep staging, Gate, retries, cancellation, session fallback, and page management. Document that commit controls remain usable during a turn and share the project-write mutex only with final apply.

- [ ] **Step 2: Replace the versions flow in place**

Rewrite `versions.md` completely around:

- MVP absence of history UI;
- `Current design` / `Current design · uncommitted`;
- current-HEAD first-parent history and partial-history states;
- temporary read-only historical snapshots;
- disabled historical Send/Tweaks;
- explicit Restore with staged/index/freshness/Gate checks;
- commit split-button, page/infrastructure/whole-project scopes, dots/counts/message/file preview;
- hooks/signing, detached HEAD, sequencer blocking, optional Git, and post-command refresh.

Remove obsolete private-version visual anchors.

- [ ] **Step 3: Update export source semantics**

In `export.md`, replace head-version/rollback language with canonical current source from disk. State export ignores the selected historical preview and includes uncommitted current design. Keep deterministic fresh-host capture and all-or-nothing package writing.

- [ ] **Step 4: Verify Task 3**

Run:

```powershell
git diff --check -- docs/architecture/flows/generation-turn.md docs/architecture/flows/versions.md docs/architecture/flows/export.md
Select-String -Path docs/architecture/flows/generation-turn.md,docs/architecture/flows/versions.md,docs/architecture/flows/export.md -Pattern '\bvN\b|version-applied|applied map|copy-forward|auto-rollback|head version'
Select-String -Path docs/architecture/flows/versions.md -Pattern 'Current design|first-parent|Restore|Commit current page|Commit infrastructure|Commit entire project|project-write mutex'
```

Expected: diff check exits 0; stale-term search returns no matches; required history terms are present.

- [ ] **Step 5: Commit Task 3**

Commit only the three Task 3 files with message:

```text
docs(architecture): document Git-backed page history
```

---

### Task 4: Update interaction flows and run zero-drift verification

**Files:**
- Modify: `docs/architecture/flows/interactive-prototype.md`
- Modify: `docs/architecture/flows/pins-and-selection.md`

**Interfaces:**
- Consumes: Task 3's current-design/historical-snapshot terminology.
- Produces: final cross-document consistency.

- [ ] **Step 1: Update prototype lifecycle terminology**

Replace page/version switch and version-file language with page switch, historical snapshot selection, return to exact current source, and canonical-source apply. Explicitly disable Tweaks while browsing history.

- [ ] **Step 2: Update pins and selection**

Describe selection and current-pin overlays against historical renders, state browsing never restores or changes pin records/statuses, and resolve send-time context only against the active canonical current source. Note that pin-only commits never select page-history entries.

- [ ] **Step 3: Verify every source anchor and remove systemic drift**

Run:

```powershell
$docs=Get-ChildItem docs/architecture -Recurse -File -Filter *.md
$docs | Where-Object {$_.Name -ne 'README.md'} | ForEach-Object { if(-not (Select-String -Path $_.FullName -Pattern '2026-07-16-git-backed-page-history-design.md' -Quiet)){ $_.FullName } }
$docs | Select-String -Pattern '\bvN\b|v1\.tsx|vN\.tsx|version-applied|applied map|"applied"|copy-forward|auto-rollback|head version|highest version'
$docs | Select-String -Pattern 'GitHistory|GitCommitter|Current design|first-parent|changedPages|Commit current page'
git diff --check -- docs/architecture docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md
```

Expected: missing-anchor and stale-term commands produce no output; new-model search produces matches; diff check exits 0.

- [ ] **Step 4: Commit Task 4**

Commit only the two Task 4 files plus any strictly necessary source-anchor corrections discovered by Step 3, with message:

```text
docs(architecture): finish Git history terminology sync
```
