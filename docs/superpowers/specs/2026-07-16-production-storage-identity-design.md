# termcraft — Production Storage and Identity Design

Date: 2026-07-16
Status: approved design

## 1. Purpose and scope

This specification makes termcraft's local storage safe enough for the first
shipped schema. It defines durable identity, portable and machine-local state,
single-process ownership, crash-consistent writes, JSONL recovery, migration
backups, trust identity, and Git commit exclusions.

The supported operating model is a production-grade, local, single-user,
single-process application. A running termcraft process is the only supported
writer of its `.termcraft/` project. Daemon mode, multiple clients, network file
systems, and concurrent external edits are outside this design.

This specification is normative wherever it conflicts with the storage,
identity, lock, session, migration, Restore-recovery, or commit-exclusion
wording in the documents listed in §15. The Git-backed page-history design
continues to govern history discovery, read-only browsing, Restore validation,
and user-confirmed Git operations except where §15 explicitly supersedes it.

## 2. Design principles

1. **Portable intent is separate from local workspace state.** A clone receives
   the project, pages, pins, and target stack. It does not receive
   active tabs, preview preferences, backend choices, credentials' session scope,
   caches, transaction journals, diagnostics, or trust grants.
   <!-- amended 2026-07-26 (MVP blocker fix bundle §2.5): chats reclassified hard-local -->
2. **Page identity is its immutable slug.** There is no page UUID. The canonical
   source path remains the path Git follows, and recreating a removed slug
   resurrects that page identity and its reachable Git history.
3. **Every other durable application identity is explicit.** Project, chat, turn,
   command invocation, JSONL record, pin, durable action, and storage transaction
   identities use UUIDv7.
4. **No cached value is authoritative.** Project state does not duplicate page
   metadata. A cache hit is valid only for the exact page slug, source bytes, and
   extractor contract.
5. **A process ID is diagnostic, not ownership proof.** Project ownership is an
   operating-system-held exclusive lock that remains held for the process
   lifetime.
6. **Append-only data is never silently truncated.** Automatic repair requires a
   prepared transaction that proves the intended bytes. Otherwise a terminal
   corrupt suffix requires explicit recovery, and corruption followed by a valid
   record is a hard error.
7. **A migration never relies on Git as its backup.** Every on-disk migration
   rewrite starts only after a separate, byte-verified backup exists outside
   `.termcraft/`.
8. **Git history is user-authored history.** termcraft stores no commit-to-turn or
   commit-to-prompt relationship and does not infer one later.

## 3. Identity model

### 3.1 UUIDv7 rules

termcraft generates UUIDv7 values in canonical lowercase hyphenated form under
RFC 9562. The generator uses operating-system cryptographic randomness and a
process-local monotonic sequence for values generated in the same millisecond or
during wall-clock rollback. UUID timestamp order is useful for display and file
listing, but file order and explicit timestamps remain authoritative; correctness
must never depend on UUID sort order.

An identity is minted once and is immutable. Retrying the same logical action
reuses its action identity; beginning a new action mints a new one. UUIDs are not
secrets and must not contain backend credentials or user content.

| Identity | Lifetime and storage |
|---|---|
| `projectId` | Minted when `.termcraft/` is created; stored portably in `project.toml`. Copying the project copies this identity. |
| `chatId` | Minted when a chat is created; stored in its JSONL header and used in its filename. |
| `turnId` | Minted when a user send is accepted; shared by that turn's user record, terminal agent record, and turn-specific error or cancellation records. |
| `commandId` | Minted for every UI or CLI command accepted at the UI/Kernel boundary, including read-only commands. It is carried through diagnostics and any action or transaction started by the command; it need not appear in chat. |
| `recordId` | Minted for every JSONL event after a file header. Headers are not records and do not have `recordId`. |
| `pinId` | Minted by the pin-create action and retained by all later pin-status events. |
| `actionId` | Generic UUIDv7 for a durable, retryable user intent without a domain-specific name, including explicit repair, standalone pin mutation, and a Git commit attempt. Restore and migration use the domain-specific identities below instead of duplicating this field. |
| `restoreActionId` | Minted when `restore.confirm` is accepted; it is the Restore action's UUIDv7 and no duplicate generic `actionId` field is added to that record. |
| `migrationPlanId` | Minted when an immutable migration plan is published for confirmation; it identifies the exact backup and rewrite proposal and is never a transaction id. |
| `migrationActionId` | Minted when `migration.confirm` accepts `migrationPlanId`; retries and startup recovery of that accepted migration reuse it, and no generic `actionId` is stored in the migration domain. |
| `transactionId` | Minted for each prepared ProjectStore mutation. It identifies the local recovery journal, not a product-visible version. |

Backend SDK session IDs and Git object IDs are external identities and retain
their native opaque/full representations. They are not converted to UUIDs.

### 3.2 Page identity

A page is identified everywhere by `pageSlug`, validated by
`^[a-z0-9][a-z0-9-]{0,31}$` and excluding Windows device names. Its canonical
source is:

```text
.termcraft/pages/{pageSlug}/page.tsx
```

Braces in paths in this document denote a validated identity segment. There is
no `pageId`, hidden page UUID, generation number, or page-to-commit correlation
table. A slug cannot be renamed. Changing the display title rewrites the
`meta.title` literal in the canonical source; creating a different page requires
a new slug. Removing a page unlists its slug but does not reassign it. Reusing the
slug later is the same page identity.

The Git-backed history adapter continues to select commits solely by the
canonical source path and stores full Git object IDs for commands. Chat
`changedPages` values are slug lists and are never reconciled with Git commits.

## 4. Storage layout and path classes

```text
.termcraft/
  .gitignore
  project.toml
  pages/
    {pageSlug}/
      page.tsx
      comments.jsonl
  export/
    current.json
    generations/
      {generationId}/
        design-prompt.md
        runtime-api.json
        pages/
        snapshots/
        layout/

  workspace.local.toml
  lock
  chats/
    {chatId}.jsonl
  <!-- amended 2026-07-26 (MVP blocker fix bundle §2.5): chats reclassified hard-local -->
  transactions.local/
    format.json
    {transactionId}/
      plan.json
      payloads/
      intent.json
      applied/
      rebases/
      committed.json
      conflict.json
  cache/
    page-meta/
      {pageSlug}/
        {extractorVersion}/
          {sourceHash}.json
  diagnostics/
  logs/
    operational.jsonl
```

The first block is portable `ProjectState`. The second block is
`LocalWorkspaceState` and local operational state. The generated `.gitignore`
and the Git adapter's independent path policy exclude the entire second block.

Three stores live outside `.termcraft/`, all owned beneath the operating system's
per-user termcraft state root `{userStateRoot}`:

- the machine trust ledger owned by `TrustStore` under `{userStateRoot}`;
- verified migration and explicit-repair backups under
  `{userStateRoot}/backups/{projectId}/{backupActionId}/`, where a migration uses
  its `migrationActionId` and explicit repair uses its generic `actionId`;
- agent staging under
  `{userStateRoot}/sandboxes/{projectKey}/turns/{turnId}/`, with a stable project
  sandbox parent and a create-new child for every `turnId`.

`projectKey` is lowercase hexadecimal SHA-256 over the exact byte concatenation
`UTF-8(canonicalProjectRoot) || 0x00 || UTF-8(projectId)`. `projectId` is its
canonical lowercase UUIDv7 text. There is no stored sandbox salt and no OS-temporary
root fallback.

No project file may redirect a writable path outside `.termcraft/`. ProjectStore
accepts only normalized relative paths, rejects absolute paths and `..`, checks
every writable parent with no-follow semantics, and rejects symlinks, junctions,
or reparse points in a durable writable path. The separate TrustStore,
BackupStore, and StagingStore own their explicit external roots.

Round 2 Spike F (`docs/spikes/06-win-fs-identity/FINDINGS.md`) verified this on
Windows: `lstatSync(path).isSymbolicLink()` returns `true` for an NTFS junction
(both junctions and true symlinks are reparse points that libuv's Windows
`stat`/`lstat` maps to `S_IFLNK`) — better than expected, but this is an
implementation detail of libuv's tag mapping, not a documented guarantee for
every reparse-point kind (cloud-file placeholders, WSL interop links, dedup, and
app-execution-alias reparse tags were not covered by this spike and are not
known to be caught by `isSymbolicLink()`). The tag-agnostic backstop for the
general "reparse points" case is `GetFileAttributesW` via `bun:ffi`, testing the
result against `FILE_ATTRIBUTE_REPARSE_POINT`; this must be the mechanism for
the no-follow parent check, not `isSymbolicLink()` alone. Real NTFS symlink
creation could not be tested in the spike's non-elevated, non-Developer-Mode
shell — that case is expected, not confirmed, to behave identically to
junctions. The escape check itself was verified: a naive `join(root, rel)` does
**not** catch a junction planted inside the root that points outside it; the
check that works is `realpathSync` on the resolved path compared against
`realpathSync` of the root (not the raw root string), requiring the result to
equal or start with the root's resolved path plus a separator.

The supported project filesystem must be local and writable and must provide
reliable exclusive file locking, atomic same-filesystem replacement, and durable
file flushes. If the platform adapter identifies a remote filesystem or cannot
demonstrate those primitives, termcraft refuses project mutations with an
unsupported-filesystem error. It does not downgrade durability silently.

## 5. Portable ProjectState

### 5.1 `project.toml`

The first shipped `project.toml` has `format_version = 1` and exactly these
semantic fields:

| Field | Rule |
|---|---|
| `project_id` | Required canonical UUIDv7; immutable after creation. |
| `name` | Portable display name. |
| `created_at` | Required UTC RFC 3339 timestamp. |
| `target_stack` | Required enum: `rust-ratatui`, `go-bubbletea`, `js-opentui`, or `generic`. |
| `pages` | Ordered, duplicate-free array of page slugs. This is listing and tab order, not page identity allocation. |

`project.toml` does not contain active page, active chat, backend, model, effort,
preview settings, UI settings, agent session IDs, Git status, page title,
`minSize`, theme, source hash, or extracted page metadata. Consequently, changing
machines does not commit a workspace-navigation or backend-preference diff.

There is no `config.toml` in the first shipped layout. The portable target stack
belongs in `project.toml`; fields formerly proposed for `config.toml` are local
workspace fields in §6.

### 5.2 Portable logs and sources

`pages/{pageSlug}/comments.jsonl`, canonical page sources, and the active `export/`
pointer plus referenced generation are portable. Export remains derived and is
published as immutable generations, but it is eligible for `/commit-all` because
users may intentionally version exported acceptance artifacts. `chats/{chatId}.jsonl`
is hard-local, not portable: chat logs churn on every turn and can carry arbitrary
user text.
<!-- amended 2026-07-26 (MVP blocker fix bundle §2.5): chats reclassified hard-local -->

The chat filename must equal the `chatId` in its header. A chat header's
`projectId` must equal `project.toml`. A comments header's `projectId` and
`pageSlug` must equal its containing project and directory. Mismatch is
corruption; readers do not repair identity by renaming files or rewriting
headers.

## 6. LocalWorkspaceState and session continuity

### 6.1 `workspace.local.toml`

`workspace.local.toml` has its own `format_version = 1` and stores only
machine/workspace-local choices:

- optional `active_page_slug` and `active_chat_id`;
- backend, model, and effort selections as backend-owned validated strings;
- preview size mode (`auto`, `preset`, or `custom`), custom width and height when
  the mode is `custom`, theme override, color-capability simulation, and static
  or interactive mode;
- whether fullscreen preview was active;
- zero or more session checkpoints defined in §6.2;
- optional typed local resource-limit overrides owned by the projections/scale
  design: diagnostics and render-cache quotas, export worker count, preview FPS,
  operations-log segment/retention, silence timeout, and absolute turn deadline.
  Unknown keys or out-of-range values are invalid rather than silently accepted.

Composer drafts, focus, open popups, selection, transient errors, context-usage
telemetry, and Git status are not persisted. Pins remain portable events in each
page's comments log.

If `workspace.local.toml` is absent, termcraft derives safe defaults without
changing `project.toml`: the first listed page is active, the newest valid chat by
header `createdAt` is active, and compiled backend/preview defaults apply. A
dangling local page or chat reference uses the same fallback and is corrected on
the next local-state write. A corrupt local file is preserved, reported, and
ignored in favor of in-memory defaults until the user explicitly resets it; it is
never copied into portable state.

Local workspace writes use prepared transactions and atomic replacement. The
file is always hard-excluded from every Git commit scope.

### 6.2 Session resume scope and checkpoint

Each backend adapter supplies an opaque `sessionScopeId`. The adapter guarantees
that it changes whenever any of these changes:

1. backend implementation or account namespace;
2. model;
3. authenticated credential account;
4. backend workspace identity.

The credential component is a non-secret stable account discriminator; neither
credentials nor tokens enter the scope value. Effort is deliberately not part of
the approved session scope. A backend that cannot supply a stable account or
workspace discriminator returns a fresh scope for each process, which safely
disables cross-process resume for that backend.

A session checkpoint is keyed by `(chatId, sessionScopeId)` and stores:

- the backend's opaque session ID;
- `recordCount`, counting complete records after the chat header that the session
  is known to reflect;
- `prefixHash`, SHA-256 over the exact UTF-8 bytes of the header line and those
  `recordCount` record lines, including each terminating LF.

Before resume, the chat must have at least `recordCount` valid records and the
same hash for that exact prefix. Additional valid records are a permissible
suffix and are supplied to the resumed interaction as the prompt delta. A shorter
file, a changed prefix, a chat/header identity mismatch, a different scope, a
corrupt log, or an SDK resume rejection is a mismatch. On mismatch termcraft does
not call resume again with that checkpoint: it starts a fresh backend session and
seeds it with the newest complete chat records before the current user record,
preserving chronological order, up to 32 records and 64 KiB of UTF-8 text. Whole
records are included; oldest records are dropped first to meet the byte bound.
The current user message is sent normally and is not counted against the seed.

After the terminal agent outcome is durably appended, termcraft atomically
advances the checkpoint to the prefix known by the backend session. A crash before
the local checkpoint update leaves the older valid prefix, so the durable suffix
is sent as delta rather than lost. Session checkpoint failure never changes chat
history.

## 7. Rebuildable page metadata cache

Portable state contains no cached page metadata. The cache key is exactly:

```text
(pageSlug, sourceHash, extractorVersion)
```

`sourceHash` is lowercase SHA-256 of the exact canonical `page.tsx` bytes.
`extractorVersion` is an integer version of the extractor input/output contract,
independent of the termcraft release and project format versions. A cache entry
stores the key fields with extracted title, minimum size, theme, and other values
already defined by the page-module contract. A hit is accepted only when every key
field matches and the cache entry validates.

Missing, malformed, unsupported, or mismatched entries are cache misses. termcraft
re-extracts from the exact source and replaces the local entry atomically. It never
falls back to metadata for a different source hash. Extraction failure leaves the
canonical source untouched, uses the slug as the temporary tab label, and reports
the Gate/host error. Cache loss therefore affects startup cost, not correctness.

The cache is hard-excluded from Git, migration backups, and commit status counts.
Deleting it is always safe. An extractor-version change invalidates entries by
path and requires no project migration.

## 8. TrustSubject

Trust grants live outside the project and are keyed by the SHA-256 digest of a
canonical encoding of this complete `TrustSubject`:

1. the canonical project-root path after resolving path aliases;
2. the filesystem identity of that directory: device and inode on Unix, or volume
   serial and file ID on Windows;
3. portable `projectId` from `project.toml`;
4. optional `GitIdentity` when the project is in a Git repository.

The digest input is byte-exact `TrustSubjectV1`. It begins with ASCII
`termcraft-trust-subject-v1` plus one NUL byte. Every following field is Unicode NFC
UTF-8 preceded by its unsigned 32-bit big-endian byte length. Fields are encoded in
the order above as: canonical project path, canonical filesystem-identity string,
lowercase project UUID, then the literal tag `absent` or `present`. A `present` tag
is followed by canonical Git common-dir path, its filesystem-identity string, and
the NFC repository-relative project path. No delimiter or omitted empty field is
allowed.

Canonical paths use `/` separators, preserve filesystem-resolved case except that a
Windows drive letter is uppercase, and have no trailing separator except a root.
Filesystem identity strings are `unix:<device-u64-decimal>:<inode-u64-decimal>` or
`windows:<volume-serial-8hex-lower>:<file-id-bytes-lower-hex>`, with no leading
decimal zeroes. The trust key is lowercase hex SHA-256 of the complete byte string.
Round 2 Spike F (`docs/spikes/06-win-fs-identity/FINDINGS.md`) verified
`fs.statSync(dir, { bigint: true })` on Windows gives a `dev` that matches the OS
volume serial byte-for-byte, formatted as exactly 8 lowercase hex digits as
written here, and an `ino` stable across `git init`/commit/checkout and an
editor-style atomic rewrite of a file inside the directory. The `file-id-bytes`
half is a variable-length field, not a fixed 16 bytes: plain `stat()` on NTFS
returns at most 8 bytes' worth of file-id bits (the worked example below shows a
16-byte/ReFS-width value for illustration only); an implementation using only
`fs.statSync` will produce a shorter hex string, which is a valid encoding of the
same format, not a deviation from it.

`GitIdentity` is `(canonicalGitCommonDir, gitCommonDirFilesystemIdentity,
projectPathRelativeToWorktreeRoot)`. It identifies the local repository storage
and the project's location within that worktree. It contains no branch name,
`HEAD`, commit ID, index checksum, remote URL, or Git user identity.

A trust grant matches only the same complete subject. Moving or copying the
project, replacing the directory at the same path, changing `projectId`, creating
or replacing its Git repository, or moving it within a worktree requires a new
decision. `HEAD`, ref, commit, rebase, and index values are not themselves part of
the subject, so those operations do not invalidate trust while canonical path,
filesystem identities, `projectId`, and GitIdentity remain unchanged. Resolving two path
aliases to the same canonical path and filesystem object does not create two
subjects.

Normative encoder vectors:

| Platform | Ordered V1 fields after the prefix | SHA-256 |
|---|---|---|
| Unix, no Git | `/home/alice/project`; `unix:2049:123456`; `0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10`; `absent` | `d4e6fdfbde06ba486ac28297a4a55e0eaaf086fdfb70ba6302e162afb12ad6a9` |
| Windows, Git | `C:/work/termcraft`; `windows:1a2b3c4d:00112233445566778899aabbccddeeff`; `0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11`; `present`; `C:/work/.git`; `windows:1a2b3c4d:ffeeddccbbaa99887766554433221100`; `termcraft` | `3912b4962af0420f5c76cd2890d90369815af23768f3b3cffd3b5127ec3824b1` |

termcraft may read the minimal manifest and chat text needed to identify and
present an untrusted project, but no page source is imported, rendered, smoke
tested, or exported before trust is granted. A repository can copy a `projectId`
but cannot copy the machine-local path, filesystem identity, Git identity, or
trust grant as a unit.

## 9. ProjectLease and writable ownership

Every process that may mutate a project must hold `ProjectLease` for its entire
project lifetime. The lease is a non-blocking exclusive operating-system lock on
an open `.termcraft/lock` handle. The file may contain PID, process start time,
hostname, and a UUIDv7 lease instance for diagnostics, but none of those values
proves ownership. The held OS lock is the sole authority.

If acquisition fails, termcraft reports that another instance owns the project
and performs no mutation. It may display bounded diagnostic metadata from the
file, clearly labeled as advisory. A crashed process releases the OS lock; the
next process opens the existing file, acquires the lock, and replaces its
diagnostic contents while holding it. termcraft never deletes or steals a lock
because a PID appears absent, stale, or reused.

For a missing project, creation uses create-new semantics for `.termcraft/` and
then acquires the lease before writing the manifest or first chat. Two Home
screens racing to create the same project result in one owner and one lease
failure, never two writers.

The in-process project-write mutex remains useful for ordering agent apply,
Restore, local-state writes, and user-confirmed Git commits. It does not replace
`ProjectLease`; the lease excludes other processes, while the mutex serializes
mutations inside the owner process.

## 10. Durable transactions

### 10.1 Journal protocol

Every logical operation that changes authoritative or recovery-relevant ProjectStore
bytes uses the common `ProjectTransaction` engine. Rebuildable projections and the
best-effort operations log use their own bounded atomic cache/log protocols and are
never recovery authority. Specialized transaction kinds are turn, Restore, export publication,
and migration; ordinary project creation, local-state replacement, title edits,
standalone pin events, chat append, and explicit JSONL repair use the typed
`project-mutation` kind. Git's own object/index writes and best-effort operational
logging are outside this engine.

Under `ProjectLease` and a project-write permit, preparation creates
`transactions.local/{transactionId}/`, writes and verifies immutable payloads, then
writes canonical `plan.json`. The plan records kind/domain identity, ordered
replace/delete/append operations, exact old and new file images, JSONL
offset/prefix/record identities, and payload hashes. No target changes in prepared
state. After a final CAS, create-new `intent.json` names the plan hash; this is the
point of no rollback.

Operations then roll forward in order. Same-directory temporary files plus durable
replacement implement one target write; append recovery uses only a transaction-
proven prefix. Each realized operation receives an immutable `applied/*.json`
marker; the detailed contract's Restore-only `record-pending` append rebase receives
an immutable `rebases/*.json` marker. No other transaction kind writes that directory.
Success is published only after all postconditions and
create-new `committed.json` verify. A mismatch receives `conflict.json` and never
authorizes overwrite.

The journal format and exact operation protocol are normative in
[`2026-07-16-turn-durability-staging-design.md`](2026-07-16-turn-durability-staging-design.md).
Committed journals may be removed only after no consumer or later transaction needs
their outcome. The OS lease blocks another supported writer, and the Kernel exposes
no intermediate success; startup roll-forward before project load gives one logical
visible outcome without claiming simultaneous multi-file filesystem replacement.

### 10.2 Startup recovery

After acquiring `ProjectLease` and before exposing project state, termcraft scans
`transactions.local/` in stable lexical UUID order and classifies each journal before
examining targets:

- valid plan and payloads with no `intent.json`: discard the prepared journal; no
  target comparison or write is permitted;
- valid `intent.json` naming the plan hash and no valid `committed.json`: roll forward
  operation by operation using the detailed before/after/partial-append rules;
- valid `committed.json`: recognize the domain action as complete and do not compare
  targets that may have legitimately changed later;
- invalid plan, payload, marker, identity, path, size, or hash: stop with the typed
  journal-corruption error and write nothing.

For an intended operation, before-state authorizes the planned write, after-state
authorizes only its applied marker, a transaction-proven partial append authorizes
the exact repair in §11.3, and a Restore `record-pending` append-only extension may
use the detailed design's immutable rebase marker. Any other observation enters a
no-overwrite recovery conflict. Once all intended operations verify, recovery writes
the committed marker but retains the journal. Committed journals are garbage-
collected only after startup schema/tree validation and reference checks complete and
no unresolved action or consumer references them.

Generation apply places all changed page replacements, the portable manifest
change, the terminal agent record, and automatic pin-status events in one
transaction. Restore places the validated canonical-source replacement and the
captured target-chat Restore record in one transaction. Thus the Git-history
design's live `record-pending` UI remains useful for a recoverable I/O failure,
but its evidence persists in `transactions.local/`: after restart, startup
recovery completes an unambiguous pending append instead of forgetting it.

`Retry record` reuses `restoreActionId` and checks only the captured target chat.
If a previous exact record is already present, it completes without appending; if
the target is at the prepared before-state or proven partial state, it applies the
prepared append. A valid append-only extension uses the same durable Restore rebase
marker and preserves every intervening record. It never repeats Gate, source replacement, or the pre-Restore
source freshness check. A conflicting target remains an explicit recovery error.

## 11. JSONL contract and recovery

### 11.1 Physical format and limits

All termcraft JSONL is UTF-8 without BOM and uses LF. The first line is a typed,
versioned header. Every later line is one JSON object with a required canonical
UUIDv7 `recordId` and UTC RFC 3339 `ts`. Writers emit keys in a stable order for
readable diffs, but readers do not assign meaning to key order.

The default and first-shipped maximum physical line size is 1 MiB (1,048,576
bytes), including its terminating LF. Therefore a serialized JSON object may use
at most 1,048,575 bytes. The limit is checked before transaction preparation and
during streaming read without allocating an unbounded buffer. An oversized write
fails before any file change and reports the measured and allowed byte counts.

A record is committed only when its LF is durable. A syntactically valid final
JSON object without LF is an uncommitted suffix, not a valid record. Blank lines,
invalid UTF-8, invalid JSON, schema-invalid records, duplicate `recordId` values in
one file, and identity-reference violations are corruption.

### 11.2 Record schemas

A chat header contains `kind = "chat"`, `formatVersion = 1`, `projectId`, `chatId`,
and `createdAt`. Chat events use these required identities:

| Event | Required identity fields and storage meaning |
|---|---|
| `user` | `recordId`, `turnId`, `ts`; stores the sent text plus optional selection and included `pinId` references. |
| `agent` | `recordId`, same `turnId`, `ts`; stores final text, `changedPages` slug list, and warnings. |
| `system:error` or `system:cancelled` | `recordId`, related `turnId` or `actionId`, `ts`; records the terminal event without creating page-history identity. |
| `system:restore` | `recordId`, `restoreActionId`, `pageSlug`, full `sourceCommit`, and `ts`. The containing chat header is its chat identity; no `targetChatId` is duplicated in the record. |

A comments header contains `kind = "pins"`, `formatVersion = 1`, `projectId`, and
`pageSlug`. Pin state is an event fold, never an in-place status field:

- `pin:created` requires `recordId`, `pinId`, `ts`, element ID, fractional `fx` and
  `fy`, and text; its initial status is `open`;
- `pin:status` requires `recordId`, the existing `pinId`, `ts`, and status `open`
  or `resolved`; a user change carries its `actionId`, while automatic resolution
  after successful apply carries the responsible `turnId`.

File order is authoritative. A second create event for one `pinId` or a status
event before its create event is corruption. Reopening appends `pin:status` with
`open`; resolving appends `pin:status` with `resolved`. Restore and historical
browsing never append pin events.

The operational log is local JSONL and follows the same header, `recordId`, UTF-8,
LF, and line-bound rules. Its event taxonomy, redaction, rotation, and retention
are not defined here.

### 11.3 Streaming read and repair classification

Readers stream from byte zero, validate the header, and expose only complete valid
records. They retain the last valid byte offset, record count, and incremental
prefix hash. After the first invalid physical line or unterminated bytes, the
reader continues only far enough, under the same line bound, to classify the
remaining bytes:

A fully valid captured chat can also have grown after a Restore source marker was
released. That is not corruption: if the planned old image is an exact prefix, no
matching/conflicting `restoreActionId` exists, and the durability design's immutable
rebase marker validates, recovery appends the same prepared record after the valid
extension. This exception never truncates or rewrites intervening records.

1. **Transaction-proven append interruption.** A prepared transaction names the
   file; the bytes through its recorded before length have the recorded prefix
   hash; and bytes after that length are either empty, the complete planned append,
   or an exact leading prefix of the planned append. Empty means the append did not
   start, complete means it succeeded before acknowledgement, and a leading prefix
   proves a partial append. For a partial append, recovery truncates exactly to the
   recorded before length, durably flushes, and writes the complete prepared bytes.
   This is the only automatic truncation path.
2. **Unproven corrupt suffix.** No valid record occurs after the first invalid byte
   sequence and no transaction proves the intended append. The reader may return
   the valid prefix for read-only display, but the affected store is mutation-locked
   and the UI reports the path, last valid offset and record ID, suffix byte count,
   and suffix SHA-256. Nothing is discarded automatically.
3. **Mid-file corruption.** At least one complete schema-valid record occurs after
   the corruption, or an identity/reference violation occurs within the otherwise
   valid prefix. This is a hard error. The affected store is not partially opened,
   and termcraft offers no truncate operation because truncation would discard
   known valid records.

Explicit suffix recovery is the command:

```text
termcraft repair jsonl --truncate chats/0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10.jsonl --suffix-sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

The path is relative to `.termcraft/`. Under the lease, the command re-runs the
streaming diagnosis and requires the supplied suffix hash to match. It then creates
and verifies an external backup of the complete affected file using §12, prepares
an explicit-repair transaction, truncates only to the reported last valid LF, and
flushes the file. A changed diagnosis or hash aborts with no rewrite. The command
is unavailable for mid-file corruption. Mid-file recovery requires restoring a
verified backup or manually repairing the file while termcraft is closed.

## 12. Migration safety

Each durable file kind has an independent format counter. `project.toml` and
`workspace.local.toml` use `format_version`; JSONL uses its typed header's
`formatVersion`; other JSON uses `schemaVersion`. Canonical page sources remain
code declaring the public runtime's static integer `kitApiVersion`. A
newer-than-supported data format is a hard error naming the file, and data-format
downgrades are unsupported. An unsupported page runtime integer follows the runtime
compatibility contract instead: canonical Current source remains available for
repair with a preview error, and historical source remains a read-only error state.

Reading an older format may migrate it in memory without changing disk. Before
the first rewrite of any migrated file, whether caused by a bulk migration, a
lazy next write, or a runtime API codemod, BackupStore must complete this protocol:

1. create `{userStateRoot}/backups/{projectId}/{migrationActionId}/` outside
   `.termcraft/`;
2. copy every durable file in the migration rewrite set before modification; a
   bulk project migration backs up all portable files and `workspace.local.toml`,
   excluding the lease, transaction journal, cache, diagnostics, and logs;
3. write a manifest containing original canonical project path, project ID,
   relative path, byte length, SHA-256, source format, termcraft version, and
   backup time for every copied file;
4. durably flush the copies and manifest, reopen every copy, and verify its length
   and SHA-256 against both the source and manifest;
5. write and flush a `VERIFIED` marker only after every check succeeds.

The immutable proposal has `migrationPlanId`; accepting it mints one
`migrationActionId`, which is persisted with `migrationPlanId` in the migration
journal domain together with the backup path/manifest digest and source/target
schema versions. Migration transaction preparation and target rewrites cannot begin before the
`VERIFIED` marker exists. Insufficient space, permission errors, copy errors,
flush errors, or hash mismatch abort migration with every project file unchanged.
Being inside a Git repository never weakens or skips this protocol; an uncommitted
file, ignored local state, or corrupted working copy may not exist in Git.

Source, backup, plan, or decoder drift discovered before durable intent discards the
candidate and any prepared no-intent journal and completes as `failBeforeIntent`; it
never enters migration recovery. Recovery is legal only for a journal with valid
durable intent.

Migration rewrites then use §10 transactions. Historical Git objects are never
rewritten. A runtime API codemod applies only to canonical current page sources after the
verified backup and current trust decision. Backups are not deleted automatically
by migration and are outside all termcraft Git scopes.

This repository is pre-code. The abandoned numbered-page layout, `c1` chat naming,
portable `config.toml`, PID-stale-lock deletion, and cached-manifest schema have
never shipped. The first implementation adopts this document directly as format
version 1. No migration or compatibility reader for an abandoned version is
created. Future shipped format 1 data is the beginning of the migration fixture
chain.

## 13. Git commit-scope implications

Commit planning uses a central `StoragePathPolicy` in addition to Git ignore
rules. A path denied by policy remains denied even if it is tracked, force-added,
or re-included by a `.gitignore` negation. Paths are classified from normalized
repository-relative paths with no-follow filesystem checks.

- `/commit-page` includes only the active slug's canonical `page.tsx`.
- `/commit-infra` includes only `.termcraft/project.toml`,
  `.termcraft/.gitignore`, and later root-level portable schema files explicitly
  registered in `StoragePathPolicy`. In the first shipped schema the allowlist has
  exactly the first two paths. There is no `config.toml`.
- `/commit-all` includes every changed portable path under `.termcraft/`, including
  project state, pages, comments, and export artifacts, after applying hard
  exclusions.
  <!-- amended 2026-07-26 (MVP blocker fix bundle §2.5): chats reclassified hard-local -->

The following are hard-excluded from all three commands, dirty counts, status
dots, commit previews, and staging operations performed by termcraft's Git
adapter:

- `lock`;
- `workspace.local.toml`, every `*.local` or `*.local.*` file, and every directory
  whose name ends in `.local`;
- `chats/` <!-- amended 2026-07-26 (MVP blocker fix bundle §2.5): chats reclassified hard-local -->;
- `transactions.local/` and all temporary transaction payloads;
- `cache/`, `diagnostics/`, and `logs/`;
- migration or repair backups, including defensive matches for `backup-*` and
  `backups/` if such paths appear under `.termcraft/` despite the required external
  placement;
- temporary, swap, and atomic-replacement files created by ProjectStore;
- every path outside `.termcraft/`.

The generated `.gitignore` contains matching anchored rules for user visibility,
but correctness rests on `StoragePathPolicy`. Git status refresh and commit dialogs
count only eligible paths. Target-stack edits appear under `/commit-infra` because
they change `project.toml`; active page/chat, preview, backend, model, effort, and
session changes never do.

Git operations remain outside ProjectStore transactions and retain the stale-plan,
index-preservation, hook, signing, and confirmation rules of the Git-backed history
design. No transaction or diagnostic record creates a relationship between a Git
commit and a turn or prompt.

## 14. Operational flows and error handling

### 14.1 Existing-project launch

1. Canonicalize the project root and verify supported local-filesystem primitives.
2. Open `.termcraft/lock` and acquire `ProjectLease`; refuse mutation if held.
3. Read and validate the minimal `project.toml` identity and format without
   executing design code.
4. Classify journals before exposing any project store: discard prepared journals
   without intent, roll intended journals forward, and recognize committed journals
   without garbage-collecting them yet.
5. Diagnose durable formats without starting a new rewrite. Intended transactions
   recover before trust because they cannot be rolled back; committed-journal GC
   waits until schema/tree validation and reference checks complete.
6. Build `TrustSubject` and perform the trust check before importing, rendering,
   smoke testing, codemodding, exporting page code, or beginning a newly accepted
   migration.
   Refusal finishes opening as ready but untrusted/read-only: chat and history may be
   read, execution capabilities remain disabled, and `ProjectLease` remains held
   until explicit close.
7. If `migrationPlanId` is accepted after trust, mint `migrationActionId`, complete
   its verified external backup, transform/validate candidates, and commit
   `MigrationTransaction`.
8. Load portable stores by streaming validation, load local workspace state or
   defaults, and resolve active page/chat fallbacks.
9. Extract page metadata from exact-key cache hits or canonical sources, then open
   the Workspace. Optional Git inspection never gates project load.

### 14.2 New project and chat creation

Project creation mints `projectId` and creates the format-1 manifest, generated
ignore file, local workspace file, and initial chat header through one
`project-mutation` transaction after acquiring the lease. It then computes the full
`TrustSubject` and records the local implicit trust grant. The orchestrated first
turn separately runs admission `TurnTransaction`, which mints `turnId` and appends
the first user `recordId` before backend execution. `chatId`, `turnId`, `recordId`,
`commandId`, and both transaction ids are distinct UUIDv7 values. A later
`/new` command mints a new `chatId`, writes a matching header through a transaction,
and updates only `workspace.local.toml` to make it active.

### 14.3 Turn and pin flow

Accepting Send mints `commandId` and `turnId`; the exact user record is appended
before backend execution. Session resume uses §6.2. A successful Gate result
prepares one transaction containing every changed canonical page, any portable page
order change, the terminal agent record, and one `pin:status resolved` event for
each included pin that resolves because the turn applied. An empty design diff still
appends the agent record but does not resolve pins. Failure or cancellation appends
its terminal chat event under the same `turnId` and leaves canonical sources and
pin status unchanged.

Pin creation mints `commandId`, `actionId`, `pinId`, `recordId`, and
`transactionId`; reopening or manually resolving retains `pinId` and mints new
command, action, record, and transaction IDs.

### 14.4 Restore flow adjustment

All Git selection, staged-source, freshness, confirmation, exact-full-object, and
Gate checks from the Git-backed history design remain. At confirmation, Restore
mints one `restoreActionId` bound to captured `targetChatId`, page slug, full source
commit, and confirmed source hash. The ProjectStore transaction durably prepares
both the source payload and exact target-chat record before replacing the source.
It touches no pin, other chat, other page, Git index, `HEAD`, or branch.

If an I/O error interrupts apply, the UI reports the action as incomplete and
retains Retry while the process lives. If the process exits, the persisted journal
is recovered before the next load. Neither path repeats Gate or source replacement
when the after-state already proves they completed.

### 14.5 Error matrix

| Condition | Required behavior |
|---|---|
| Lease is held | Refuse mutation and show advisory owner metadata; never delete by PID. |
| Unsupported or remote filesystem | Refuse project mutations before journal preparation. |
| Project/path identity mismatch or writable symlink escape | Hard error naming both expected and observed identity/path. |
| Missing local workspace file | Use deterministic local defaults. |
| Corrupt local workspace file | Preserve and report it; use in-memory defaults until explicit reset. |
| Cache corruption or extractor-version mismatch | Treat as a miss and rebuild; never mutate portable state. |
| Session scope/checkpoint mismatch or SDK resume failure | Start fresh and seed from the bounded chat excerpt. |
| JSONL write exceeds 1 MiB line limit | Reject before mutation with measured size. |
| Transaction-proven partial append | Repair from prepared exact bytes and complete forward recovery. |
| Unproven corrupt JSONL suffix | Expose only the valid prefix read-only and require the hash-confirmed explicit repair flow. |
| Mid-file JSONL corruption | Hard error; no partial open and no automated truncation. |
| Transaction precondition conflict or corrupt journal | Hard recovery error; preserve target and journal for diagnosis. |
| Disk-full, flush, or rename failure after prepare | Do not report success; retain journal for same-process Retry or startup recovery. |
| Migration backup cannot be verified | Abort before any project rewrite, regardless of Git state. |
| Data format newer than binary | Hard error naming the file and required upgrade; no partial decode. |
| TrustSubject has no matching grant | Prompt before any design-code execution; changing `HEAD` alone does not prompt. Refusal leaves the project ready but untrusted/read-only and keeps the lease until explicit close. |
| Diagnostics or operational-log write fails | Do not alter the primary transaction result; surface the logging failure in memory and stderr. |

`DiagnosticsStore` writes project-scoped diagnostic artifacts only under
`.termcraft/diagnostics/`. The operational log writes only the active
`.termcraft/logs/operational.jsonl` segment and rotated
`.termcraft/logs/operational.<n>.jsonl` segments. Both are local, hard-excluded, and
non-authoritative. Their event catalog, data minimization, redaction, rotation,
retention, and support-bundle UX are owned by the projections and observability
design and cannot change these exact placement or exclusion rules.

## 15. Integration and ownership

The master design, Git-history continuation, and `docs/architecture/` summaries have
been revised to use this storage model. This document remains the normative owner of
the exact portable/local layout, TOML and JSONL schemas, UUID rules, session
checkpoint, metadata cache, TrustSubject encoding, ProjectLease, migration backup,
and `StoragePathPolicy` exclusion contracts.

The Git-history continuation remains normative for slug identity in Git, Current
row precedence, first-parent browse, Restore UX/validation, and confirmed commit
behavior. The durability design owns exact transaction journal and roll-forward
mechanics. Restore creates no user-facing design backup or Git commit; its local
transaction payload is recovery evidence, while §12 backups exist only for
migration and explicit JSONL repair.

Architecture files summarize these rules and must link back here; they may not
introduce another path name, serialized field, record kind, trust key, or backup
exception.

## 16. Testing strategy

### 16.1 Identity and schema tests

- UUIDv7 generation under same-millisecond bursts and wall-clock rollback; canonical
  validation and uniqueness for every identity class.
- Project creation proves that pages have only slugs and that no page UUID or
  commit-correlation field exists.
- Chat filename/header/project identity matching, comments path/header matching,
  duplicate record IDs, duplicate pin creation, and status-before-create failures.
- Property tests fold arbitrary valid pin event streams and prove latest file-order
  status wins independently of timestamps and UUID ordering.
- Portable schema snapshots prove target stack and page order travel while active
  page/chat, backend/model/effort, preview/UI state, and sessions do not.

### 16.2 Lease and path-safety tests

- Two real processes contend for one project; exactly one holds the lease.
- Abrupt owner termination releases the OS lock even when the lock file remains.
- Missing, reused, and forged PIDs never authorize lock deletion or takeover.
- Symlink, junction, reparse-point, absolute-path, `..`, case-normalization, and
  Unicode-normalization attempts cannot escape the writable project root.
- Local filesystems pass the primitive probe; mocked remote or weak-lock filesystems
  fail before mutation.

### 16.3 Transaction crash-injection tests

- Inject process termination after every durable step of project creation, one-file
  replacement, multi-page generation apply, chat append, pin-status append,
  local-state update, Restore, migration, and explicit repair.
- On restart, each prepared operation is either already in after-state or is
  completed exactly once before project load; no duplicate `recordId`, pin status,
  agent record, or Restore record appears.
- Before-state, after-state, empty append, exact partial append, complete append with
  missing acknowledgement, changed target, missing payload, bad payload hash, and
  corrupt intent all exercise their distinct recovery branches.
- A Git commit winning the in-process mutex before agent apply remains independent;
  the recovered apply becomes an ordinary uncommitted change.

### 16.4 JSONL tests

- Empty logs, headers, valid streaming, multibyte UTF-8 boundaries, and lines at
  exactly 1 MiB pass; a line one byte larger fails without allocation growth or
  mutation.
- Valid JSON without final LF, invalid UTF-8, malformed final JSON, several corrupt
  suffix lines, oversized suffixes, blank lines, and valid records after corruption
  produce the specified classifications.
- Only an exact prepared transaction can trigger automatic truncation; wrong base
  length, prefix hash, append hash, or partial bytes cannot.
- Explicit suffix repair requires the current suffix hash and a verified external
  backup; a concurrent file change aborts.
- Mid-file corruption never exposes a writable prefix or offers truncate.

### 16.5 Session, cache, trust, migration, and Git-policy tests

- Resume accepts an unchanged checkpoint prefix with additional records and sends
  the suffix as delta. Fewer records, rewritten prefix, changed backend/model/account/
  workspace scope, corrupt chat, and SDK rejection start a fresh bounded seed.
- Cache hits require exact slug, exact source hash, and extractor version; malformed
  entries and any one-key change rebuild without a portable write.
- Trust aliases for the same canonical filesystem object match. Path move, directory
  replacement, project-ID change, Git initialization/replacement, and worktree-path
  change require trust; branch, `HEAD`, index, and commit changes do not.
- Bulk, lazy, and runtime API migrations cannot prepare a rewrite before every backup copy
  is flushed, reread, and hash-verified. Git presence never changes the result.
- `/commit-infra` includes only its two first-schema paths. `/commit-all` includes
  portable pages, pins, and exports while excluding every hard-local class,
  even if a file is tracked or re-included by ignore rules.
  <!-- amended 2026-07-26 (MVP blocker fix bundle §2.5): chats reclassified hard-local -->

## 17. Acceptance criteria

This design is implemented when all of the following are true:

1. A fresh project writes the format-1 layout directly, with UUIDv7 project/chat/
   turn/command/record identities and slug-only page identity. No abandoned-schema
   migration exists.
2. Cloning or committing a project carries `project.toml`, target stack, page order,
   pins, canonical sources, and selected exports, but never active workspace
   state, sessions, trust, transactions, caches, diagnostics, logs, lock data, or
   backups.
   <!-- amended 2026-07-26 (MVP blocker fix bundle §2.5): chats reclassified hard-local -->
3. `project.toml` contains no cached page metadata or local settings; exact
   source-hash/extractor-version cache invalidation is demonstrably rebuildable.
4. Session resume occurs only when chat ID, opaque backend scope, record count, and
   prefix hash validate. Every mismatch starts fresh with the bounded chat excerpt.
5. Trust is bound to canonical path, filesystem identity, portable project ID, and
   Git repository identity when present, and never to `HEAD`.
6. A second process cannot mutate the project, and no PID-only condition can delete
   or steal the lease.
7. Every durable multi-file mutation has prepared local recovery evidence and is
   completed exactly once or stopped on an explicit precondition conflict before
   project state is exposed.
8. Every JSONL record has UUIDv7 `recordId`, every physical line is bounded at 1
   MiB, valid-prefix streaming is bounded, and automatic partial-append repair
   occurs only with exact transaction evidence.
9. An unproven corrupt suffix requires hash-confirmed explicit recovery after a
   verified external backup; mid-file corruption is a hard error with no truncate
   path.
10. Pin lifecycle changes are append events, and successful generation apply folds
    page changes, agent outcome, and automatic pin resolution into one transaction.
11. Every migration rewrite is preceded by a flushed, reread, hash-verified backup
    outside `.termcraft/`, regardless of Git availability or cleanliness.
12. `/commit-infra` and `/commit-all` enforce the hard local-path exclusions in code
    independently of `.gitignore`, and no Git commit is correlated with a prompt or
    turn.

## 18. Out of scope

- daemon mode, IPC clients, multi-user projects, multiple concurrent writers, and
  distributed leases;
- network, removable, cloud-synchronized, or weak-consistency filesystems;
- external-edit watching or merge-on-write behavior while termcraft runs;
- a page UUID, slug rename, history across renamed paths, or commit-to-chat/prompt
  correlation;
- transactions that atomically include Git commits, user hooks, agent backend state,
  or files outside termcraft-owned storage roots;
- automatic restoration or retention management for migration/repair backups;
- a full DiagnosticsStore or operational-log event catalog, redaction policy,
  rotation policy, retention policy, or support-bundle experience;
- migration from the unshipped numbered-page, `cN` chat, `config.toml`, cached-meta,
  PID-stale-lock, or snapshot-pin-status designs.
