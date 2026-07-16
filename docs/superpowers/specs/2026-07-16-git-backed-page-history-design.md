# termcraft — Git-backed Page History Design

Date: 2026-07-16
Status: approved design

## 1. Purpose

Remove termcraft's private page-version system. The MVP stores one canonical
design source per page and has no version-browsing UI. Version browsing returns
in v1 as a read-mostly view over commits already created by the user in the
target project's Git repository.

Git remains optional. A project outside a Git repository retains every design,
generation, preview, pin, chat, and export capability; only page history is
unavailable.

## 2. Decisions

- termcraft never creates commits, branches, tags, refs, stashes, or worktrees.
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
- Historical browsing is read-only. Sending a message is disabled until the
  user returns to the current design or explicitly restores a commit.
- Restore replaces only the selected page's design source in the working
  directory. It does not create a commit or change `HEAD`, the current branch,
  or the Git index.

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

The live source on disk is named **Current design** in the UI. When its content
differs from `HEAD`, it carries the **uncommitted** badge. The term "working
tree" is deliberately absent from the product UI so it is not confused with a
Git worktree.

A committed history entry is identified by its full object id internally and
displays its short hash, author, timestamp, and subject. Full ids, not short
hashes or list positions, are used by commands.

## 4. Component boundary

The Kernel accesses Git only through a `GitHistory` port. The first adapter
drives the user's installed Git CLI. UI code, the Project store, and the design
host never invoke Git directly.

Conceptually the port provides:

```ts
interface GitHistory {
  inspectProject(projectPath: string): Promise<GitProjectState>
  inspectPage(sourcePath: string): Promise<PageGitState>
  listPageCommits(sourcePath: string): AsyncIterable<PageCommit>
  readPageSource(commitId: string, sourcePath: string): Promise<Uint8Array>
  inspectIndex(sourcePath: string): Promise<PageIndexState>
}
```

The adapter executes argument arrays without shell interpolation, applies a
bounded timeout, captures bounded stdout and stderr, and converts failures to
typed errors. Commit subjects and author names are untrusted display strings:
the adapter bounds their length and the UI renders them as text, never terminal
markup.

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

## 6. Browsing flow in v1

1. The user opens history for the active page.
2. The Kernel asks `GitHistory` for the page's state and first-parent commits.
3. The UI places `Current design` first. If it differs from `HEAD`, the row is
   marked `uncommitted`.
4. Selecting a commit reads `page.tsx` from that commit into a temporary,
   read-only snapshot outside `.termcraft/`.
5. The Kernel respawns the preview host on the snapshot. The project file,
   branch, `HEAD`, and index remain unchanged.
6. The UI displays `<short-hash> · read-only`. Sending agent messages and
   changing Tweaks are disabled.
7. Leaving history kills the historical host and respawns it on the exact
   current source from disk.

The current selection survives when its element id exists in the historical
render. Current pins are overlaid only when their element ids resolve; their
records and statuses never change during browsing.

A commit that changes multiple page sources independently appears in each
affected page's history. A merge commit represents one mainline version; its
individual feature-branch commits are not separate entries in this view.

## 7. Restore flow in v1

Restore is an explicit action and is unavailable during an agent turn.

Before presenting the final confirmation, the Kernel records the current source
hash and checks the selected page's index state. Immediately before writing it
repeats both checks and verifies that the selected commit object can still be
read.

The operation follows these rules:

1. If the page source has staged changes, Restore is blocked. termcraft neither
   replaces nor unstages the user's index entry.
2. If the current source has unstaged changes, the confirmation states that
   those page-design changes will be lost.
3. If the source changed after the confirmation was prepared, that confirmation
   expires and a new one is required.
4. The historical source passes the current Gate before any project file is
   written. A source incompatible with the current kit remains browsable as an
   error state but cannot be restored through termcraft.
5. After confirmation, the Project store writes `page.tsx` via temporary file
   plus rename.
6. Only that design source changes. `HEAD`, branch, index, other pages, pins,
   chats, and application source files remain untouched.
7. The restored source becomes `Current design · uncommitted` unless it happens
   to equal `HEAD`.
8. The active chat receives a system record naming the page and source commit,
   for example `restored main from a1b2c3d`. This records the explicit user
   action; it does not associate a future commit with a prompt.

termcraft creates no hidden backup. The warning and explicit confirmation are
the recovery boundary for unstaged current changes.

## 8. Availability and errors

| Condition | Behavior |
|---|---|
| Git executable unavailable | The application works; history explains that Git is unavailable. |
| Project is not a Git repository | The application works; history is unavailable. |
| Repository has no commits | Only `Current design` is shown. |
| Page source is untracked | Only `Current design · uncommitted` is shown. |
| Shallow repository | Reachable local entries are shown with `partial history`; termcraft never fetches automatically. |
| Detached HEAD | History walks from that HEAD; browsing and Restore remain available. |
| Source is staged | Browsing works; Restore is blocked. |
| Git object is missing or corrupt | The error names the commit and path; no project file changes. |
| Historical source fails Gate | Preview shows the Gate/host error; Restore is disabled. |
| Git command times out or exceeds output limits | The operation fails with a bounded error; the current project state remains active. |

History starts at the commit that introduced the immutable page path. Reusing a
deleted slug means resurrecting the same page identity and its Git history;
creating an unrelated page under an old slug is unsupported.

## 9. Testing

### Git adapter integration tests

Tests create temporary real repositories and cover:

- a linear page history;
- a feature branch merged into main, proving first-parent behavior;
- one commit changing several pages;
- a pin-only commit excluded from page history;
- untracked, unstaged, and staged page sources;
- an unborn repository, detached HEAD, and shallow clone;
- a historical source missing from an earlier commit;
- bounded handling of long subjects, author names, stderr, and timeouts.

### Kernel contract tests

- Browsing performs no project writes and changes no Git state.
- A historical preview uses a temporary read-only snapshot.
- Send is blocked outside `Current design`.
- Leaving history returns to the exact current source.
- Restore is blocked for a staged source.
- A source change after confirmation forces reconfirmation.
- Gate failure leaves the current source untouched.
- Successful Restore changes only the selected `page.tsx` and appends the
  restore system record.
- `HEAD`, branch, and index are byte-for-byte or object-for-object unchanged by
  browsing and Restore.

### UI tests

- `Current design`, `uncommitted`, `<short-hash> · read-only`, and
  `partial history` states;
- unavailable, empty, and Git-error presentations;
- staged-source refusal;
- overwrite confirmation naming the exact source path;
- disabled send and Tweaks while browsing a commit.

## 10. Acceptance criteria

MVP:

- no numbered page sources, version model, history UI, rollback action, version
  hotkeys, or version-valued chat records remain;
- generation reads and replaces the single canonical source per page;
- termcraft works with and without Git.

v1:

- the user can browse the active page's path-limited, first-parent history from
  the current `HEAD`;
- browsing never changes repository state;
- Restore safely replaces only the page's canonical design source after Gate,
  index, freshness, and confirmation checks;
- termcraft never creates or changes Git history.

## 11. Out of scope

- creating commits or checkpoints;
- following directory renames;
- history across all refs or unmerged branches;
- automatic fetch of missing or shallow history;
- commit-to-chat or commit-to-prompt correlation;
- arbitrary commit checkout, branch switching, stashing, or index mutation;
- version comparison and visual diffs;
- cross-file turn transaction and crash recovery.
