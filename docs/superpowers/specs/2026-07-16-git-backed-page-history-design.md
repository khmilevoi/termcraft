# termcraft — Git-backed Page History Design

Date: 2026-07-16
Status: approved design

Production hardening: [`2026-07-16-production-hardening-decisions-design.md`](2026-07-16-production-hardening-decisions-design.md)
and its linked detailed designs provide the normative recovery, storage split, and
cross-file mutation mechanics now integrated below; this document remains the owner
of Git-history and explicit-commit product semantics.

## 1. Purpose

Remove termcraft's private page-version system. The MVP stores one canonical
design source per page and has no version-browsing or Git UI. In v1, page
history returns as a read-mostly view over commits, accompanied by explicit,
user-confirmed controls for creating scoped termcraft commits.

Git remains optional. A project outside a Git repository retains every design,
generation, preview, pin, chat, and export capability; page history and commit
controls are unavailable.

## 2. Decisions

- termcraft never creates Git history autonomously. In v1 an explicit,
  user-confirmed commit control may create a commit on the current `HEAD`.
- termcraft never creates or switches branches, tags, custom refs, stashes, or
  worktrees, and never pushes, pulls, or fetches.
- In the MVP there are no `vN` files, version hotkeys, history popup, rollback,
  or version numbers in chat records.
- Each page has one canonical source:
  `.termcraft/pages/<slug>/page.tsx`.
- A page slug is its stable identity and cannot be renamed. The user-facing
  `meta.title` remains editable.
- v1 history follows the current `HEAD` through its first-parent chain and
  includes commits that changed the page's design source.
- History never follows other refs and never attempts directory-rename
  detection.
- Git commit metadata is not correlated with chat turns or prompts. A single
  user commit may contain several turns and several pages.
- Pins and other page-local records do not define page versions and are never
  restored with a historical design.
- Historical browsing is read-only. Sending a message, creating pins,
  reopening pins, and changing pin status are disabled until the user returns
  to **Current design** or explicitly restores a commit.
- Restore replaces only the selected page's design source in the working
  directory. It does not create a commit or change `HEAD`, the current branch,
  or the Git index.
- v1 exposes three explicit commit scopes: the active page source, portable
  termcraft infrastructure, and the whole non-ignored `.termcraft/` project.
  No scope can include files outside `.termcraft/`.

## 3. Storage and terminology

The relevant project layout becomes:

```text
.termcraft/
  project.toml
  workspace.local.toml
  transactions.local/
  cache/
  diagnostics/
  logs/operational.jsonl
  lock
  chats/
  pages/
    <slug>/
      page.tsx
      comments.jsonl
```

`project.toml` is portable and contains exactly format version, project identity,
name, creation time, target stack, and ordered page slugs. Active page/chat, preview state, and
backend/model/effort and scoped session checkpoints live in
`workspace.local.toml`. Transactions, caches, diagnostics, logs, leases, and
backups are machine-local
and hard-excluded from all commit scopes.

`page.tsx` is the only path used to select commits for page history.
`comments.jsonl` may still be committed to Git, but a commit changing only
comments is not a page version.

The live source on disk is named **Current design** in the UI. Row precedence is
explicit:

- an unborn repository shows **Current design · uncommitted** and no commit
  rows;
- an untracked path with no first-parent ancestry shows only **Current design ·
  uncommitted**;
- an untracked or recreated path with first-parent ancestry shows **Current
  design · uncommitted** followed by the reachable historical entries;
- when tracked content equals the page source at `HEAD`, that `HEAD` row is
  **Current design**, not a duplicate historical entry.

Tracked content that differs from `HEAD` likewise gets a separate **Current
design · uncommitted** row above reachable commits. The term "working tree" is
deliberately absent from the product UI so it is not confused with a Git
worktree.

A committed history entry is identified by its full object id internally and
displays its short hash, author, committer timestamp, and subject. Full ids,
not short hashes or list positions, are used by commands.

## 4. Component boundary

The Git adapter is an internal Project-store adapter behind Kernel ports, not an
eighth top-level component or workspace package. It is the only implementation
that invokes the user's installed Git CLI; no other component shells out to Git or
implements repository operations itself.

The Kernel accesses Git through `GitHistory` and `GitCommitter` ports. One
adapter drives the user's installed Git CLI for both. UI code, the Project
store's non-Git storage core, and the design host never invoke Git directly.

Conceptually the port provides:

```ts
interface GitHistory {
  inspectProject(projectPath: string): Promise<GitProjectState>
  inspectPage(sourcePath: string): Promise<PageGitState>
  listPageCommits(request: PageHistoryRequest): Promise<PageHistoryPage>
  readPageSource(commitId: string, sourcePath: string): Promise<Uint8Array>
  inspectIndex(sourcePath: string): Promise<PageIndexState>
}

type CommitScope =
  | { kind: "current-page", slug: string }
  | { kind: "infrastructure" }
  | { kind: "entire-project" }

interface GitCommitter {
  planCommit(scope: CommitScope): Promise<CommitPlan>
  commit(plan: CommitPlan, message: string): Promise<CommitResult>
}
```

`PageHistoryRequest` and `PageHistoryPage` are the bounded cursor/generation types
defined by the projections and scale design §8; the default page is 50 entries and
the hard maximum is 200. No Git port exposes an unbounded commit iterable.

The adapter executes argument arrays without shell interpolation, applies a
bounded timeout, captures bounded stdout and stderr, and converts failures to
typed errors. Commit subjects and author names are untrusted display strings:
the adapter bounds their length and the UI renders them as text, never terminal
markup.

`CommitPlan` contains the expected `HEAD`, the selected paths and their current
states and content hashes. `commit` revalidates the plan before invoking Git;
it refuses a stale plan rather than silently committing a different file set.
The adapter itself preserves staged and unstaged state outside the selected
scope. User hooks remain free to modify files by their own policy; any such side
effects are surfaced by the mandatory post-command status refresh. Within the
selected scope the adapter commits the latest content from disk, even when an
older copy of that path was already staged.

Commit execution honors the user's hooks and signing configuration. termcraft
passes the confirmed message without opening an editor and does not use
`--no-verify` or `--no-gpg-sign`.

The intended history semantics are equivalent to a path-limited, first-parent
walk from `HEAD`. Historical file contents are read from the selected commit's
tree. No operation checks out a commit into the project.

## 5. MVP generation and chat changes

At the start of a turn, staging receives the current `page.tsx` for every
listed page. After the agent exits, the Gate validates the proposed sources.
A successful apply replaces each changed canonical source rather than creating
a numbered file.

The agent chat record replaces the version-valued `applied` map with a
page-identity list:

```json
{"kind":"agent","text":"…","changedPages":["main"],"warnings":[]}
```

An empty diff produces an empty `changedPages` list. This record says what the
turn changed; it is not a version index and is never reconciled with later Git
commits.

Cross-file crash consistency is owned by the production-hardening transaction
design rather than page history. Successful apply prepares old/new hashes and
payloads for canonical pages, portable manifest changes, local active-page effect,
agent record, and pin events; after durable commit intent it rolls all operations
forward idempotently. Final apply compare-and-swaps send-time preconditions under
the project-write mutex so `/commit-*` hook side effects cannot be overwritten.

A broken canonical `page.tsx` is never replaced automatically at launch. The
Workspace still opens, with the preview region showing the Gate or host error,
and the composer remains available so the user can send a repair turn against
the broken source. In v1, when usable Git history exists for that page, the UI
also offers the explicit Git Restore flow in §7.

Export always reads each page's canonical current source from disk, including
uncommitted changes. It never substitutes the copy at Git `HEAD` merely because
that copy is committed, and browsing a historical snapshot does not change the
source selected for export.

## 6. Browsing flow in v1

1. The user opens history for the active page.
2. The Kernel asks `GitHistory` for the page's state and first-parent commits.
3. The Kernel applies the row precedence from §3: unborn means only `Current
   design · uncommitted`; an untracked path without first-parent ancestry means
   only that row; an untracked or recreated path with ancestry adds its
   reachable historical entries; and tracked content equal to `HEAD` makes the
   `HEAD` row `Current design`. Other tracked changes put `Current design ·
   uncommitted` above reachable commits.
4. Selecting a commit reads `page.tsx` from that commit into a temporary,
   read-only snapshot outside `.termcraft/`.
5. The Kernel respawns the preview host on the snapshot. The project file,
   branch, `HEAD`, and index remain unchanged.
6. The UI displays `<short-hash> · read-only`. Sending agent messages,
   changing Tweaks, creating pins, reopening pins, and changing pin status are
   disabled until the user returns to **Current design**.
7. Leaving history kills the historical host and respawns it on the exact
   current source from disk.

The current selection survives when its element id exists in the historical
render. Existing current pins are overlaid only when their element ids resolve;
their records and statuses never change during browsing. No pin mutation is
enabled until the user returns to **Current design**.

A commit that changes multiple page sources independently appears in each
affected page's history. A merge commit represents one mainline version; its
individual feature-branch commits are not separate entries in this view.

## 7. Restore flow in v1

Restore is an explicit action and is unavailable during an agent turn.

Planning records the canonical source hash, index state, selected full object and
blob hash, and mints only `restorePlanId`. A staged source blocks Restore. Unstaged
changes require a warning naming the exact canonical path and the bytes that
confirmation allows termcraft to replace. When the Kernel accepts
`restore.confirm`, it captures the then-active UUIDv7 chat as `targetChatId` and
mints one UUIDv7 `restoreActionId` bound to that chat, page slug, full source commit
id, and source hash.

The immutable selected blob passes the current `@termcraft/runtime` Gate and matching
host before the write mutex is acquired. Under the project-write mutex, the initial
path revalidates source hash, index, full object/blob hash, and the hash-bound Gate
attestation. Any stale, missing, incompatible, or invalid input releases the mutex
without commit intent or project write.

`RestoreTransaction` then prepares two idempotent operations: replace exactly the
selected canonical `page.tsx`, and append exactly one system record to the captured
target chat. The record has its own `recordId` plus `restoreActionId`, `pageSlug`, and full
source commit; the containing chat file remains its chat identity. The durable plan
and payloads are stored under hard-excluded `transactions.local/`.

After durable commit intent, the operation is roll-forward-only. Replay checks only
the captured target chat for `restoreActionId`; it never repeats Gate/source
replacement or the pre-Restore hash check. Ambiguous append acknowledgement,
active-chat changes, later page drift, and process restart therefore still produce
exactly one audit record in the original chat. Startup completes pending intent
before Workspace. An unexpected target hash enters recovery conflict and is never
overwritten; a new Restore requires a new confirmation and action id.

`HEAD`, branch, index, other pages, pins, other chats, and application files remain
untouched. The result is `Current design · uncommitted` unless equal to `HEAD`.
termcraft creates no hidden overwrite backup: the exact warning and confirmation
remain the recovery boundary for intentionally discarded unstaged current bytes.

termcraft creates no hidden backup. The warning and explicit confirmation are
the recovery boundary for unstaged current changes.

## 8. User-initiated commits in v1

The Workspace composer slash menu adds three argument-less commands:

- `/commit-page` — commit only
  `.termcraft/pages/<active-slug>/page.tsx`;
- `/commit-infra` — commit portable `project.toml`, the generated `.gitignore`,
  and future explicitly portable project-level schema or metadata files;
- `/commit-all` — commit every non-ignored changed, added, or deleted path under
  `.termcraft/`, including pages, chats, pins, and export artifacts.

There is no persistent commit button, split-button, dropdown arrow, or mouse
twin. Each command dispatches its scope through the same action-table and Kernel
commit-planning path. `/commit-page` commits the exact current design from disk.
Absent hook side effects, after success that source is clean relative to the new
`HEAD`, and the adapter's own operations preserve all unrelated staged and
unstaged state. User hooks may instead modify the active source or other files
according to their own policy; termcraft neither suppresses nor rewrites those
effects. The mandatory post-attempt status refresh exposes any hook-induced
dirty state and every other changed file.

Workspace/session files, transaction journals, caches, diagnostics, operations
logs, lock metadata, backups, ignored paths, and every path outside `.termcraft/`
are hard-excluded. A new page may be committed separately from its infrastructure
change; the remaining command-row status makes that incomplete project commit
visible until the user runs `/commit-infra` or `/commit-all`.

Every command opens the same confirmation dialog containing an editable
commit-message template and the exact added, modified, and deleted paths. The
page template is `design(<slug>): update <title>`; infrastructure and
whole-project scopes use scope-specific termcraft templates. No template
contains chat or prompt text.

Status indicators are derived from Git state and rendered on the slash-menu
command rows:

- `/commit-page` has a dot and changed-file count when the active page source
  differs from `HEAD`;
- `/commit-infra` has its own dot and count for eligible infrastructure paths;
- `/commit-all` has its own dot and count for every eligible changed path under
  `.termcraft/`;
- a command whose scope has no changes has no dot and is disabled.

Color is not the only status signal: tooltips and accessible labels name the
dirty scope. Status is refreshed after every user-initiated Git operation or
commit attempt and after Kernel apply. Inspection commands used by refresh do
not recursively trigger another refresh.

The three commit commands remain available while an agent turn runs. Ordinary
message sending stays disabled, but typing `/` on the otherwise empty composer
enters local command mode and opens the slash menu. The `/commit-*` rows remain
enabled according to their Git scope state; turn-locked commands remain visible
but dimmed with their refusal reason. During that turn, Git commit execution
contends through the project-write mutex only with the short final Kernel apply,
not network streaming, validation, or Gate. A commit made before apply records
the currently applied design; the later turn result becomes a new uncommitted
change. Outside agent turns, Restore's ordered source and captured-target-chat
record writes use the same mutex.

Before confirmation the Kernel records the expected `HEAD` and scope hashes.
Immediately before committing it revalidates both. A changed plan is shown
again and requires a new confirmation. A detached `HEAD` is allowed only after
an additional warning. An active merge, rebase, cherry-pick, or revert blocks
termcraft's commit controls so they cannot interfere with Git sequencer state.

## 9. Availability and errors

| Condition | Behavior |
|---|---|
| Git executable unavailable | The application works; history and commit controls explain that Git is unavailable. |
| Project is not a Git repository | The application works; history and commit controls are unavailable. |
| Repository has no commits | `Current design · uncommitted` is shown with no commit rows; a selected commit scope may create the root commit. |
| Untracked page source has no first-parent ancestry | Only `Current design · uncommitted` is shown. |
| Untracked or recreated page source has first-parent ancestry | `Current design · uncommitted` is followed by reachable historical entries. |
| Tracked page source equals `HEAD` | The `HEAD` row is `Current design`. |
| Shallow repository | Reachable local entries are shown with `partial history`; termcraft never fetches automatically. |
| Detached HEAD | History and Restore work; commit requires an additional warning and confirmation. |
| Source is staged | Browsing works; Restore is blocked; page commit records the latest source from disk. |
| Git object is missing or corrupt | The error names the commit and path; no project file changes. |
| Historical source fails Gate | Preview shows the Gate/host error; Restore is disabled. |
| Git command times out or exceeds output limits | The operation fails with a bounded error; the current project state remains active. |
| Git identity is missing | Commit fails with Git's error plus a concise `user.name`/`user.email` setup hint. |
| Commit message is empty | The dialog's Commit action is disabled. |
| Merge/rebase/cherry-pick/revert is active | Commit controls are disabled until the sequencer operation ends. |
| Index lock remains busy | The command waits briefly, then fails with a Retry action. |
| Hook or signing fails | Git output is shown and status is refreshed because the hook may have changed files. |

History starts at the commit that introduced the immutable page path. Reusing a
deleted slug means resurrecting the same page identity and its Git history;
creating an unrelated page under an old slug is unsupported.

## 10. Testing

### Git adapter integration tests

Tests create temporary real repositories and cover:

- a linear page history;
- a feature branch merged into main, proving first-parent behavior;
- one commit changing several pages;
- a pin-only commit excluded from page history;
- an unborn repository showing `Current design · uncommitted` with no commit
  rows;
- an untracked page path with no first-parent ancestry showing only `Current
  design · uncommitted`;
- an untracked or recreated page path with first-parent ancestry showing that
  row plus reachable historical entries;
- tracked page content equal to `HEAD` making the `HEAD` row `Current design`;
- other unstaged and staged page-source states;
- detached HEAD and shallow clone;
- a historical source missing from an earlier commit;
- bounded handling of long subjects, author names, stderr, and timeouts;
- current-page commit with unrelated staged and unstaged changes;
- current-page source edited again after `git add`;
- root commit containing a new untracked page;
- infrastructure-only and entire-project scopes;
- ignored local files and application files outside `.termcraft/` excluded;
- successful and failing hooks, missing identity, and signing failure;
- detached HEAD and active Git sequencer states.

### Kernel contract tests

- Browsing performs no project writes and changes no Git state.
- A historical preview uses a temporary read-only snapshot.
- Send is blocked outside `Current design`.
- Leaving history returns to the exact current source.
- Restore is blocked for a staged source.
- A source change after confirmation forces reconfirmation.
- Gate failure leaves the current source untouched.
- A Restore system-record schema/decoder fixture requires `recordId`,
  `restoreActionId`, `pageSlug`, and full `sourceCommit`.
- The fixture rejects a Restore record missing `restoreActionId`.
- Successful Restore changes only the selected `page.tsx` and appends one
  restore system record containing `recordId`, `restoreActionId`, `pageSlug`, and full source
  commit id to the target chat captured at confirmation; other chats remain
  untouched, and the containing chat file persists the record's chat identity.
- Fault injection after source replacement and during/after chat append proves
  durable startup replay retains captured `targetChatId`, never repeats Gate or
  source replacement, and produces exactly one record for `restoreActionId`.
- An ambiguous append in chat A followed by active-chat switch to B and process
  restart recovers only chat A, leaving exactly one Restore record in A and none
  in B.
- An unexpected source or target-chat hash during recovery enters conflict and
  overwrites neither file.
- `HEAD`, branch, and index are byte-for-byte or object-for-object unchanged by
  browsing and Restore.
- In the absence of explicit hook side effects, successful and failed scoped
  commits preserve staged and unstaged state outside their scope; hook changes
  are surfaced by the post-command status refresh.
- A changed `HEAD` or scope after preview forces replanning and reconfirmation.
- A `/commit-*` hook that changes a turn precondition causes final apply's
  compare-and-swap to fail without overwriting the hook result.
- Commit, Kernel apply, and Restore's ordered page-and-chat writes serialize
  through the project-write mutex while the agent turn itself remains
  unblocked.

### UI tests

- `Current design`, `uncommitted`, `<short-hash> · read-only`, and
  `partial history` states;
- unavailable, empty, and Git-error presentations;
- staged-source refusal;
- overwrite confirmation naming the exact source path;
- disabled send, Tweaks, pin creation, pin reopening, and pin-status changes
  while browsing a commit;
- independent `/commit-page`, `/commit-infra`, and `/commit-all` status dots;
- per-command file counts, disabled clean scopes, and accessible status labels;
- turn-time local command mode with `/commit-*` enabled by scope while message
  sending and other locked command rows remain disabled;
- commit dialog file list, message validation, detached-HEAD warning, and Git
  error presentation.

## 11. Acceptance criteria

MVP:

- no numbered page sources, version model, history UI, rollback action, version
  hotkeys, or version-valued chat records remain;
- generation reads and replaces the single canonical source per page;
- termcraft works with and without Git.

v1:

- the user can browse the active page's path-limited, first-parent history from
  the current `HEAD`;
- history row precedence covers unborn repositories, untracked paths without
  ancestry, untracked or recreated paths with reachable ancestry, and tracked
  content equal to `HEAD` exactly as defined in §3;
- browsing never changes repository state;
- Restore safely replaces only the page's canonical design source after Gate,
  index, freshness, and confirmation checks;
- Restore source replacement and captured-target-chat audit append recover
  idempotently across process restart without changing Git state;
- `/commit-page`, `/commit-infra`, and `/commit-all` explicitly commit their
  respective scopes while preserving unrelated repository state and opening the
  same confirmation dialog;
- during an agent turn, commit execution contends only with final apply, not
  network streaming, validation, or Gate; outside agent turns, Restore's ordered
  source and record writes use the same project-write mutex;
- hook-induced `.termcraft/` drift is detected by final apply before commit intent
  and is never overwritten;
- termcraft changes Git history only after an explicit, scope-specific user
  confirmation.

## 12. Out of scope

- automatic, background, or per-turn commits;
- committing paths outside `.termcraft/`;
- push, pull, fetch, remote management, or repository initialization;
- following directory renames;
- history across all refs or unmerged branches;
- automatic fetch of missing or shallow history;
- commit-to-chat or commit-to-prompt correlation;
- arbitrary commit checkout, branch switching, stashing, or index management
  outside the selected commit scope;
- version comparison and visual diffs;
