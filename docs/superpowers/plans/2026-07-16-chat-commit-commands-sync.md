# Chat Commit Commands Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v1 Git commit split-button with `/commit-page`, `/commit-infra`, and `/commit-all` composer commands while preserving the existing confirmation, scope, concurrency, and failure contracts.

**Architecture:** Commit planning and execution remain Kernel operations through `GitCommitter`; only the UI trigger and status presentation move into the shared action-table/slash-menu path. While an agent turn runs, normal message sending stays locked but the composer can still enter local slash-command mode, where the three commit commands remain available and other locked commands stay dimmed.

**Tech Stack:** Markdown product specification, Mermaid architecture flows, Claude Design prompt.

## Global Constraints

- The three command names are exactly `/commit-page`, `/commit-infra`, and `/commit-all`.
- Each command opens the existing editable-message and exact-path confirmation dialog without changing commit execution semantics.
- Dirty dots and changed-file counts live on slash-menu command rows; there is no persistent commit button, split-button, dropdown arrow, or mouse twin.
- Commit commands remain usable during an agent turn; only scoped commit execution and final apply contend through the project-write mutex.
- Preserve the user-owned unstaged deletion of `docs/superpowers/plans/2026-07-13-termcraft-mvp.md`.
- `design-prompts/` is intentionally ignored; update the prompt locally without force-adding it.

---

### Task 1: Update governing specifications

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md`
- Modify: `docs/superpowers/specs/2026-07-13-termcraft-design.md`

**Interfaces:**
- Consumes: existing `CommitScope`, confirmation, revalidation, Git-error, and mutex contracts.
- Produces: canonical slash-command names, availability, status-row, and turn-time composer behavior for architecture documents.

- [x] **Step 1:** Replace the continuation's split-button/dropdown trigger with the three exact commands and scope mappings.
- [x] **Step 2:** Move dots, counts, clean-scope disabling, and accessible status copy onto slash-menu rows while leaving the confirmation dialog unchanged.
- [x] **Step 3:** Specify local slash-command mode during a running turn and keep non-commit locked commands dimmed.
- [x] **Step 4:** Update UI tests and acceptance criteria from split-button language to command-row language.
- [x] **Step 5:** Extend the master spec's composer command list and v1 command-set summary with the continuation-owned commands.

Verification:

```powershell
Select-String -Path docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md,docs/superpowers/specs/2026-07-13-termcraft-design.md -Pattern '/commit-page|/commit-infra|/commit-all|split-button|dropdown arrow'
```

Expected: all three commands are present; no active split-button or dropdown-arrow requirement remains.

### Task 2: Synchronize architecture ownership and flows

**Files:**
- Modify: `docs/architecture/modules.md`
- Modify: `docs/architecture/storage.md`
- Modify: `docs/architecture/flows/chats.md`
- Modify: `docs/architecture/flows/generation-turn.md`
- Modify: `docs/architecture/flows/versions.md`

**Interfaces:**
- Consumes: Task 1's command names and availability rules.
- Produces: one action-table-driven trigger path from composer to the unchanged Kernel commit planning/dialog flow.

- [x] **Step 1:** Replace UI-shell ownership of the split-button with slash-command rendering, per-command status, and confirmation presentation.
- [x] **Step 2:** Add the three commands to the slash-menu flow and action descriptions.
- [x] **Step 3:** Document that slash-command mode remains openable while message sending is locked during a turn; only commit commands remain enabled among turn-locked project actions.
- [x] **Step 4:** Rewrite the versions flow's trigger/status sections without changing scope contents, confirmation, revalidation, errors, or mutex semantics.
- [x] **Step 5:** Associate storage's three scopes with their exact command names.

Verification:

```powershell
Get-ChildItem docs/architecture -Recurse -File -Filter *.md | Select-String -Pattern 'split-button|primary button|dropdown arrow'
Get-ChildItem docs/architecture -Recurse -File -Filter *.md | Select-String -Pattern '/commit-page|/commit-infra|/commit-all'
```

Expected: first search has no active interaction requirements; second search finds ownership, chat, generation, storage, and versions coverage.

### Task 3: Revise the Claude Design corrective prompt

**Files:**
- Modify: `design-prompts/claude-design-prompt-5.md`

**Interfaces:**
- Consumes: Tasks 1–2 command-row and turn-time rules.
- Produces: a self-contained design instruction that removes the split-button and changes no confirmation-dialog visuals.

- [x] **Step 1:** Replace section 25's persistent split-button frame with `/commit-*` slash-menu command frames and exact dot/count states.
- [x] **Step 2:** Keep `ws-commit-confirm-120` unchanged in purpose and remove button/dropdown-specific copy everywhere else.
- [x] **Step 3:** Update the running-turn frame so local command mode works while message sending is disabled.
- [x] **Step 4:** Add a regression prohibition against persistent commit buttons and verify all exact command names.

Verification:

```powershell
Select-String -Path design-prompts/claude-design-prompt-5.md -Pattern '/commit-page|/commit-infra|/commit-all|split-button|dropdown arrow'
```

Expected: the three commands and explicit prohibition are present; no instruction asks the designer to render a split-button or dropdown arrow.

### Task 4: Final consistency verification

**Files:**
- Verify: all files from Tasks 1–3.

**Interfaces:**
- Consumes: completed specification, architecture, and prompt edits.
- Produces: one consistent command-trigger contract.

- [x] **Step 1:** Run stale-interaction and required-command searches across specifications, architecture, and the prompt.
- [x] **Step 2:** Run `git diff --check` on tracked documentation and Markdown hygiene checks on the ignored prompt.
- [x] **Step 3:** Confirm tracked status contains only intended documentation plus the preserved user deletion; stage only explicit task paths if committing.
- [x] **Step 4:** Review the complete diff for confirmation-dialog, scope, concurrency, and optional-Git regressions.
