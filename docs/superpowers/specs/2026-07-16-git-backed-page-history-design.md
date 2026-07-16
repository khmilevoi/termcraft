# termcraft — Git-backed Page History Design

Date: 2026-07-16
Status: approved design

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
  config.toml
  chats/
  pages/
    <slug>/
      page.tsx
      comments.jsonl
```

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

The Git adapter is termcraft's eighth top-level component. It is the only
module that invokes the user's installed Git CLI; no other component shells
out to Git or implements repository operations itself.

The Kernel accesses Git through `GitHistory` and `GitCommitter` ports. One
adapter drives the user's installed Git CLI for both. UI code, the Project
store, and the design host never invoke Git directly.

Conceptually the port provides:

```ts
interface GitHistory {
  inspectProject(projectPath: string): Promise<GitProjectState>
  inspectPage(sourcePath: string): Promise<PageGitState>
  listPageCommits(sourcePath: string): AsyncIterable<PageCommit>
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

Cross-file crash consistency for a turn that changes multiple pages, the
manifest, chat, and pins is intentionally not solved by page history. It is a
separate Turn Transaction design item.

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

Before presenting the final confirmation, the Kernel records the current source
hash and checks the selected page's index state. At confirmation, the Kernel
captures the current chat as `targetChatId`, stores it in the Restore action
plan, and creates a unique `restoreActionId` bound to that `targetChatId`, the
selected page, the full source commit id, and the confirmed pre-Restore source
hash.

The operation follows these rules:

1. If the page source has staged changes, Restore is blocked. termcraft neither
   replaces nor unstages the user's index entry.
2. If the current source has unstaged changes, the confirmation states that
   those page-design changes will be lost.
3. If the source changed after the confirmation was prepared, that confirmation
   expires and a new one is required.
4. After confirmation, the Kernel acquires the project-write mutex and, before
   replacing canonical `page.tsx`, revalidates the confirmed pre-Restore source
   hash and index state, verifies that the same full commit object can still be
   read, and runs that exact full-commit snapshot through the current Gate. This
   original source-hash freshness check applies only on the initial Restore path
   before source replacement. Any failed validation releases the mutex without
   a project write. A source incompatible with the current kit remains
   browsable as an error state but cannot be restored through termcraft.
5. The Project store replaces the selected canonical `page.tsx` once for this
   `restoreActionId`, via temporary file plus rename.
6. The Kernel then reads and writes the captured target chat file identified by
   the action plan's `targetChatId` and appends one system record containing at
   least `restoreActionId`, page, and full source commit id, for example
   `restored main from a1b2c3d`. Other chats remain untouched. The containing
   chat file is the record's persisted chat identity, so the record does not add
   a redundant `targetChatId` field. This records the explicit user action; it
   does not associate a future commit with a prompt.
7. The page replacement and captured-target-chat append are serialized in that
   order under the project-write mutex, but they are not one crash-atomic
   transaction.
   The Kernel then releases the mutex and performs the mandatory source, host,
   chat, and Git-status refresh.
8. `HEAD`, branch, index, other pages, pins, other chats, and application source
   files remain untouched.
9. The restored source becomes `Current design · uncommitted` unless it happens
   to equal `HEAD`.

If replacing `page.tsx` succeeds but appending the captured-target-chat record
fails, the action enters explicit `record-pending` state, retains `targetChatId`
in memory, and leaves the restored page as the active current source. termcraft
surfaces a persistence error and does not report that Restore was fully recorded.
**Retry record** is append-only: under the same project-write mutex it reads and
checks exactly the captured target chat file for `restoreActionId` and treats
the record as complete if it is already present; otherwise it appends exactly
one record to that file. It never repeats Gate or source replacement and does
not re-run the pre-Restore source-hash freshness check, making an ambiguous
append acknowledgement idempotent. Chat creation and switching need not be
globally blocked by `record-pending`: changing the UI active chat changes
neither the action's target nor its exactly-one semantics.

Subsequent page drift does not invalidate this factual audit record for the
already-applied Restore: the record identifies the original `restoreActionId`,
page, and full source commit. A new Restore always requires a new confirmation
and `restoreActionId`. In v1, `record-pending` is only an in-memory recovery
affordance. After a process crash or restart the restored source remains on disk,
but the pending action plan is gone, so no Retry is available unless a future
design persists pending actions. termcraft attempts no automatic audit-record
recovery; the UI refreshes from disk and Git status, and the missing record may
require manual or operator diagnosis.

termcraft creates no hidden backup. The warning and explicit confirmation are
the recovery boundary for unstaged current changes.

## 8. User-initiated commits in v1

History adds a split-button:

```text
[ ● Commit current page ][ ▾ ● ]
```

The primary action commits only
`.termcraft/pages/<active-slug>/page.tsx`. It commits the exact current design
from disk. Absent hook side effects, after success that source is clean relative
to the new `HEAD`, and the adapter's own operations preserve all unrelated
staged and unstaged state. User hooks may instead modify the active source or
other files according to their own policy; termcraft neither suppresses nor
rewrites those effects. The mandatory post-attempt status refresh exposes any
hook-induced dirty state and every other changed file.

The dropdown contains two additional scopes:

- **Commit infrastructure** — `project.toml`, `config.toml`, the generated
  `.gitignore`, and future portable project-level schema or metadata files;
- **Commit entire project** — every non-ignored changed, added, or deleted path
  under `.termcraft/`, including pages, chats, pins, and export artifacts.

Lock files, backups, `*.local.*`, and every path outside `.termcraft/` are
excluded. A new page may be committed separately from its infrastructure
change; the remaining dropdown status makes that incomplete project commit
visible until the user commits the infrastructure or the whole project.

Every action opens a confirmation dialog containing an editable commit-message
template and the exact added, modified, and deleted paths. The page template is
`design(<slug>): update <title>`; infrastructure and whole-project scopes use
scope-specific termcraft templates. No template contains chat or prompt text.

Status indicators are derived from Git state:

- a dot on the primary button means the active page source differs from
  `HEAD`;
- a dot beside the dropdown arrow means another path under `.termcraft/`
  differs from `HEAD`;
- each dropdown action has its own dot and changed-file count;
- an action with no changes has no dot and is disabled.

Color is not the only status signal: tooltips and accessible labels name the
dirty scope. Status is refreshed after every user-initiated Git operation or
commit attempt and after Kernel apply. Inspection commands used by refresh do
not recursively trigger another refresh.

Commit controls remain available while an agent turn runs. During that turn,
Git commit execution contends through the project-write mutex only with the
short final Kernel apply, not network streaming, validation, or Gate. A commit
made before apply records the currently applied design; the later turn result
becomes a new uncommitted change. Outside agent turns, Restore's ordered source
and captured-target-chat record writes use the same mutex.

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
- A Restore system-record schema/decoder fixture requires `restoreActionId`,
  `page`, and full `sourceCommit`.
- The fixture rejects a Restore record missing `restoreActionId`.
- Successful Restore changes only the selected `page.tsx` and appends one
  restore system record containing `restoreActionId`, page, and full source
  commit id to the target chat captured at confirmation; other chats remain
  untouched, and the containing chat file persists the record's chat identity.
- If the Restore chat append fails after page replacement, the restored page
  remains active in `record-pending`, the action retains its captured
  `targetChatId` in memory, the persistence error does not claim a fully
  recorded Restore, and append-only **Retry record** neither repeats Gate or
  source replacement nor revalidates the pre-Restore source hash.
- **Retry record** checks only the captured target chat for `restoreActionId`, so
  an ambiguous prior append acknowledgement still produces exactly one audit
  record even if the UI active chat changes.
- A Kernel contract scenario starts with an ambiguous append acknowledgement in
  chat A, switches the UI active chat to B, and retries with the same
  `restoreActionId` and captured `targetChatId=A`. **Retry record** checks and,
  if needed, appends only chat A, leaving exactly one Restore record in A and
  none in B, without repeating Gate or source replacement.
- `HEAD`, branch, and index are byte-for-byte or object-for-object unchanged by
  browsing and Restore.
- In the absence of explicit hook side effects, successful and failed scoped
  commits preserve staged and unstaged state outside their scope; hook changes
  are surfaced by the post-command status refresh.
- A changed `HEAD` or scope after preview forces replanning and reconfirmation.
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
- independent page and dropdown status dots;
- per-scope file counts, disabled clean scopes, and accessible status labels;
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
- the split-button can explicitly commit the current page, infrastructure, or
  the entire `.termcraft/` project while preserving unrelated repository state;
- during an agent turn, commit execution contends only with final apply, not
  network streaming, validation, or Gate; outside agent turns, Restore's ordered
  source and record writes use the same project-write mutex;
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
- cross-file turn transaction and crash recovery.
