# termcraft — Production Hardening Decision Register

Date: 2026-07-16
Status: approved design

## 1. Purpose

Strengthen termcraft from a local MVP architecture into a production-grade local
application without adding daemon or multi-client scope. This register records the
cross-cutting decisions, their precedence, and the detailed designs that own them.

The product remains single-user and single-instance. Production-grade means that a
crash, cancellation, stale asynchronous event, corrupt local record, slow consumer,
or large project has a bounded and recoverable outcome. It does not mean distributed
coordination.

## 2. Governing baseline

The following decisions remain unchanged:

- every page has one canonical `.termcraft/pages/<slug>/page.tsx`;
- the immutable page slug is its page and Git-history identity;
- Git is optional;
- v1 history is a path-limited first-parent view from the current `HEAD`;
- Git commits are explicit and user-confirmed through `/commit-page`,
  `/commit-infra`, and `/commit-all`;
- termcraft never correlates a Git commit with a chat turn or prompt;
- termcraft never creates or switches branches, tags, stashes, refs, or worktrees;
- one turn runs at a time, but scoped commit commands may remain available while
  the agent is running; actual commit and final apply serialize through the
  project-write mutex;
- all stateful and orchestration logic is Reatom v1001-first;
- daemon mode and multiple clients remain out of scope.

This register continues and narrows these existing specifications:

- `2026-07-13-termcraft-design.md`;
- `2026-07-16-git-backed-page-history-design.md`.

Where a detailed production-hardening design conflicts with older wording, the
production-hardening design governs. It does not reopen the Git-history decisions
listed above.

## 3. Accepted decisions

### 3.1 Recoverable project mutations

Per-file temporary-write-plus-rename is not a cross-file transaction. Project
mutations use a common recoverable transaction engine with domain wrappers for turn
apply, Restore finalization, export publication, and migration.

A transaction prepares complete payloads and old/new hashes, persists a durable
commit intent, then applies operations idempotently by roll-forward. Before commit
intent, it may be discarded. After commit intent, cancellation and rollback are not
allowed. Startup completes or reports recovery conflicts before opening the
Workspace.

Restore preserves its captured `targetChatId` and `restoreActionId` exactly-once
record semantics, but its pending plan becomes durable across restart.

### 3.2 Commit-during-turn concurrency

The three scoped commit commands remain available during an agent turn as currently
specified. Git hooks may modify `.termcraft/`. Therefore final apply revalidates its
complete source, portable manifest, chat, and comments CAS read set under
the project-write mutex before
writing commit intent. Unexpected drift produces a typed stale/source-changed result
and never overwrites the changed file.

### 3.3 Per-turn staging and fencing

Only the project sandbox parent is stable. Every turn receives a unique workspace;
no later turn clears or reuses that writable directory. The backend receives the
turn workspace as its cwd and only writable root. Native vendor-session resume is
used only when the backend can bind the resumed run to the new workspace; otherwise
the backend starts a fresh session seeded from the persisted chat.

Every run is fenced by `turnId`, attempt, and a random lease nonce. Cancellation
does not complete until process-tree exit is confirmed. The Gate validates an
agent-inaccessible immutable candidate snapshot, never the writable agent workspace.

### 3.4 Filesystem safety

`SafeProjectFs` validates both agent workspace intake and every managed
`.termcraft` read/write path. Managed paths cannot contain traversal, ambiguous
Windows paths, symlinks, junctions, reparse points, or hardlinks. File kind, path,
count, depth, and byte limits are enforced while bytes are copied into the immutable
candidate, closing the check/read race. Source semantics remain the Gate's job.

### 3.5 Kernel authority

The Kernel validates every domain command through explicit named Reatom state
machines. It publishes state revisions and capabilities with typed unavailable
reasons. The UI action table remains the registry of triggers, labels, and hints;
its enabled state combines Kernel capability with local screen, focus, and modal
applicability.

Commands and events are serializable, versioned DTOs with command correlation,
state revision, and event sequence. This is transport-neutral design, not a claim
that the in-process channel is already a daemon wire protocol.

### 3.6 Host ownership and flow control

`HostSupervisor` is the only owner of the design-host process and protocol.
The UI uses a typed `PreviewSession`; it never owns subprocess handles or stdio.
Lifecycle and control use the Kernel channel while frames use a separate bounded
data stream.

The first protocol uses versioned length-prefixed messages, request identifiers,
frame sequence numbers, negotiated limits, deadlines, full-frame latest-wins
coalescing, restart budgets, backoff, and a circuit breaker. Frame deltas are
deferred until benchmarks prove they are needed.

### 3.7 Portable and local state

Portable project state and local workspace preferences are separate. Active page,
active chat, documented preview/fullscreen state, backend, model, effort, vendor sessions,
caches, diagnostics, transaction journals, and operations logs are machine-local
and excluded from every Git commit scope.

Non-page identities use UUIDv7. Page identity remains the slug. Vendor-session
resume additionally requires an opaque backend session scope and an exact chat
history checkpoint.

Page title, minimum size, theme, and compatibility version live only in `page.tsx`.
Any metadata cache is a rebuildable local projection keyed by source hash and
extractor version.

### 3.8 Runtime API and Reatom

Saved page sources import only `@termcraft/runtime`. Direct imports from
`@termcraft/kit`, `@reatom/*`, React, React JSX runtime, and `@opentui/*` are
forbidden. The facade exposes the supported design components, types, selected
Reatom v1001 primitives, `reatomComponent`, navigation, tweaks, and runtime
capabilities.

Page state and behavior live in named Reatom atoms, computeds, and actions. React
hooks are minimal and primarily retrieve scoped models from context. Critical
process and transaction lifetimes remain owned by supervisors and transaction
services rather than hidden reactive connection hooks.

Every page declares a static integer `kitApiVersion`. The Gate, host handshake,
historical browsing, Restore, export, and codemods use it explicitly.

### 3.9 Records, trust, locking, and migration

Every JSONL record has a UUIDv7 record id and a bounded line size. Readers stream a
valid prefix. A transaction-proven partial final append is repaired automatically;
unproven trailing corruption is preserved for explicit recovery, and corruption in
the middle is a hard error. Pin lifecycle changes are append events.

Workspace trust uses canonical path, filesystem identity, portable project id, and
Git repository identity when available. It is not bound to `HEAD`. Project
single-writer ownership uses an OS-held lease; a lock is never declared stale from a
PID alone.

Migration always creates and verifies a machine-local backup outside `.termcraft`
before rewriting old bytes, regardless of Git status.

### 3.10 Projections, observability, and scale

Current diagnostics are keyed by page slug, source hash, and kit API version rather
than by active chat. Chat records may retain historical warnings, but they are not
the current diagnostic source.

There is no private VersionIndex and no Git-commit-to-prompt projection. `GitHistory`
owns page history; a rebuildable `ChatIndex` owns JSONL byte offsets, record/turn
lookup, and pagination.

Chat loading, Git history, export work, host frames, logs, and caches are bounded.
An absolute turn deadline cannot be reset by event noise. All-pages staging remains
the initial behavior until the agreed synthetic benchmark proves that on-demand
materialization is necessary.

## 4. Explicitly rejected or deferred

- page UUIDs;
- commit-to-chat or commit-to-prompt correlation;
- daemon authentication, reconnect, multi-client subscriptions, and distributed
  locking;
- direct agent writes to canonical `.termcraft/pages` sources;
- a reused writable staging directory;
- SQLite as a substitute for cross-file transaction design;
- direct page imports from renderer or state-management dependencies;
- portable cached page metadata;
- frame deltas before benchmark evidence;
- on-demand staging before benchmark evidence;
- automatic backup omission because files appear to be under Git.

## 5. Detailed designs

The following documents own implementation-level contracts:

1. `2026-07-16-production-storage-identity-design.md`;
2. `2026-07-16-runtime-api-compatibility-design.md`;
3. `2026-07-16-turn-durability-staging-design.md`;
4. `2026-07-16-kernel-command-contract-design.md`;
5. `2026-07-16-host-supervision-protocol-design.md`;
6. `2026-07-16-projections-observability-scale-design.md`.

Storage and runtime contracts are planned first because they define the files and
page API that transactions, the Gate, the host, and Git commit scopes consume.
Durability, Kernel, and host designs then establish the four load-bearing production
boundaries. Projections and scale follow without changing their correctness
contracts.

## 6. Documentation integration rules

- The Git-backed continuation remains authoritative for current-design rows,
  first-parent history, commit scopes, and explicit Git behavior.
- `/commit-page`, `/commit-infra`, and `/commit-all` remain the only commit triggers.
- If local-state separation removes a file from portable infrastructure, the
  continuation's scope list must be updated rather than silently retaining it.
- Restore transaction wording must preserve captured-target-chat and action-id
  semantics while replacing in-memory-only recovery.
- Architecture documents must describe one owner per process, file, command guard,
  and projection.
- Every active guarantee must have a corresponding failure path and test category.
- Legacy superseded prose may remain only when it is clearly marked and cannot be
  mistaken for the governing contract.

## 7. Program acceptance criteria

- No active specification describes numbered private page versions.
- No active specification calls a sequence of per-file renames cross-file atomic.
- A crash after commit intent has one deterministic startup outcome.
- A canceled or stale backend cannot write into or apply a later turn.
- Git hook side effects cannot be overwritten by a stale final apply.
- UI availability and Kernel legality cannot diverge silently.
- The UI has no direct design-host process ownership.
- Saved page sources depend only on the versioned termcraft runtime facade.
- Portable Git scopes exclude every local journal, cache, session, preference, log,
  lock, and backup.
- Current diagnostics are independent of active chat.
- Large-history paths are lazy or paginated and all queues/process pools are bounded.
- Cross-document architecture audits report no unresolved contradiction in ownership,
  identity, recovery, Git concurrency, runtime compatibility, or feature scope.
