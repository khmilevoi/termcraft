# termcraft — Turn Durability and Staging Design

Date: 2026-07-16
Status: approved design

This specification continues
[`2026-07-13-termcraft-design.md`](2026-07-13-termcraft-design.md) and
[`2026-07-16-git-backed-page-history-design.md`](2026-07-16-git-backed-page-history-design.md).
It is one of the detailed designs governed by
[`2026-07-16-production-hardening-decisions-design.md`](2026-07-16-production-hardening-decisions-design.md)
and adopts the identity, portable/local split, JSONL, OS lease, Git exclusion, and
external backup contracts in
[`2026-07-16-production-storage-identity-design.md`](2026-07-16-production-storage-identity-design.md).
The Kernel state names, per-attempt lease, and cancellation boundary remain governed
by [`2026-07-16-kernel-command-contract-design.md`](2026-07-16-kernel-command-contract-design.md),
while bounded deadlines, all-pages staging benchmarks, and export workers remain
governed by
[`2026-07-16-projections-observability-scale-design.md`](2026-07-16-projections-observability-scale-design.md).
It supersedes their claims that staging is reused across turns, that multi-file
turn apply is only a sequence of per-file atomic replacements, that Restore
`record-pending` is memory-only, that export is overwritten in place, and that a
Git repository can replace a verified migration backup. It preserves the
canonical `page.tsx` model, optional Git history, scoped commit controls,
`changedPages`, and Restore's existing `targetChatId` plus `restoreActionId`
semantics.

## 1. Purpose and operating envelope

termcraft v1 is one local process serving one project and one UI. It is not a
distributed database and does not claim simultaneous filesystem atomicity across
several files. It does provide **recoverably atomic project actions**: before a
durable commit intent, no target file is changed; after that intent, the only
automatic outcome is idempotent roll-forward to the fully planned state. A crash
may leave old and new target files physically mixed for a time, but startup
recovery finishes or reports a conflict before the Workspace can open.

The same `ProjectTransaction` engine is used by four specialized domain wrappers:

- `TurnTransaction` for turn admission, successful finalization, and terminal
  failure/interruption records;
- `RestoreTransaction` for one canonical source replacement plus its exactly-once
  captured-chat audit record;
- `ExportPublishTransaction` for publication of one complete immutable export
  generation;
- `MigrationTransaction` for a verified-backup migration of one or more managed
  files.

Ordinary ProjectStore actions that still need durable replace/append semantics—such
as project creation, local workspace updates, page-title edits, and standalone pin
events—use the base engine with `kind: "project-mutation"` and a typed domain action,
without introducing another top-level component or workspace package.

The engine owns durability, compare-and-swap checks, operation ordering,
roll-forward, and startup recovery. A wrapper owns domain validation and decides
which exact old and new file images belong in its plan. The Gate remains the
semantic validator for page code; it is not folded into filesystem safety or
transaction recovery.

The design assumes a local filesystem that supports durable regular-file writes,
same-directory replacement, and directory metadata flushes through termcraft's
platform adapter. If the adapter cannot establish those primitives for the project
volume, mutating actions fail with `unsupported_durability`; termcraft does not
silently weaken the guarantee. Network shares and filesystems with unverifiable
write-through behavior are outside the supported write envelope.

## 2. Invariants

The implementation must preserve all of these invariants:

1. No target mutation occurs before the transaction's commit-intent marker is
   durable.
2. Every operation names a normalized project-relative target and records an old
   file image and a new file image. An image is either `absent` or a regular file's
   exact byte length plus SHA-256 digest.
3. A pending fixed-image operation may write only when the observed image equals
   its planned old image. Equality with the planned new image means the operation
   already happened. Any other image is a recovery conflict and is never
   overwritten.
4. After durable intent there is no automatic rollback and no force-overwrite
   recovery path. Recovery is idempotent roll-forward only.
5. A transaction is complete only after every operation has a durable applied
   marker, every target has been verified against its realized new image, and the
   committed marker is durable.
6. The Workspace and all project mutations remain unavailable until startup has
   recovered every intended transaction or stopped at an explicit recovery
   conflict.
7. All managed `.termcraft` reads, snapshots, replacements, appends, deletes,
   backups, journal accesses, and agent-workspace imports go through
   `SafeProjectFs`.
8. All project mutations require a live `ProjectWritePermit` from the
   project-write mutex. The agent run, Gate, and export rendering do not hold that
   mutex.
9. A turn's user record, including a stable `turnId`, is committed before any agent
   process starts.
10. An agent process cannot coexist with an immutable candidate copied from its
    workspace. Candidate creation starts only after the complete process tree is
    confirmed exited, and the candidate is removed before a retry process starts.
11. A turn workspace is unique to one `turnId` and is never cleared and reused by a
    later turn. Gate retries may reuse that same turn's workspace only after the
    prior attempt's process tree is confirmed exited.
12. Before a turn's final commit intent, the Kernel compare-and-swap checks every
    canonical source and managed input from the send-time read set, including the
    portable manifest, captured chat, and relevant pin logs. Hook-induced or
    external drift produces a typed stale failure and no finalization overwrite.
13. Restore record recovery always targets the chat captured at confirmation and
    deduplicates by `restoreActionId`. Once source replacement is durably marked
    applied, record replay never Gates or writes that source again.
14. `.termcraft/transactions.local/` and transaction temporary names are both
   generated-gitignored and hard-excluded by every Git commit scope. A malformed
   `.gitignore` cannot make them eligible for `/commit-all`.
15. Export activates a generation only after every file in that generation is
    durable and verified. The previously referenced generation stays active until
    the one-file current-generation pointer changes.
16. Migration creates and verifies a byte-for-byte backup of every migration target
    under the machine-local external `BackupStore` before its commit intent, whether
    or not the project is under Git.

## 3. Storage and identifiers

### 3.1 Project-local transaction journal

The machine-local journal is inside the project so recovery travels with the exact
working copy that may contain partially applied files, but it is never portable:

```text
.termcraft/
  .gitignore
  transactions.local/
    format.json
    <transactionId>/
      plan.json
      payloads/
        <payloadId>.bin
      intent.json
      applied/
        0000.json
        0001.json
      rebases/
        0001-0001.json
      committed.json
      conflict.json
  **/.termcraft-tx-<transactionId>-<operationIndex>.tmp
```

Only `plan.json` and `payloads/` exist in the prepared state. `intent.json`, each
`applied/*.json`, each Restore-only `record-pending` append rebase,
`committed.json`, and `conflict.json` are
create-new immutable records. A record is written to a same-directory temporary
file, flushed, installed under its final name, and followed by a parent-directory
flush. Existing records are never edited in place.

`format.json` has its own journal format version and is readable before project
schema migration. A journal format newer than the binary produces
`journal_too_new` and blocks the Workspace. An invalid or unsafe journal path
produces `journal_corrupt`; it is never ignored or deleted automatically.

The full generated exclusions and independent Git deny policy are owned by
`StoragePathPolicy` in the production storage design §13. This transaction design
adds only its transaction-specific reserved names:

```gitignore
/transactions.local/
/**/.termcraft-tx-*.tmp
```

The Git adapter independently rejects `transactions.local/**`,
`**/.termcraft-tx-*.tmp` before forming any Git argument array, in addition to every
storage-policy exclusion. Those names are reserved: user-created files matching
them are machine-local and can never enter a termcraft commit scope.

### 3.2 Identifiers

- `turnId`: a create-new UUIDv7 generated before admission. It is stable across the
  initial attempt and all Gate retries.
- `attempt`: an integer starting at `1`; the initial run plus three retries permits
  values `1` through `4`.
- `leaseNonce`: a cryptographically random 128-bit base64url value assigned to one
  backend attempt. Every retry replaces it; it is never reused.
- `transactionId`: a create-new UUIDv7. Turn transactions also persist their
  `turnId` and phase (`admission`, `finalization`, or `terminalization`).
- `restoreActionId`: the existing create-new Restore idempotency key. A
  `RestoreTransaction` uses it as its domain action id but still has its own
  `transactionId`.
- `migrationPlanId`: a create-new UUIDv7 naming one immutable migration proposal
  before confirmation.
- `migrationActionId`: a create-new UUIDv7 minted when that proposal is confirmed;
  same-process retry and startup recovery reuse it.
- `generationId`: a create-new UUIDv7 for an export generation.
- `commandId`: the UUIDv7 from the accepted Kernel command that originated the
  transaction; startup-generated recovery transactions mint their own command id.
- `recordId`: a create-new UUIDv7 on every JSONL record line. Replaying one prepared
  append reuses its prepared record id; it never mints a replacement id.

Every backend callback and normalized event is internally fenced by the exact tuple
`{turnId, attempt, leaseNonce}`. UUIDv7 values use canonical lowercase hyphenated
RFC 9562 form. External Git and vendor session ids retain their native forms.

### 3.3 Plan format

`plan.json` is canonical UTF-8 JSON with sorted object keys. Its SHA-256 digest is
stored in every later marker. It contains:

```ts
type FileImage =
  | { state: "absent" }
  | { state: "file"; sha256: string; size: number }

type TransactionOperation = {
  index: number
  target: string                 // normalized path relative to .termcraft
  mode: "replace" | "delete" | "append-jsonl"
  oldImage: FileImage
  newImage: FileImage
  payloadId?: string             // complete new file for replace; omitted for delete
  append?: {
    beforeLength: number
    beforePrefixSha256: string
    appendedPayloadId: string    // complete prepared record lines, each ending LF
    appendedSha256: string
    appendedLength: number
    recordIds: string[]
    domainIdentity?: {
      field: "turnId" | "restoreActionId" | "pinId"
      value: string
    }
  }
  releaseAfterApplied?: boolean  // Restore source operation only
}

type TransactionPlan = {
  journalVersion: 1
  transactionId: string
  kind: "turn" | "restore" | "export-publish" | "migration" | "project-mutation"
  domain: Record<string, unknown>
  operations: TransactionOperation[]
  createdAt: string
}
```

`domain` is schema-validated by kind. It includes `turnId`, phase, and
`targetChatId` for turns; `restoreActionId`, `targetChatId`, page, full
`sourceCommit`, Gate attestation hash, and confirmed source hash for Restore;
`generationId` and source-snapshot digest for export; `migrationPlanId`,
`migrationActionId`, backup path, backup manifest digest, and source/target schema
versions for migration; or `actionId` plus a closed
mutation-kind payload for an ordinary project mutation.

Payload bytes are written once and verified. A replacement payload is the complete
new file and must match `newImage`; a delete has no payload. An append payload is
only the complete prepared JSONL record bytes, including each terminating LF. The
operation's old image, exact before length/prefix hash, append hash/length, record
ids, and full-file new image prove no append, a partial append, or a complete append
without acknowledging unrelated later content.

## 4. `ProjectTransaction` engine

### 4.1 State model

The durable state is derived from immutable journal records:

| State | Durable evidence | Target writes allowed? | Next action |
|---|---|---:|---|
| `building` | temporary payload or plan files only | no | discard temporary files after validation |
| `prepared` | valid `plan.json` and all payloads; no intent | no | caller may CAS-check and create intent, or startup may discard |
| `intended` | valid `intent.json` naming the plan hash | yes | roll forward in operation order |
| `applying` | intent plus some applied markers | yes | verify completed operations and continue |
| `record-pending` | Restore source operation has an applied marker; captured-chat append does not | only captured-chat append | replay append; never Gate or touch source |
| `committed` | valid `committed.json` | no transaction writes | publish outcome, then garbage-collect journal when safe |
| `conflict` | valid `conflict.json`, or an observed mismatch found during recovery | no | block Workspace and require external repair plus Retry recovery |

`building` and `prepared` cannot have changed a target by invariant. Startup may
delete them after validating that they have no intent. An intended transaction is
never abandoned automatically.

### 4.2 Physical durability primitive

All journal and target file installation uses this sequence on the same volume and
in the target's own directory:

1. Create a reserved temporary regular file with create-new semantics.
2. Write all bytes, flush file contents and metadata, and close it.
3. Reopen without following links, verify regular-file identity, size, and SHA-256.
4. Replace or install the target with the platform's same-directory primitive.
5. Flush the parent directory (or the Windows write-through equivalent).
6. Reopen the target without following links and verify the realized `FileImage`.

Deletion removes only a regular file whose image still equals `oldImage`, then
flushes the parent directory and verifies `absent`. Directory creation and removal
are structural operations: every parent is opened component by component without
following links; newly created directories are flushed; only empty transaction-
owned directories are removed.

Round 2 Spike G (`docs/spikes/07-durability-primitive/FINDINGS.md`) verified step
5's parenthetical on Windows: the write-through equivalent is `CreateFileW` with
`FILE_FLAG_BACKUP_SEMANTICS` and **`GENERIC_WRITE` alone** (not `GENERIC_READ`,
which opens the handle successfully but makes the following call fail with
`ERROR_ACCESS_DENIED`), followed by `FlushFileBuffers` on the directory handle,
via `bun:ffi` against `kernel32.dll` — no native addon and no fallback to the
weaker `FILE_FLAG_WRITE_THROUGH` file-level flag were needed. This is not a cheap
primitive: median 18.9 ms per directory flush (worst 63.4 ms, 20 iterations, 4 KiB
file), so a ten-artifact transaction (§4.3's apply loop touching `plan.json`,
`intent.json`, every payload, every applied marker, and `committed.json`) costs on
the order of 380 ms of flush-dominated I/O — a real, user-visible cost, not a
rounding error. An unsupported volume (tested against an SMB share) is
detectable before any mutation is trusted durable: cheaply via `GetDriveTypeW`
(`DRIVE_REMOTE` vs. `DRIVE_FIXED`) as a pre-flight gate, and confirmed by the real
flush primitive itself failing with a distinct `GetLastError()`
(`ERROR_INVALID_FUNCTION`) even though the ordinary create/write/rename file
steps succeed unremarkably on that same share — the flush step is where
detection actually happens, so it cannot be skipped as an optimization for
"probably fine" filesystems. Separately, Windows has no `O_NOFOLLOW` in Bun/Node's
`fs.constants`; steps 3 and 6's "reopen without following links" is implemented
as `lstatSync` immediately before an ordinary open, which leaves a narrow TOCTOU
window between the two calls — weaker than a true atomic `O_NOFOLLOW` open, and
recorded as a residual risk rather than closed.

The implementation does not claim that step 4 for one file makes any other file
change simultaneously. The durable intent plus startup gate is what makes the
multi-file action recoverable.

### 4.3 Prepare, intent, and apply

Every wrapper follows the same protocol:

1. Acquire a `ProjectWritePermit` when the wrapper is ready to bind its final old
   images. Long-running agent work, Gate checks, export rendering, and migration
   transformation run before this point unless their domain section states a
   stronger lock requirement.
2. Read every target through `SafeProjectFs`, construct exact new bytes, and write
   all payloads. Flush and verify each payload.
3. Write and flush immutable `plan.json`; verify its plan hash and every payload
   reference.
4. Re-check every domain precondition under the same write permit. For turn
   finalization this is the full send-time read-set CAS described in §7.5. For
   Restore it is the confirmed source, index, Git object, Gate, and captured-chat
   checks in §9. For export and migration it is their source snapshot or verified
   backup check.
5. Write and flush `intent.json`. This is the point of no rollback. No target has
   changed before it.
6. For each operation in ascending `index` order:
   - if its durable applied marker exists, validate that marker; fixed operations
     that are not released must still have their realized new image;
   - otherwise observe the target without following links;
   - for replacement/deletion, equality with `newImage` is an ambiguous prior
     installation and equality with `oldImage` authorizes the planned operation;
   - for JSONL append, run the exact prefix/partial/full classification in §4.4;
   - any other state stops with a durable recovery conflict;
   - write and flush the operation's applied marker.
7. Verify all non-released targets against their realized new images and all
   released operations against their valid applied markers.
8. Write and flush `committed.json`, including the plan hash and realized image of
   every operation. Only now may the Kernel emit success or run a post-commit local
   effect.
9. Release the write permit. Journal cleanup may happen only after no UI/event
   consumer needs its outcome and no later transaction references its payloads.

An I/O error after intent leaves the transaction pending and blocks overlapping
project writes. The Kernel may retry the same roll-forward immediately. If it
cannot make progress, it presents `transaction_io_pending`; restart repeats the
same protocol.

### 4.4 Exactly-once JSONL append

Chat and pin events use prepared append bytes, not whole-file replacement and not a
blind append. Preparation streams and validates the complete current JSONL prefix,
records its exact byte length and SHA-256, serializes complete bounded records with
new UUIDv7 `recordId` values and terminating LF, and computes the exact full-file
after image.

Apply/replay classifies the observed target:

1. Exact old length and prefix hash means no append started. Open the regular file
   without following links, seek to the recorded offset, write the complete append
   payload, flush, and verify `newImage`.
2. Exact `newImage` means the complete append happened before acknowledgement.
   Validate that each prepared `recordId` occurs exactly once with the prepared
   bytes, then mark applied without another append.
3. The exact old prefix followed by a non-empty leading byte prefix of the prepared
   append proves a transaction-interrupted partial final append. This is the sole
   automatic truncation case: truncate exactly to `beforeLength`, flush, append the
   complete prepared bytes, flush again, and verify `newImage`.
4. A zero-byte or proper-prefix append remainder is never exposed as a committed
   JSONL record. A syntactically valid final object without LF is still partial.
5. Later records, a different byte after the old prefix, truncation before the old
   length, a changed header/prefix, duplicate/conflicting `recordId`, an oversized
   line, or any middle-file corruption is a recovery conflict. The sole exception is
   the Restore `record-pending` append-only growth rebase in §9.2: it requires a
   durable immutable rebase marker, preserves every valid intervening record, and
   never rewrites or merges record content.

A Restore append-growth rebase marker is create-new and immutable. It contains the
`planHash`, operation index, previous prefix length/hash, observed new prefix
length/hash, observed intervening-suffix hash, rebased append payload hash, and the
rebased complete `newImage`. Recovery validates every field before using it.

This preserves every existing record and makes duplicate acknowledgement
idempotent while respecting the production JSONL valid-prefix contract. While a
Restore is `record-pending`, chat switching/creation and writes to other chats remain
available; the captured target chat is mutation-locked until its prepared append
commits or reaches explicit recovery conflict.

### 4.5 Project-write mutex and permits

The existing process lock still excludes a second termcraft process. Inside the
process, one fair FIFO project-write mutex serializes:

- transaction prepare-from-current-state, final precondition CAS, intent, and apply;
- `/commit-page`, `/commit-infra`, and `/commit-all` revalidation, the complete Git
  command including hooks/signing, and mandatory post-command status refresh;
- single-file project bookkeeping that is expressed as a one-operation
  `ProjectTransaction`;
- startup recovery.

Acquisition returns an opaque `ProjectWritePermit` with a random permit id. Every
mutating `SafeProjectFs` and transaction-engine method requires that permit and
checks that it is still the mutex's active permit. Release invalidates it; a stale
async continuation cannot write after release.

The turn's `{turnId, attempt, leaseNonce}` is a separate lifecycle fence. Final
turn apply requires both a valid write permit and equality with the current live
turn fence. Git commands do not carry a turn fence. A commit that wins the mutex
first may change only Git metadata, in which case turn CAS still succeeds; if a hook
changes a turn input, turn CAS fails. If turn apply wins first, the Git adapter's
existing `CommitPlan` hashes become stale and the commit dialog must be replanned
and reconfirmed.

### 4.6 Recovery decision table

| Journal/target observation | Recovery action |
|---|---|
| Invalid path, unsafe file type, invalid plan hash, missing payload, or payload hash mismatch | Stop with `journal_corrupt`; write nothing. |
| Valid plan and payloads, no intent | Delete the uncommitted transaction directory; targets are untouched by contract. |
| Intent exists, target equals operation old image | Apply planned new image, verify, and mark applied. |
| Intent exists, target equals operation new image, applied marker absent | Treat as ambiguous acknowledgement; write applied marker and continue. |
| Applied marker exists and non-released target still equals realized new image | Continue. |
| Fixed operation target equals neither old nor new, before or after an unsealed applied marker | Write `conflict.json`; never overwrite. |
| JSONL target equals the exact old prefix/length | Append the prepared complete LF-terminated records and verify the full new image. |
| JSONL target equals the exact full new image and prepared record ids occur once | Mark applied; do not append again. |
| JSONL target contains an exact leading prefix of the prepared append after the exact old prefix | Truncate only the proven partial append, flush, append complete prepared bytes, and continue. |
| Restore is `record-pending` and the captured chat is a valid append-only extension of the planned old image | Persist/validate the immutable rebase marker from §4.4, append the same prepared record after the observed prefix, verify rebased `newImage`, and continue. |
| JSONL target has later/different bytes, prefix rewrite, earlier truncation, malformed middle, or conflicting record id | Write `conflict.json`; never overwrite or rebase. |
| Restore source has a valid `releaseAfterApplied` marker but the source later drifted | Do not inspect or write the source; recover only the captured-chat record. |
| All operations are applied, committed marker absent | Verify postconditions and write the committed marker. |
| Committed marker exists | Treat the domain action as complete; do not compare targets that may have legitimately changed later. |
| Conflict marker exists | Re-present the same conflict before Workspace; no automatic abandon or force action. |

## 5. `SafeProjectFs`

`SafeProjectFs` is a mandatory capability, not a convenience wrapper. It is rooted
with an opened handle at either `.termcraft`, a turn workspace, a transaction
candidate, an export candidate, or a migration backup. Callers pass only validated
relative paths; no caller performs direct `Bun.file`, Node filesystem, or string-
joined managed-path access.

### 5.1 Path rules

Before any lookup, the path layer rejects:

- empty paths, NUL/control characters, empty components, `.` or `..` components;
- POSIX absolute paths, drive-rooted or drive-relative Windows paths, UNC paths,
  and Windows device namespaces such as `\\?\\` and `\\.\\`;
- backslashes in canonical relative paths, alternate separators, and colon anywhere
  in a component, which excludes NTFS alternate data streams;
- components ending in a dot or space, Windows reserved device names, and names
  outside each managed namespace's grammar;
- a path longer than 240 UTF-8 bytes, more than 16 components, or a component longer
  than 120 UTF-8 bytes;
- two discovered names that collide under Unicode NFC plus platform case folding.

Canonical managed paths use `/` separators. Page slug validation remains
`^[a-z0-9][a-z0-9-]{0,31}$` with the existing Windows device-name exclusions.

Each component is opened relative to the already opened parent with no-follow
semantics. Every lookup rejects symbolic links, junctions, mount-point redirects,
all Windows reparse points, and any component whose identity changes between
validation and use.

### 5.2 File identity and type rules

Managed leaves must be ordinary regular files with exactly one link. POSIX
`st_nlink != 1`, a Windows link count other than one, or duplicate file identity
within an enumerated tree is rejected as `unsafe_hardlink`. FIFOs, sockets,
devices, sparse redirectors, and platform-special files are rejected. Directories
must not be reparse points and may contain only entries allowed by their namespace.

When copying an untrusted workspace file, the implementation opens the source once,
records file id, link count, size, and timestamps, hashes bytes while streaming to a
create-new destination, then rechecks source identity and metadata before accepting
the copy. A change during the copy is `workspace_changed_during_snapshot`; the
candidate is discarded.

### 5.3 Limits

Limits are checked before allocation and again while streaming:

| Namespace | Per-file limit | Count/aggregate limit |
|---|---:|---:|
| Agent `pages/*.tsx` | 2 MiB | 256 page files |
| Agent `pages.json` | 256 KiB | exactly one |
| Agent `RUNTIME.md` plus runtime type declarations | 4 MiB each | 32 files, 16 MiB total |
| Entire turn workspace/candidate | as above | 512 files, 64 MiB total, depth 8 |
| `project.toml`, `workspace.local.toml`, generated `.gitignore`, local TOML/JSON state | 1 MiB each | 16 MiB total |
| One chat JSONL | 64 MiB | 1,048,576-byte physical line including LF; serialized object ≤ 1,048,575 bytes |
| One comments JSONL | 32 MiB | 1,048,576-byte physical line including LF; serialized object ≤ 1,048,575 bytes |
| One canonical `page.tsx` | 2 MiB | 256 listed pages |
| One export artifact | 16 MiB | 20,000 files, 1 GiB per generation |
| One transaction payload | 64 MiB | 2 GiB per transaction |
| One migration backup | 64 MiB per file | 2 GiB total |

An action that would exceed a limit fails before intent. Existing oversized managed
data opens read-only with a named `storage_limit_exceeded` error and cannot be
silently truncated.

### 5.4 Workspace snapshot and immutable candidate

The mutable agent namespace is exactly `pages/<slug>.tsx` and `pages.json`.
`RUNTIME.md` and runtime type declarations are read-only inputs: changing or deleting them is a
Gate error. Added files, nested page directories, and any other workspace output are
rejected.

After an attempt's process tree is confirmed exited, `SafeProjectFs` enumerates the
entire workspace, validates every entry, and copies it while hashing into a
create-new candidate outside the workspace. No backend process may run while that
candidate exists, its path is never included in a prompt or session seed, and its
files are reopened read-only after creation. The Gate reads only this candidate.
It separately checks page semantics: manifest shape, slug rules, TypeScript,
imports, page contract, smoke render, ids, and warnings. Filesystem safety passing
does not imply Gate validity, and Gate validity never bypasses filesystem safety.

## 6. Turn records, workspace, sessions, and process lifecycle

### 6.1 Durable chat identity

Turn records use the first-shipped storage schema:

```json
{"kind":"user","recordId":"019…","turnId":"019…","text":"make the gauge red","selection":{"pageSlug":"main","element":"cpu-gauge"},"pins":["019…"],"ts":"…"}
{"kind":"agent","recordId":"019…","turnId":"019…","text":"Updated the CPU gauge.","changedPages":["main"],"warnings":[],"ts":"…"}
{"kind":"system:error","recordId":"019…","turnId":"019…","outcome":"interrupted","reason":"process_restart_before_intent","text":"Generation was interrupted before it could be finalized.","ts":"…"}
```

For a new-format turn, the initiating user record and exactly one terminal record
share the `turnId`. A terminal record is either the successful `agent` record,
`system:cancelled`, or `system:error` with typed `error`, `stale`, or `interrupted`
outcome. This is the first shipped schema, so a turn record without `turnId` is
schema-invalid rather than a legacy compatibility case.

The user record contains the exact message, resolved selection, and sent pin ids and
is appended by a committed admission-phase `TurnTransaction` before workspace
execution. The successful agent record remains the existing audit meaning:
`changedPages` lists canonical page identities changed by that turn and is not a Git
version index.

Pin resolution becomes append-only. A successful finalization appends one event per
sent pin:

```json
{"kind":"pin:status","recordId":"019…","turnId":"019…","pinId":"019…","status":"resolved","ts":"…"}
```

Folding the comments log uses the latest valid status event for each pin. Recovery
deduplicates the prepared UUIDv7 `recordId`. Failed, stale, cancelled, and interrupted turns
append no pin-status event.

### 6.2 Unique per-turn workspace

The machine-local sandbox parent is stable per canonical project identity:

```text
<userStateRoot>/sandboxes/<projectKey>/
  turns/<turnId>/
    workspace/
    turn.json
```

`projectKey` is lowercase hexadecimal SHA-256 over
`UTF-8(canonicalProjectRoot) || 0x00 || UTF-8(projectId)`, where `projectId` is its
canonical lowercase UUIDv7 text. There is no stored salt or OS-temporary fallback.
This avoids path disclosure and prevents two projects with the same basename from
sharing a parent. `turn.json` stores non-secret turn metadata,
the send-time read-set hashes, `targetChatId`, and workspace inventory. It is
machine-local and never copied into `.termcraft` or Git.

Creation is create-new. If the turn path already exists, admission fails with
`workspace_collision`; termcraft never clears it and retries under the same id. A
new user message always gets a new `turnId` and new directory. Completed workspace
trees may be deleted only after the process tree is confirmed absent and no
candidate or pending transaction references them. Unsafe or unconfirmed trees are
quarantined and retained for operator diagnosis.

All listed canonical pages are copied into each turn workspace. Partial or
on-demand page staging is not part of this design; all-pages staging remains until
a benchmark demonstrates that copying or Gate diffing is a material bottleneck and
a separate design preserves the same read-set CAS semantics.

### 6.3 Backend cwd, confinement, and session continuation

For every attempt the backend receives the turn's `workspace/` as its cwd and only
writable root. It receives no project-root or candidate path. Existing network and
tool restrictions remain in force.

`BackendCapabilities` adds `sessionWorkspaceBinding`:

```ts
type SessionWorkspaceBinding = "rebindable" | "fixed"
```

A stored vendor session may resume for a new turn only when the backend reports
`rebindable` and proves that the resumed run uses the new cwd and writable root.
`fixed` sessions may continue only for a retry in the same turn workspace. For a
new turn, or whenever rebinding cannot be proven, termcraft starts a fresh vendor
session seeded from the captured chat: up to the newest 32 complete records before
the current user record, capped at 64 KiB UTF-8 by dropping oldest whole records.
Record bodies are never tail-truncated. Selection and pin ids come from the current
user record, not reconstructed session state.

Persistent session checkpoints live inside `workspace.local.toml` and use exactly
the storage contract's `(chatId, sessionScopeId)` key, opaque session id,
`recordCount`, and `prefixHash`. Only a rebindable backend checkpoint is useful
across turns; fixed-session same-workspace retry state remains in the active run.
A backend or model change changes scope and starts fresh.

### 6.4 Fencing and late events

The Agent gateway wraps every callback with `{turnId, attempt, leaseNonce}`. The
Kernel accepts an event only when the tuple equals the active attempt fence and the
turn state permits that event. Events from an older attempt, an earlier process
ownership, or a completed/cancelled turn are dropped and counted for diagnostics;
they never update UI state, session ids, final text, usage, or files.

On run completion the gateway first closes the event stream, obtains the normalized
final outcome, and confirms the complete process tree exited. The Kernel then
retires the attempt fence before candidate snapshot. A callback arriving after
retirement is late even if its tuple was once valid.

### 6.5 Cancellation and process-tree exit

Every backend must place each attempt in an owned process tree: a process group on
POSIX and a Job Object with kill-on-close on Windows. Cancellation, watchdog expiry,
and application shutdown use the same sequence:

1. Stop accepting non-terminal events for the fence and request the SDK's graceful
   cancellation.
2. Wait up to 5 seconds for confirmed process-tree exit.
3. Send graceful tree termination (`SIGTERM` or Job Object equivalent) and wait up
   to 5 seconds.
4. Hard-kill the tree (`SIGKILL` or Job Object termination) and wait up to 5 seconds
   for OS confirmation that no owned descendant remains.
5. Only after confirmation may termcraft snapshot, clear, quarantine, or reuse the
   same turn workspace for a retry.

Round 2 Spike I (`docs/spikes/09-process-tree/FINDINGS.md`) verified the Windows
mechanism from Bun without a native addon: a Job Object created and configured via
`bun:ffi` against `kernel32.dll` (`CreateJobObjectW` +
`SetInformationJobObject`/`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` +
`AssignProcessToJobObject`), tested against a synthetic tree that ignores
`SIGTERM` and spawns `detached: true` descendants specifically to defeat a naive
approach. For the **application-driven cancellation** path (this section's
sequence: explicit `TerminateJobObject` after graceful cancellation fails),
confirmation is a genuine OS read — `QueryInformationJobObject` with
`JobObjectBasicAccountingInformation.ActiveProcesses` — not PID-liveness
polling, and it went from 3 to 0 in 0-1 ms after the kill in every trial; the
whole spawn-assign-kill-confirm sequence completed in well under one second,
comfortably inside the 5-second budgets above. **Open gap for the
crash-recovery case**, not resolved by this spike: kill-on-close firing because
the *controller itself* crashed (bare handle close, no `TerminateJobObject`
call) still kills the tree correctly, but by the time anyone could check, no
process holds a job handle to read `ActiveProcesses` from — the only fallback
available is the same PID-liveness polling this design exists to avoid, because
Windows reuses PIDs. If termcraft needs confirmed cleanup after a controller
crash (not just after a graceful `cancel()`), it needs a named-job-object reopen
strategy or a permanently-running supervisor holding an independent handle,
and that needs its own spike; until then, `backend_unhealthy_unconfirmed_exit`
is a real possible outcome of the crash-recovery path specifically, not a
theoretical edge case. Separately: `taskkill /T /F` (a candidate simpler
fallback) also reached every level of the synthetic tree including both
`detached: true` descendants in this spike, contrary to the a-priori assumption
that `detached` breaks the parent-child link `taskkill` walks — Windows'
`detached` option does not change the OS-recorded parent PID the way POSIX
`setsid()` does. This is recorded as a finding about the fallback, not a
reason to prefer it over the Job Object mechanism, which remains the one with a
genuine read-based confirmation for the case this section's sequence covers.

If exit cannot be confirmed, the backend becomes `unhealthy_unconfirmed_exit`.
The workspace is quarantined, no candidate is copied, no retry or new turn is
started through that backend, and the user sees a restart/health-check action. The
backend becomes healthy again only when a full health check proves the owned tree
absent and a confined write probe succeeds. A cancellation terminal record is not
reported as safely complete until exit is confirmed; otherwise the user record is
later terminalized as interrupted during startup recovery.

## 7. Exact generation-turn sequence

### 7.1 Runtime states

The live turn state machine is:

```text
admitting -> workspace-ready -> running(attempt N) -> stopping
          -> snapshotting -> validating
          -> running(attempt N+1)               [Gate retry]
          -> finalizing -> committed             [success]
          -> terminalizing -> failed|cancelled|stale|interrupted
          -> backend-unhealthy                    [unconfirmed exit]
```

Only one turn lease exists per project. Tabs may still switch and commit commands
may still run under the approved continuation rules, but chat creation/switching,
Restore, export, model changes, and another send stay locked.

### 7.2 Admission and send-time snapshot

1. Resolve the active chat, current selection, and sendable open pins. Generate
   `turnId`; capture `targetChatId`. Admission does not mint a `leaseNonce`.
2. Acquire the project-write mutex.
3. Validate the active managed tree with `SafeProjectFs` and append the user record
   to `targetChatId` through an admission `TurnTransaction`. Commit it fully.
4. While still holding the permit, copy every listed canonical `page.tsx`, the
manifest slice, `RUNTIME.md`, and runtime type declarations into the create-new turn
   workspace. Record exact hashes for the finalization CAS read set:
   - `project.toml`;
   - every canonical page exposed to the agent, including the page inventory and
     expected absence for potential new targets;
   - the captured chat after the admitted user record;
   - each comments log whose selection or sent pins contributed context.
   The turn context separately records the send-time local active page, selection,
   and preview facts for prompt reproducibility; later tab/view changes are allowed
   and are not finalization preconditions.
5. Persist and verify `turn.json`, then release the permit.
6. Only now may attempt 1 start.

If admission commits but workspace assembly or process launch fails, the turn is
terminalized with the same `turnId`; the user record is never removed.

### 7.3 Run, retry, and candidate handoff

1. Mint a fresh `leaseNonce` for the attempt, then start the backend with fence
   `{turnId, attempt, leaseNonce}`, cwd at the unique workspace, and that workspace
   as its only writable root. No attempt reuses a nonce.
2. Stream only matching fenced events. Any event resets the existing 120-second
   silence watchdog.
3. On backend error, cancellation, or normal completion, confirm the complete
   process-tree exit as in §6.5.
4. For a normal completion, retire the attempt fence and copy the entire workspace
   into an agent-inaccessible immutable candidate through `SafeProjectFs`.
5. Diff candidate hashes against the initial workspace inventory. Run the Gate on
   the candidate, never the mutable workspace.
6. If invalid and `attempt < 4`, remove the candidate, confirm again that no backend
   process exists, increment `attempt`, and resume or start a backend according to
   §6.3 against the same turn workspace. The invalid edits remain so the agent can
   repair them.
7. If invalid at attempt 4, remove the candidate, terminalize with a
   `system:error` record whose outcome is `error`, and
   leave canonical pages, manifest, and pins unchanged.
8. If valid, retain the candidate until finalization commits or ends stale. No agent
   process may restart while it exists.

### 7.4 Successful finalization contents

A valid turn's finalization `TurnTransaction` contains every durable effect of the
turn and no unrelated file:

1. changed, added, and deleted canonical
   `.termcraft/pages/<slug>/page.tsx` files, sorted by normalized path;
2. portable `project.toml` changes derived from validated `pages.json`, containing
   only ordered page slugs and other portable domain settings, never cached metadata;
3. a `workspace.local.toml` replacement when the candidate explicitly requests a
   different active page, composed under the permit from the then-current local file
   so unrelated preferences/session checkpoints are preserved;
4. the captured chat's one `agent` record with `turnId`, normalized final text,
   exact `changedPages`, and Gate warnings;
5. one append-only pin-status event for each sent pin whose page occurs in the
   non-empty `changedPages` set. An empty design diff resolves no pin.

The **local active-page effect**—switching the live UI and respawning the preview—is
published only after the committed marker. A crash after the local file write but
before the UI event is harmless: startup initializes the same page from
`workspace.local.toml`. Adding a page without changing
`pages.json.requestedActivePage` does not switch locally.

Operation order is canonical pages, portable manifest, local workspace state, agent
chat append, then pin-status appends. This order is for deterministic recovery and
diagnostics, not a claim of simultaneous visibility.

### 7.5 Mandatory pre-intent CAS

After Gate success, the Kernel acquires the project-write mutex and, before writing
finalization intent, reopens and hashes the complete send-time read set. It also
checks the live turn fence and validates all proposed output paths.

- Any canonical page or page-inventory drift is `source_changed`.
- Any portable manifest drift is `source_changed` with `part: "manifest"`.
- Any captured-chat drift is `stale` with `part: "chat"`; turn finalization never
  rebases its agent outcome across a Git-hook or external chat append.
- Relevant comments-log drift that changes a sent pin or its anchor/status is
  `stale` with `part: "pins"`.
- Send-time local tab, preview, selection, and focus drift is not stale: those values
  were snapshot context, not durable apply preconditions.

The check includes canonical pages the candidate did not modify because the agent
was allowed to read them. It also checks expected absence before creating a page and
the exact old image before deleting one.

This check is performed under the same permit immediately before durable intent.
A `/commit-*` executed during the agent run normally changes only Git state and
does not fail it. A successful or failed Git hook that changes `.termcraft` is
visible here. On any mismatch, no finalization intent is written and no canonical,
manifest, agent-record, or pin-status payload is applied. The candidate is retained
for diagnostics, and a terminalization `TurnTransaction` appends a unique
  `system:error` record with outcome `stale` to the captured chat if that chat remains a valid append-only
log. If even that append cannot be made safely, the UI reports the unrecorded stale
turn and startup orphan recovery retries terminalization without changing design
state.

After intent, each operation performs its own old/new image CAS. An unsupported
external writer racing after the pre-intent check therefore causes a recovery
conflict rather than an overwrite.

### 7.6 Failure and cancellation finalization

Backend errors, exhausted Gate retries, confirmed cancellation, and pre-intent
staleness use a terminalization `TurnTransaction` whose only target is the captured
  chat. It appends exactly one system record with its own `recordId` and the captured
  `turnId`; it never changes
pages, manifest, or pins. If the captured chat gained valid later records, the
terminalization path acquires the project-write mutex, re-snapshots the current
complete valid chat prefix, and prepares a normal `append-jsonl` operation against
that current prefix. This happens before terminalization intent; it does not create a
durable rebase marker. After intent, later bytes conflict normally. The only durable
`rebases/*.json` protocol remains Restore `record-pending` recovery in §9.2.

Cancellation does not resolve pins and does not clear/quarantine the workspace
until process exit is confirmed. The original user record remains the durable
statement of what was attempted.

### 7.7 Orphan and nonterminal turn recovery

After transaction recovery and before Workspace, the Kernel scans every valid chat
for new-format turn records:

| Observation for one `turnId` | Startup action |
|---|---|
| One user record and one successful agent/system terminal record | Complete; no action. |
| One user record and a pending intended finalization/terminalization transaction | Recover that transaction first, then rescan. |
| One user record, no terminal record, and no intended transaction | Append exactly one `system:error` record with outcome `interrupted` and reason `process_restart_before_intent`. Do not rerun the agent. |
| One user record and a prepared but non-intended transaction | Discard the prepared transaction, then append the same typed interrupted record. |
| Agent/system terminal record without its user record | `chat_corrupt`; block mutating Workspace actions. |
| Duplicate user records, multiple terminal records, or the same `turnId` in multiple chats | `chat_corrupt`; never guess which record wins. |
| A related transaction is in recovery conflict | Show Recovery Conflict before orphan terminalization. |

Automatic agent continuation after restart is deliberately forbidden: process-tree
exit, vendor session state, and workspace ownership cannot all be proven. The user
may resend after Workspace opens; that creates a new `turnId` and workspace.

## 8. Git commits while an agent runs

The approved `/commit-page`, `/commit-infra`, and `/commit-all` behavior remains.
The following ordering is now mandatory:

1. Commit planning records expected `HEAD`, selected paths, states, and hashes.
2. On confirmation the Git adapter acquires the project-write mutex and revalidates
   the plan.
3. It holds the permit while Git runs, including hooks and signing, and while the
   mandatory post-attempt status inspection completes.
4. It then releases the permit. Hook modifications are not repaired, hidden, or
   staged by termcraft.
5. A waiting turn finalization acquires the permit and performs the full §7.5 CAS.

Consequences are deterministic:

| Interleaving | Result |
|---|---|
| Commit finishes first; no hook changes managed bytes | Commit records the pre-turn design; turn apply succeeds and becomes uncommitted. |
| Commit hook changes any turn canonical/manifest/chat/pin precondition | Turn fails `source_changed` or `stale`; it overwrites nothing. |
| Commit hook fails after changing a precondition | Git error is shown and status refreshed; later turn CAS still fails stale. |
| Turn finalization commits first | A previously confirmed Git plan is stale; commit requires a fresh preview and confirmation. |
| Unsupported external edit races after turn intent | Per-operation hash mismatch enters recovery conflict; termcraft never overwrites it. |

The agent run, retries, candidate copy, and Gate never hold the project-write mutex,
so a commit contends only with short admission/finalization and other project writes.

## 9. Durable Restore

Restore retains all approved Git semantics: it is unavailable during an agent turn;
it changes only one canonical source and the captured target chat; staged source
changes block it; unstaged changes require the existing warning; `HEAD`, branch,
index, other pages, pins, and other chats remain untouched.

### 9.1 Initial execution

1. Restore planning reads the full selected commit id into a temporary read-only
   snapshot and captures the current source hash, index state, full object/blob hash,
   and plan creation revision.
2. Still during planning and before confirmation, run the immutable selected blob
   through the current Gate and matching host. Store a Gate attestation bound to the
   exact blob hash in the immutable `restorePlanId` plan; Gate failure publishes no
   confirmable plan.
3. At confirmation the Kernel reuses that active plan, captures the current chat as
   `targetChatId`, and
   creates a unique `restoreActionId` bound to that chat, page, full source commit,
   and confirmed source hash.
4. Acquire the project-write mutex. Revalidate source hash, staged/index state, full
   commit readability, exact selected blob hash, plan revision, and the hash-bound
   Gate attestation without rerunning Gate.
   Validate the captured target chat and confirm it does not contain a conflicting
   `restoreActionId`.
5. Prepare a `RestoreTransaction` with two ordered operations:
   - replace canonical `page.tsx`, old confirmed image to the Gated commit blob,
     with `releaseAfterApplied: true`;
   - append one system record to `targetChatId`, uniquely identified by
     `restoreActionId` and containing `pageSlug` plus full `sourceCommit`. The record does
     not contain a redundant `targetChatId`; its file is its chat identity.
6. Recheck the initial Restore preconditions, write durable intent, apply source,
   durably mark it applied, append the record, and commit.
7. Release the permit and refresh source, host, captured chat, and Git status.

There is no source write before intent and no hidden backup. A failed planning Gate
produces no confirmable plan; a failed confirmation-time freshness/attestation check
writes neither source nor record.

### 9.2 `record-pending`, retry, and restart

If source replacement is verified and its applied marker is durable but the chat
operation cannot complete, the durable state is `record-pending`. The restored page
stays current. The UI may switch or create chats; `targetChatId` remains the
persisted destination.

Retry—manual in the same process or automatic at startup—acquires a new write
permit and resumes at the chat operation. It obeys these exact rules:

- it trusts the source's durable released applied marker and never rechecks the
  pre-Restore source hash;
- it never reads the Git object for application, runs Gate, or replaces source;
- it reads exactly `targetChatId`, finds `restoreActionId`, and accepts one matching
  record as complete;
- if absent after valid append-only chat growth, it persists an append rebase and
  appends exactly one record;
- a matching id with different page/commit fields, duplicates, or non-append chat
  rewrite is a recovery conflict;
- later page drift is irrelevant to the factual audit append and is not inspected.

Thus an ambiguous append acknowledgement, an active-chat switch from A to B, and a
process restart still produce exactly one Restore record in captured chat A and none
in B, without repeating Gate or source replacement.

## 10. Complete-generation export publication

Flat in-place replacement of `.termcraft/export/` cannot keep an old multi-file
package active while a new one is assembled. Export therefore uses immutable
generations and a one-file pointer:

```text
.termcraft/export/
  current.json
  generations/
    <generationId>/
      design-prompt.md
      runtime-api.json
      pages/*.tsx
      snapshots/<page>/<WxH>.txt
      layout/<page>.json
```

`current.json` contains schema version, `generationId`, and a SHA-256 manifest of
every file in that generation, including `runtime-api.json`. The active export package is the referenced
generation directory. The TUI and CLI display/return that resolved package path.
No symlink, junction, or reparse point is used.

Export follows this sequence:

1. Under a short project-write permit, snapshot the portable manifest and every
   listed canonical current source into an immutable export-source candidate,
   recording the full read-set digest. Release the permit.
2. With the old `current.json` untouched, render every page/size from that snapshot
   in fresh hosts and assemble the complete generation in transaction-local
   storage. Verify package schema, file inventory, per-file hashes, generation
   manifest, and the existing deterministic frame/layout requirements.
3. Acquire the project-write mutex and re-CAS the export source read set. If a
   commit hook or other write changed a source or manifest, fail `export_stale` and
   leave the old generation active. Discard transaction-local candidates and any
   prepared no-intent journal, report `failBeforeIntent`, and return the export
   domain to idle; this branch never enters recovery.
4. Prepare `ExportPublishTransaction`: create every file under the create-new
   portable generation path; replace `current.json` only after all new generation
   files; then delete files of the formerly referenced generation. Record exact
   old/new hashes for every file and pointer.
5. Write intent and roll forward. Until the pointer operation, the old complete
   generation is active. At pointer replacement, every new file already exists and
   has been verified. After the pointer, the new complete generation is active;
   old-generation deletion cannot make it incomplete.
6. Commit only after pointer verification and planned old-generation cleanup.
   Empty directories left by a crash are removed only after their planned files are
   absent and are not package state.

A crash before pointer replacement leaves the old generation active while recovery
finishes the new one. A crash after pointer replacement leaves the new generation
active while recovery finishes cleanup. An unexpected hash in any unresolved path
causes a recovery conflict and no overwrite. Capture or assembly failure occurs
before intent and leaves the old export byte-for-byte unchanged. Any publication
preparation or final-recheck failure before `intent.json` likewise discards the
prepared journal, reports `failBeforeIntent`, and returns to idle; export recovery is
entered only when valid durable intent exists.

This generational layout supersedes the flat export storage diagram. The package
contents and canonical-current-source rule are unchanged. `/commit-all` includes
`export/current.json` and the one remaining referenced generation after successful
cleanup; transaction-local candidates remain hard-excluded.

## 11. Verified-backup migration

Every bulk migration and every on-write persistent schema upgrade uses a
`MigrationTransaction`. Planning mints `migrationPlanId`; accepting that exact plan
mints `migrationActionId`, which same-process retry and startup recovery reuse. Git
presence does not waive backup.

1. Determine the exact migration rewrite set without writing it. Reject a too-new,
   unsafe, or oversized file. For bulk migration, the backup set is every portable
   project file plus `workspace.local.toml`, even when only a subset is rewritten;
   lease, journals, cache, diagnostics, and logs are excluded.
2. Acquire a short project-write permit, snapshot exact old images and the complete
   backup inventory, then release the permit before copying or transformation.
3. Through `BackupStore`, create
   `{userStateRoot}/backups/{projectId}/{migrationActionId}/` outside `.termcraft/` with
   create-new semantics. Copy every file in the required backup set as a regular, single-link file
   through `SafeProjectFs`; preserve relative paths and exact bytes, not symlinks or
   hardlinks.
4. Write `backup-manifest.json` containing original canonical project path,
   `projectId`, termcraft version, and for every copy its relative path, byte length,
   SHA-256, source format, and backup time. Flush the copies and manifest, reopen
   every copy, and verify its length/hash against both source and manifest. Only
   then durably write `VERIFIED` containing the manifest digest.
5. Produce and semantically validate every new-format payload outside the mutex.
6. Reacquire the project-write permit and re-CAS every source target against the
   snapshot. If any changed during backup/transformation, report `migration_stale`;
   the verified backup may remain for diagnosis, but no source changes. Discard the
   transformed candidate and any prepared no-intent journal, report
   `failBeforeIntent`, and return the migration domain to idle; this branch never
   enters recovery.
7. Prepare `MigrationTransaction` with `migrationPlanId`, `migrationActionId`, the
   verified manifest digest, and exact old/new images. Recheck `VERIFIED`, target
   hashes, and candidate decoders immediately before intent, then write intent and
   roll forward.
8. Commit, reopen every current-format file through its normal decoder, and release
   the permit. The external backup is retained under machine-local policy and can
   never enter a project Git scope; termcraft never relies on Git as its only
   recovery copy.

Any mismatch in the final step-7 recheck still occurs before intent: discard the
prepared journal, emit `failBeforeIntent`, and return to idle. Migration recovery is
entered only when a valid durable intent already exists.

An incomplete backup with no migration intent is safe to remove at startup because
source targets are untouched by protocol. A pending intended migration is recovered
from its payloads before normal project parsing. Historical Git objects remain
immutable and are never migrated.

## 12. Startup ordering

Startup performs this sequence before Workspace construction or design-host launch:

1. Acquire the existing single-process project lock.
2. Initialize the platform durability adapter and `SafeProjectFs`; validate
   `.termcraft` and `transactions.local` without following links.
3. Read journal format. Stop on too-new or corrupt journal state.
4. Acquire the project-write mutex and enumerate transaction ids in stable lexical
   order. For each: remove safe non-intended prepared state; recognize committed
   state; or recover intended state operation by operation. Release and reacquire
   only between transactions, never inside one transaction's apply.
5. If any transaction reaches conflict or non-retryable I/O pending, show a
   pre-Workspace Recovery screen. It names transaction kind/id, target, expected old
   and new hashes, and observed image. It offers **Retry recovery** after the user
   repairs external state; it offers no force overwrite and no intended-transaction
   abandon action.
6. Recover pending migrations before decoding current project schemas.
7. Validate all current schemas and run required lazy in-memory migration reads.
8. Scan chats for orphan/nonterminal turns and commit interruption records through
   `TurnTransaction`; recover those transactions immediately.
9. Validate the manifest, canonical pages, chats, pins, export pointer, and local
   state required to open.
10. Only then construct the Workspace and start the current design host.

Committed journal directories may be garbage-collected after step 9. Cleanup is
never required to establish domain completion and never deletes a journal still
referenced by an unresolved action.

## 13. Error handling

| Error | Meaning and behavior |
|---|---|
| `source_changed` | A turn canonical source, page inventory, or portable manifest changed since send. No finalization intent or overwrite; append `system:error` with outcome `stale` when safe. |
| `stale` | Captured chat, relevant pins, config, live turn fence, Restore confirmation, export snapshot, or migration source is stale. No domain intent; replan/retry as the flow specifies. |
| `transaction_recovery_conflict` | An intended unresolved target matches neither an accepted old nor new image. Block Workspace; never overwrite. |
| `transaction_io_pending` | Roll-forward hit an I/O error without conflicting data. Keep intent, block overlapping writes, and retry now or at startup. |
| `journal_corrupt` / `journal_too_new` | Journal safety or format cannot be established. Block Workspace and name the exact path. |
| `unsafe_path`, `unsafe_reparse`, `unsafe_hardlink`, `unsafe_file_type` | `SafeProjectFs` rejected the path or object. No intent/write to managed targets. |
| `workspace_changed_during_snapshot` | Workspace mutated while being copied after process exit. Mark backend unhealthy if exit ownership is suspect; do not Gate or apply. |
| `storage_limit_exceeded` | A configured hard limit was exceeded. Do not truncate or partially import. |
| `backend_unhealthy_unconfirmed_exit` | Complete process-tree exit could not be proven. Quarantine workspace and reject backend turns until health is re-established. |
| `restore_record_conflict` | Captured chat has duplicate/conflicting `restoreActionId` or non-append rewrite. Keep restored source; block record recovery rather than writing another record. |
| `export_stale` | Canonical sources/manifest changed during generation. Discard candidate and retain old active export. |
| `migration_backup_failed` | Backup could not be completely copied and verified. Source stays untouched; no migration intent. |
| `migration_stale` | A migration source changed between snapshot and intent. No source write; replan from current data. |
| `unsupported_durability` | Required flush/replace semantics cannot be verified on this volume. Mutating actions are unavailable. |

Errors after durable intent never get converted into ordinary turn failure while
the transaction is unresolved. Doing so would hide a partial action. Recovery or an
explicit conflict is the only next state.

## 14. Test strategy and matrix

### 14.1 Mandatory fault-injection harness

The durability adapter exposes a test-only crash injector after every physical
boundary:

- payload temporary-file flush;
- payload install and parent-directory flush;
- plan flush/install;
- commit-intent flush/install;
- target temporary-file flush;
- target replace/delete and parent-directory flush;
- target post-write verification;
- append rebase flush/install;
- operation applied-marker flush/install;
- committed-marker flush/install;
- export generation-file publication and pointer replacement;
- migration backup-file flush, backup-manifest flush, and `VERIFIED` marker.

For every wrapper and every boundary index, the test process is terminated without
cleanup, the project is reopened, and startup recovery runs. The assertion is never
merely “no exception”: the complete managed tree must equal the exact pre-intent old
state or the exact committed new state as allowed by that boundary; intended state
must roll forward; duplicate append identities must be absent; and no unexpected
file may be overwritten. Tests also inject ordinary I/O errors separately from
process death.

### 14.2 Transaction engine

- create, replace, delete, and multi-file plans across every crash boundary;
- old-image, new-image, and neither-image recovery branches;
- ambiguous target install before applied marker;
- corrupt plan, missing/wrong payload, corrupt marker, and too-new journal;
- valid append-only rebase preserving intervening records;
- duplicate identity, conflicting identity, malformed line, truncation, and prefix
  rewrite conflicts;
- released Restore source marker with later source drift;
- committed transaction followed by legitimate later target drift;
- FIFO mutex fairness, invalidated permit rejection, and stale async writer denial;
- startup order with several prepared, intended, committed, and conflicting
  transactions.

### 14.3 Turn and Git interleavings

- user record with stable `turnId` is durable before backend launch;
- crash after admission, during each attempt, after Gate, before intent, after each
  finalization operation, and after commit before UI refresh;
- exact `changedPages`, manifest/meta changes, requested active-page restart effect,
  agent record, and pin-status events in one finalization plan;
- empty diff produces `changedPages: []`, still one successful agent record, and no
  pin resolution;
- failed, cancelled, stale, and interrupted turns never resolve pins;
- all four attempts use one turn workspace; a later turn never uses that path;
- retries are refused until prior process-tree exit is confirmed;
- commit during run with no hook mutation lets final apply succeed;
- successful and failing hooks modifying canonical source, manifest, captured chat,
  and pin logs each produce the exact `source_changed`/`stale` result and no
  overwrite;
- apply-first makes an already confirmed Git plan stale;
- direct edit after intent creates recovery conflict rather than overwrite;
- orphan scan terminalizes once and rejects duplicate/cross-chat `turnId` data.

### 14.4 Backend and fencing

- cwd and only writable root equal the unique turn workspace on every attempt;
- a rebindable session resumes only after proving its new root;
- a fixed session is fresh-seeded for a new turn and may resume only same-workspace
  retry;
- seed bounds are exactly 32 complete records and 64 KiB total, dropping oldest
  whole records first with no per-record tail truncation;
- events from prior attempt, prior lease nonce, cancelled turn, and retired fence are
  dropped, including late final/session-id events;
- graceful cancellation, graceful tree termination, and hard kill branches on
  POSIX process groups and Windows Job Objects;
- unconfirmed exit marks backend unhealthy, quarantines workspace, and prevents
  candidate copy/retry.

### 14.5 `SafeProjectFs`

- `..`, absolute, drive-relative, UNC, device namespace, mixed separator, ADS,
  trailing-dot/space, reserved-device, overlong, and control-character paths;
- case-fold and Unicode-normalization collisions;
- symlink in every path component, junction, mount redirect, every reparse tag,
  hardlink, duplicate file identity, FIFO/socket/device, and special file;
- source identity/size/timestamp change during copy;
- each per-file, count, depth, and aggregate limit at boundary and one unit over;
- immutable candidate cannot coexist with a backend process and contains only the
  exact allowed workspace inventory;
- hostile workspace passes no bytes to Gate; semantically invalid safe workspace is
  rejected by Gate separately;
- all managed `.termcraft` adapters fail tests if they bypass `SafeProjectFs`.

### 14.6 Restore

- source and captured-chat operations recover after every durability boundary;
- source changed before intent fails freshness with no write;
- source applied/chat pending survives restart and never reruns Git read, Gate, or
  source replacement;
- ambiguous chat acknowledgement yields exactly one `restoreActionId` record;
- chat A captured, UI switches to B, records append to A, retry leaves one record in
  A and none in B;
- valid append-only growth in A rebases and preserves all records;
- later source drift after released applied marker does not block audit append;
- duplicate/conflicting id or rewritten chat causes conflict and no second record;
- `HEAD`, branch, index, other pages, pins, and other chats are unchanged.

### 14.7 Export

- render/assembly failure leaves old `current.json` and generation unchanged;
- source/manifest drift before intent yields `export_stale`;
- crash after every new-generation file, immediately before/after pointer, during
  old-generation cleanup, and before committed marker;
- at every observation, `current.json` references a complete hash-verified old or
  new generation, never a mixed package;
- export uses captured canonical current sources including uncommitted bytes and
  ignores historical preview;
- transaction-local generations and temporary files never enter Git scopes.

### 14.8 Migration

- migration under Git still creates a verified backup;
- backup copy/hash/manifest/completion failure leaves sources untouched;
- source drift during backup yields `migration_stale`;
- crash after every backup and migration durability boundary;
- pending migration recovers before current-schema parsing;
- backup bytes and inventory exactly reproduce every old migration target;
- too-new data and unsafe backup paths block without partial reads or writes.

All durability, path, process-tree, and export-pointer suites run on supported POSIX
and Windows filesystems in CI. Real Git integration tests include hooks that mutate
each managed precondition and hooks that fail after mutation.

## 15. Acceptance criteria

The design is implemented only when all of these are true:

- one common `ProjectTransaction` engine and the four named wrappers implement the
  prepare/intent/roll-forward/committed protocol;
- a crash at any injected durability boundary recovers before Workspace to a
  complete planned action or an explicit no-overwrite conflict;
- no documentation or UI claims that several filesystem targets change
  simultaneously;
- every new user turn has a stable `turnId` persisted before backend launch, and
  startup deterministically terminalizes orphan/nonterminal turns without rerunning
  an agent;
- successful finalization includes all changed canonical pages, portable manifest
  changes, committed active-page restart state plus delayed local switch, one agent
  record, and append-only pin-status events in one recoverable plan;
- a Git commit may run during agent work, but hook or external drift in canonical,
  manifest, captured-chat, or relevant-pin preconditions causes typed stale failure
  before intent and no finalization overwrite;
- Restore restart recovery retains `targetChatId` and `restoreActionId`, appends its
  audit record exactly once, and never repeats Gate or source replacement after the
  source applied marker;
- transaction journals and transaction temporary files are gitignored and
  hard-excluded; backups live outside `.termcraft/` and are denied from every
  termcraft commit scope;
- each turn has a create-new workspace under a stable per-project sandbox parent;
  only confirmed-exited retries share it, and session continuation obeys explicit
  workspace-rebinding capability;
- `{turnId, attempt, leaseNonce}` drops every late event and no unconfirmed process
  tree permits candidate copy, retry, or backend health;
- `SafeProjectFs` enforces path, collision, link/reparse, regular-file, and limit
  rules for both agent input and every managed `.termcraft` path;
- Gate consumes only a post-exit immutable candidate and remains independently
  responsible for design semantics;
- all-pages staging remains the implementation;
- export's current pointer always names a complete immutable generation while
  failed or incomplete generation leaves the old one active;
- every migration has a complete verified backup before intent, including projects
  under Git;
- fault injection covers every listed physical durability boundary on POSIX and
  Windows.

## 16. Out of scope

- multi-process writers, daemon clients, remote/distributed transactions, and
  recovery coordination across machines;
- support for concurrent manual edits while termcraft runs beyond detecting stale
  preconditions or recovery conflicts;
- automatic rollback after durable intent, force-overwrite recovery, or abandoning
  an intended transaction;
- a claim of simultaneous multi-file filesystem atomicity or isolation from
  out-of-process readers during fixed-file roll-forward;
- resuming an in-flight agent process after termcraft restart;
- reusing a workspace across different turns;
- partial/on-demand page staging before benchmark evidence and a separate approved
  design;
- cross-device target replacement or durability on filesystems whose flush behavior
  cannot be verified;
- suppressing, sandboxing, or undoing user Git hooks, signing, or hook side effects;
- changing Git history semantics, creating automatic commits, correlating turns to
  commits, or expanding commit scopes outside `.termcraft`;
- restoring pins, manifest, chats, or any file other than the selected canonical
  page source as part of Git Restore;
- OS-grade containment of a malicious agent or trusted design process beyond the
  existing backend confinement, process isolation, and workspace-trust model.
