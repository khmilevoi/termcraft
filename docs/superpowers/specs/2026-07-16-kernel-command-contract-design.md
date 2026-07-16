# termcraft — Kernel Command Contract Design

Date: 2026-07-16
Status: approved design
Parent decision register: [`2026-07-16-production-hardening-decisions-design.md`](2026-07-16-production-hardening-decisions-design.md)

## 1. Purpose

Make the Kernel authoritative for every domain transition while preserving the UI's
single registry of user-facing actions. This design defines the Kernel's Reatom
state machines, command and event DTOs, command deduplication, optimistic revision
guard, capabilities, asynchronous fencing, and the exact concurrency relationship
between agent turns, Restore, scoped Git commits, export, preview, and pin updates.

The contract is transport-neutral and serializable. The first implementation still
uses an in-process channel. This document does not claim that channel is ready IPC:
daemon authentication, reconnect, event replay, multi-client subscriptions,
distributed coordination, compatibility negotiation, and transport backpressure
remain unsolved and out of scope.

## 2. Governing decisions

The following rules are load-bearing:

1. The Kernel validates and performs every domain transition. A command sent
   directly to the Kernel cannot bypass a lock merely because it skipped the UI
   action table.
2. The UI action table remains the registry of action ids, labels, triggers,
   descriptions, status hints, and command builders. It no longer owns domain
   legality or turn-time locks.
3. Kernel legality is expressed by explicit named Reatom v1001 state-machine models
   and named transition actions. The legal source states, targets, and rejection
   codes are table-driven and testable.
4. The Kernel publishes typed capabilities derived from the same guards used at
   command dispatch. The UI combines a Kernel capability with local screen, focus,
   composer, and modal applicability.
5. `stateRevision` identifies authoritative Kernel state. `eventSeq` orders control
   events. They are separate counters with different meanings.
6. Every command carries `protocolVersion`, a UUIDv7 `commandId`,
   `expectedRevision`, `kind`, and typed `payload`. Every command produces a typed
   `Accepted` or `Rejected` result.
7. Duplicate `commandId` values never execute a command twice within the defined
   deduplication window. Durable operations additionally use their own transaction,
   plan, turn, or action identities.
8. A stale revision rejects every command except the narrowly permissive,
   identity-bound cancel path described in §8.4.
9. Backend events are accepted only when `turnId`, `attempt`, and `leaseNonce` match
   the active turn lease. Late events cannot mutate a later attempt or turn.
10. Reatom models own observable state and legal transition functions. They do not
    own host processes, agent process trees, transaction journals, Git child
    processes, or the project-write mutex.
11. Refusing workspace trust finishes open into `ready` with
    `trust: "untrusted-read-only"`; it never closes the project. That state may
    expose already-loaded read-only data but cannot execute page code or mutate
    project or machine-local workspace state.
12. `CommandKindV1`, `EventKindV1`, `EventPayloadByKindV1`, and `CapabilityId`
    are closed protocol-v1 unions. `CapabilityId` is exactly `CommandKindV1`;
    UI-local actions have `capability: null` and cannot invent Kernel capability
    ids.

## 3. Alternatives considered

### 3.1 UI-owned availability

Keep `available(state)` in the UI action table as the only turn-time lock. This is
rejected because tests, future non-UI callers, CLI entry points, accidental direct
dispatch, and eventual IPC clients could issue a command without passing through the
table. A presentation registry cannot be a correctness boundary.

### 3.2 Shared Kernel/UI Reatom graph

Let UI components import Kernel atoms and call transition actions directly. This is
rejected because it erases the command boundary, makes resource ownership implicit,
and prevents the DTO contract from being exercised in-process before any daemon
exists.

### 3.3 Kernel state machines plus projected capabilities

The selected design keeps separate Reatom graphs on each side. The UI mirrors a
Kernel snapshot and events, consults Kernel capabilities, applies local view
applicability, and sends DTO commands. The Kernel serializes commands through one
mailbox, checks the current revision and authoritative guard, calls named state
machine actions, and emits ordered events. This preserves the current UI model while
making direct command handling safe.

## 4. Terms and counter semantics

| Term | Meaning |
|---|---|
| **Domain transition** | A change to project, turn, chat, model, Restore, commit, export, preview source/mode, selection, or persisted pin state. It must be accepted by the Kernel. |
| **Local applicability** | Whether an action makes sense in the current UI screen, focus owner, composer mode, or modal layer. It may be decided entirely by the UI and cannot make an illegal Kernel command legal. |
| **Kernel capability** | The Kernel's typed statement that a domain intent is currently legal or unavailable for one or more typed reasons. |
| **State revision** | A process-local unsigned 64-bit counter incremented once for each atomic authoritative Kernel state transition. Rejections, duplicate replays, backend progress text, and host frames do not increment it. |
| **Event sequence** | A process-local unsigned 64-bit counter incremented for every emitted control event, including progress and diagnostics that do not change state. Several events may therefore carry the same `stateRevision`. |
| **Frame sequence** | An incarnation-local counter on the separate bounded frame stream. It resets when the host `nonce` changes and is meaningful only inside the complete `(previewSessionId, nonce, sourceHash, frameSeq)` frame identity. It is unrelated to `eventSeq`. |
| **Frame token** | A Kernel-issued token accompanying one frame-stream item. It becomes query-authorizing only after the `PreviewSession` broker receives the UI's display acknowledgement for that token, and it binds exactly one incarnation-local frame identity. It cannot create a pin. |
| **Geometry token** | A bounded, short-lived Kernel-issued attestation over one displayed frame identity plus page slug, element id, and fractional coordinates. It is required for durable pin creation and is never reconstructed from UI-provided geometry. |
| **ProjectWritePermit** | A short lease from `ProjectWriteCoordinator` over the same single-writer exclusion primitive as the project-write mutex. Export uses it only to capture one coherent source/settings snapshot, releases it before rendering, and reacquires the full transaction boundary for publication. |
| **Command acceptance** | The Kernel accepted the intent and performed its immediate state transition. It does not mean a long-running operation later succeeded. |
| **Operational completion** | A terminal event for an accepted asynchronous command, correlated by `commandId` and its operation identity. |

Unsigned 64-bit values are encoded in DTOs as canonical decimal strings. Internally
they may be `bigint`; `bigint` never crosses a DTO boundary. A Kernel process also
has a UUIDv7 `kernelInstanceId` so logs and tests cannot accidentally compare
counters from different process lifetimes. Reconnect semantics are not inferred from
this id.

## 5. Components and ownership

| Component | Responsibility and ownership |
|---|---|
| **UI action registry** | Owns action ids, labels, descriptions, hotkeys/slash triggers, hint rendering, local applicability, and construction of a command from current mirrored data. It does not own domain guards. |
| **Kernel command mailbox** | The single serialized entry for external commands and internal service signals. It owns parse/version checks, deduplication, revision checks, guard evaluation, model action dispatch, result recording, and control-event publication. |
| **Kernel Reatom context** | Owns the named project, turn, Restore, commit, export, preview, and migration models; authoritative projections; the capability computed; and the `stateRevision` atom. UI code never imports these units. |
| **Capability projector** | Calls the exact guard functions used by dispatch and emits typed capability entries whenever their inputs change. It has no second copy of lock logic. |
| **AgentRunSupervisor** | Owns the backend run, process tree, turn workspace, attempt lease, deadline, cancellation, and confirmed process exit. It sends fenced internal signals to the mailbox. |
| **HostSupervisor** | The only owner of design-host subprocesses and their protocol. It exposes typed `PreviewSession` control plus a separate bounded frame stream. The UI never receives a process handle or stdio stream. |
| **ProjectTransactionService** | Owns every `ProjectTransaction` kind and every Turn admission/finalization/terminalization phase: durable plans, commit intent, idempotent roll-forward, and recovery. Reatom's in-memory rollback helpers are not a filesystem transaction substitute. |
| **ProjectWriteCoordinator** | Owns the project-write mutex and short `ProjectWritePermit` leases. Every transaction prepare/final-CAS/intent/apply/recovery sequence and the complete scoped Git attempt including hooks/signing/status refresh acquires the mutex. Export preparation holds a permit only while reading one coherent page-order/source/settings snapshot; rendering, agent streaming, Gate work, backup copying, and migration transformation hold neither. Export publication reacquires the mutex for final CAS, intent, and apply. |
| **ProcessService** | Starts bounded Git/Gate/helper processes and owns their handles, deadlines, output limits, and teardown. Commit and model actions observe results but do not own child processes. |
| **Project store and Git adapter** | Remain the only implementations of managed project storage and installed-Git operations. The UI never invokes either directly. |

`withConnectHook` is valid for a connection-scoped channel subscription or a
UI-facing observable bridge when the hook returns cleanup. It must not start or hide
the lifetime of a host process, agent run, transaction recovery loop, mutex lease, or
Git child process. Those resources start from explicit service calls made by named
Kernel actions and end by explicit service completion/cancellation. A Reatom
subscriber disconnect cannot abandon a critical operation.

## 6. Reatom v1001 model rules

The implementation uses `@reatom/core@1001`. At design time this repository has no
`package.json`, installed `@reatom/core`, or `node_modules`, so the installed types
cannot yet be verified. Implementation must pin v1001 and check the package's own
`.d.ts` before code is accepted. The binding rules and the vendored v1001 handbook
govern the design:

- model factories use the `reatom*` prefix;
- every atom, computed, and action has a stable hierarchical trace name;
- mutations/commands use named `action(...).extend(withAsync(...))` where they cross
  an async boundary;
- promises or external callbacks that re-enter Reatom use `wrap` at the boundary;
- grouped transitions are named model actions, never a sequence of atom writes in a
  UI handler;
- direct `.set(...)` is used for a genuinely simple local atom update; identity
  actions are forbidden;
- machine phases are domain state, not hand-maintained generic loading/error atoms;
- isolated tests use `context.start`, and shared-context tests reset context;
- `withConnectHook` is limited as described in §5.

The seven factories and their trace roots are fixed:

| Factory | State atom | Capability/derived root |
|---|---|---|
| `reatomProjectStateMachine` | `kernel.project.state` | `kernel.project.*` |
| `reatomTurnStateMachine` | `kernel.turn.state` | `kernel.turn.*` |
| `reatomRestoreStateMachine` | `kernel.restore.state` | `kernel.restore.*` |
| `reatomCommitStateMachine` | `kernel.commit.state` | `kernel.commit.*` |
| `reatomExportStateMachine` | `kernel.export.state` | `kernel.export.*` |
| `reatomPreviewStateMachine` | `kernel.preview.state` | `kernel.preview.*` |
| `reatomMigrationStateMachine` | `kernel.migration.state` | `kernel.migration.*` |

The mailbox invokes transition actions synchronously within one Reatom transaction
frame, then increments `kernel.stateRevision` exactly once if the transition changed
authoritative state. Async work starts only after the start transition is committed.
Service callbacks return to the same mailbox through `wrap`; they never set model
atoms directly.

Any source/action pair not listed in the following tables is illegal and returns the
table's domain rejection code without changing state.

## 7. Explicit state machines

### 7.1 Project model

`ProjectState` is `closed | opening | recovering | ready | blocked | closing`.
`ready` includes the portable project identity, canonical root, trust state
`"trusted" | "untrusted-read-only"`, storage health, active page/chat identities,
current Git/status projections, and at most one immutable `PageRemovePlanV1`.
Machine-local preferences remain local-state projections as governed by the
production-hardening register.

| Source | Named action | Target | Rule |
|---|---|---|---|
| `closed` | `kernel.project.beginCreate` or `kernel.project.beginOpen` | `opening` | Captures the canonical project root; a second open is illegal. |
| `opening` | `kernel.project.beginRecovery` | `recovering` | Routes exactly one schema-valid intended Restore, ExportPublish, or Migration journal into its domain's `idle -> recovering` transition before Workspace. |
| `opening`, `recovering` | `kernel.project.finishOpen` | `ready` | Requires a validated project snapshot and completed mandatory recovery. An explicit trust refusal enters `ready` with `trust: "untrusted-read-only"`; it does not enter `closed`. |
| `opening`, `recovering` | `kernel.project.blockOpen` | `blocked` | Carries a typed corrupt/newer-format/recovery-conflict reason. |
| `opening` | `kernel.project.setTrust` | `opening` | Records the validated trust decision before any new migration codemod, Gate, host, or export execution. Refusal is a valid decision and does not trigger close. |
| `ready` | `kernel.project.setTrust` | `ready` | Changes trusted execution capability; it is not an identity setter because it validates workspace identity and recomputes dependent capabilities. |
| `ready` | `kernel.project.renamePageTitle`, `kernel.project.reorderPages` | `ready` | Guarded ordinary `project-mutation` transactions. Either invalidates an active page-removal plan whose source/order binding changed. |
| `ready` | `kernel.project.beginPageRemovePlan` | `ready` | Requires trusted writable state, no active turn, and a listed page. Mints one UUIDv7 `pageRemovePlanId` and stores the immutable plan below without writing project files. |
| `ready` | `kernel.project.confirmPageRemove` | `ready` | Accepts only the active `pageRemovePlanId`; under the project-write mutex it revalidates the exact source hash, page-order hash, active-page identity, and fallback before one `project-mutation` transaction deletes the source, removes the slug, and updates the local fallback. |
| `ready` | `kernel.project.discardPageRemovePlan` | `ready` | Clears only the matching active plan and performs no project write. |
| `ready`, `blocked` | `kernel.project.beginClose` | `closing` | Refuses while a post-intent transaction still requires roll-forward. |
| `closing` | `kernel.project.finishClose` | `closed` | Requires supervisors and channel subscriptions to be explicitly stopped. |
| `blocked` | `kernel.project.retryOpen` | `opening` | Starts a fresh read/recovery attempt. |

`PageRemovePlanV1` contains exactly `pageRemovePlanId`, `pageSlug`, the current
canonical `sourceHash`, the exact ordered slug list and its canonical
`pageOrderHash`, the current active-page slug, the planned fallback slug or `null`,
and `planRevision`. A source write, page-order change, active-page change, project
recovery, or trust change invalidates the plan. `page.removeConfirm` never accepts
an acknowledgement boolean or page identity from the UI; confirmation is possession
of the still-current plan id at the current revision.

All project-scoped commands except open/create/retry/close/trust and a trusted
pre-Workspace migration plan/confirmation reject with `PROJECT_NOT_READY` unless
the model is `ready`. In `untrusted-read-only` state, the only Kernel commands that
remain available are `project.setTrust`, `project.close`, and read-only
`history.open`; UI-local focus, menus, and already-loaded chat/history presentation
remain local. Every command that executes page code or writes project/local state
rejects with `PROJECT_UNTRUSTED`.

### 7.2 Turn model

`TurnState` is `idle | admitting | workspace-ready | running | stopping |
snapshotting | validating | finalizing | committed | terminalizing | terminal |
backend-unhealthy`. `terminal` carries `failed | cancelled | stale | interrupted`.
These map onto persisted chat records as follows: `failed` persists as a
`system:error` record with typed outcome `error`; `cancelled` persists as
`system:cancelled`; `stale` and `interrupted` persist as `system:error` records
with the same-named outcomes.
A turn carries UUIDv7 `turnId`, captured `targetChatId`, captured input context, the
complete send-time read set, sent pin ids, a 30-minute default absolute deadline,
and one random `leaseNonce` for the live backend attempt. Attempts are integers 1
through 4; every retry increments `attempt` and replaces `leaseNonce` before the
next process starts.

| Source | Named action | Target | Rule |
|---|---|---|---|
| `idle` | `kernel.turn.beginAdmission` | `admitting` | Mints `turnId`; captures target chat, valid selection, and resolvable open pins. The first per-attempt lease nonce is minted only when attempt 1 starts. |
| `admitting` | `kernel.turn.finishAdmission` | `workspace-ready` | Requires committed user-record admission plus a verified unique per-turn workspace and complete read-set hashes. |
| `workspace-ready` | `kernel.turn.beginAttempt` | `running` | Starts attempt 1 or the next Gate retry with a fresh per-attempt lease nonce. |
| `running` | `kernel.turn.beginStopping` | `stopping` | Closes the event stream and begins normal, error, or cancellation process-tree shutdown. |
| `stopping` | `kernel.turn.beginSnapshot` | `snapshotting` | Legal only for normal completion after confirmed process-tree exit and retired attempt fence. |
| `stopping` | `kernel.turn.beginTerminalization` | `terminalizing` | Used for confirmed cancellation or backend failure; no candidate is copied. |
| `stopping` | `kernel.turn.markBackendUnhealthy` | `backend-unhealthy` | Process-tree exit could not be confirmed; workspace is quarantined and no new turn may start. |
| `snapshotting` | `kernel.turn.candidateCaptured` | `validating` | Candidate is immutable and inaccessible to the agent. |
| `validating` | `kernel.turn.retryAfterGate` | `workspace-ready` | Legal only while `attempt < 4`; the same `turnId` and workspace are retained, while the next attempt receives a fresh lease nonce. |
| `validating` | `kernel.turn.beginFinalization` | `finalizing` | Records the exact candidate and begins mutex-protected read-set CAS and TurnTransaction preparation. |
| `validating` | `kernel.turn.beginTerminalization` | `terminalizing` | Gate retry budget exhausted. |
| `finalizing` | `kernel.turn.markCommitted` | `committed` | Legal only after durable committed marker; after intent, cancellation is forbidden and recovery rolls forward. |
| `finalizing` | `kernel.turn.beginTerminalization` | `terminalizing` | Legal only before intent for stale/source-changed validation; no design or pin payload is applied. |
| `committed` | `kernel.turn.settle` | `idle` | Emits changed pages, chat result, pin changes, and resulting hashes. |
| `terminalizing` | `kernel.turn.finishTerminalization` | `terminal` | Requires exactly one terminal chat record or a typed unrecorded recovery condition. |
| `terminal` | `kernel.turn.settle` | `idle` | Publishes the typed failed/cancelled/stale/interrupted outcome. |
| `backend-unhealthy` | `kernel.turn.confirmBackendHealthy` | `idle` | Requires a full health check proving the process tree absent and confinement operational. |

`kernel.turn.requestCancel` is legal from any active pre-intent phase. It moves a
running attempt to `stopping`; phases with no process move to `terminalizing` after
their current bounded service call acknowledges cancellation. A repeated request for
the same turn while stopping/terminalizing is an accepted no-op. In `finalizing`
after durable intent it is rejected with `CANCEL_TOO_LATE`; roll-forward must finish.
`turn.start` is rejected with `TURN_ALREADY_ACTIVE` in every non-idle state.

### 7.3 Restore model

`RestoreState` is `idle | planning | awaiting-confirmation | executing |
record-pending | recovering | blocked`. A plan is immutable and contains a UUIDv7
`restorePlanId`, page slug, full source commit id, pre-Restore source hash, index
state, immutable source/blob hash, a full current-Gate attestation bound to the exact
source bytes, runtime declaration bundle, and Gate policy version, and plan creation
revision.

| Source | Named action | Target | Rule |
|---|---|---|---|
| `idle` | `kernel.restore.beginPlan` | `planning` | Requires a selected historical commit, no active turn, and readable Git state. Planning reads the immutable blob and performs the full current Gate plus matching-host attestation before any confirmation is shown. |
| `planning` | `kernel.restore.planReady` | `awaiting-confirmation` | Requires a successful hash-bound Gate/host attestation and publishes it with exact overwrite and staged/unstaged facts. A staged source or failed Gate returns `planFailed` instead. |
| `planning` | `kernel.restore.planFailed` | `idle` | No project write. |
| `awaiting-confirmation` | `kernel.restore.confirm` | `executing` | The Kernel captures the currently active chat as `targetChatId` and mints one UUIDv7 `restoreActionId`; neither value is accepted from the UI. |
| `awaiting-confirmation` | `kernel.restore.discardPlan` | `idle` | Discards the immutable plan. |
| `executing` | `kernel.restore.markRecordPending` | `record-pending` | Canonical source replacement is durable but the captured target-chat record still needs exactly-once completion. |
| `executing`, `record-pending`, `recovering` | `kernel.restore.complete` | `idle` | The captured target chat contains exactly one record for `restoreActionId`. |
| `executing` | `kernel.restore.failBeforeIntent` | `idle` | Under-mutex source/index/object/attestation-binding revalidation failed before commit intent; no write occurred. Confirm never reruns Gate. |
| `executing` | `kernel.restore.beginRecovery` | `recovering` | Post-intent interruption must roll forward from the durable transaction journal. |
| `idle` | `kernel.restore.beginRecovery` | `recovering` | Startup found a schema-valid Restore journal with durable commit intent; recovery adopts exactly that journal without replanning or rerunning Gate. |
| `record-pending` | `kernel.restore.retryRecord` | `recovering` | Checks only `targetChatId` for `restoreActionId`; it never repeats Gate or source replacement. |
| `recovering` | `kernel.restore.blockRecovery` | `blocked` | A durable recovery conflict blocks normal project writes until explicitly repaired. |
| `blocked` | `kernel.restore.retryRecovery` | `recovering` | Rechecks the same durable journal after external repair; it never abandons intent or forces an overwrite. |

The transaction journal durably binds `restoreActionId`, `targetChatId`, page slug,
full source commit id, source payload hash, and target record payload before commit
intent. A chat switch after confirmation cannot retarget the record. Duplicate
confirmation commands return the original accepted result and action id. A new
Restore always requires a new plan and action id.

### 7.4 Commit model

`CommitState` is `idle | planning | awaiting-confirmation | executing | refreshing`.
Only one termcraft commit plan or execution is active, but it is intentionally
independent from `TurnState`.

| Source | Named action | Target | Rule |
|---|---|---|---|
| `idle` | `kernel.commit.beginPlan` | `planning` | Scope is current page, portable infrastructure, or all eligible `.termcraft` paths; clean scopes fail without a plan. |
| `planning` | `kernel.commit.planReady` | `awaiting-confirmation` | Publishes UUIDv7 `commitPlanId`, expected `HEAD`, exact added/modified/deleted paths, states, content hashes, message template, and detached-HEAD warning if needed. |
| `planning` | `kernel.commit.planFailed` | `idle` | Carries Git unavailable, sequencer, clean-scope, timeout, or bounded-output error. |
| `awaiting-confirmation` | `kernel.commit.confirm` | `executing` | Accepts only `commitPlanId`, edited message, and required warning acknowledgement; selected paths cannot come from the UI. |
| `awaiting-confirmation` | `kernel.commit.discardPlan` | `idle` | Invalidates the plan. |
| `executing` | `kernel.commit.beginRefresh` | `refreshing` | Runs after success or failure because hooks/signing may have changed files. |
| `refreshing` | `kernel.commit.finishRefresh` | `idle` | Publishes new Git scope capabilities and terminal result. |

Immediately before Git execution, while holding the project-write mutex, the commit
service revalidates expected `HEAD`, path set, path states, and content hashes. Any
change yields `COMMIT_PLAN_STALE`, releases the mutex without invoking commit, and
requires a new plan and confirmation. `expectedRevision` catches known Kernel state
drift; plan revalidation independently catches external file/Git drift.

### 7.5 Export model

`ExportState` is `idle | preparing | rendering | publishing | recovering | blocked`.

| Source | Named action | Target | Rule |
|---|---|---|---|
| `idle` | `kernel.export.begin` | `preparing` | Requires trusted project, at least one page, no active turn, and no other export. Historical browsing is allowed because export always snapshots canonical Current design. |
| `preparing` | `kernel.export.beginRendering` | `rendering` | Requires the completed immutable canonical source/settings snapshot captured under the short `ProjectWritePermit`; the permit has already been released. |
| `rendering` | `kernel.export.beginPublication` | `publishing` | All page/size renders succeeded; publication uses a recoverable transaction. |
| `publishing` | `kernel.export.complete` | `idle` | `export/current.json` references exactly one complete immutable generation. |
| `preparing`, `rendering` | `kernel.export.fail` | `idle` | No publication becomes visible. |
| `publishing` | `kernel.export.failBeforeIntent` | `idle` | Legal only when journal inspection proves no durable commit intent exists; candidate artifacts remain unreachable and no publication becomes visible. |
| `publishing` | `kernel.export.beginRecovery` | `recovering` | Post-intent interruption rolls forward. |
| `idle` | `kernel.export.beginRecovery` | `recovering` | Startup found a schema-valid ExportPublish journal with durable commit intent and adopts it before Workspace. |
| `recovering` | `kernel.export.completeRecovery` | `idle` | Publishes the recovered terminal result. |
| `recovering` | `kernel.export.blockRecovery` | `blocked` | A durable publication conflict blocks normal project writes; intent is retained. |
| `blocked` | `kernel.export.retryRecovery` | `recovering` | Rechecks and rolls forward the same intended ExportPublish journal after external repair. |

Rendering uses HostSupervisor sessions but does not own them through Reatom hooks.
During `preparing`, `ProjectWriteCoordinator` grants one short
`ProjectWritePermit` while the Kernel reads the exact page order, every canonical
source byte/hash, and resolved export settings into an immutable snapshot. The
permit is released before `beginRendering`; all rendering and cache work occur
without it. `beginPublication` reacquires the project-write mutex, compares the
current page list/source hashes/settings preconditions with the captured snapshot,
and either takes durable publication intent or executes `failBeforeIntent`. Intent,
pointer publication, and recovery remain under the transaction boundary.

### 7.6 Preview model

`PreviewState` is `disabled | idle | starting | live | switching | failed |
circuit-open`. Its selected source is either canonical Current design or a temporary
read-only historical snapshot. Each start/switch mints a UUIDv7 `previewSessionId`.

| Source | Named action | Target | Rule |
|---|---|---|---|
| `disabled` | `kernel.preview.enable` | `idle` | Requires trusted project and completed project recovery. |
| `idle`, `failed` | `kernel.preview.beginStart` | `starting` | Selects a page/source and asks HostSupervisor to start a session. |
| `live`, `failed` | `kernel.preview.beginSwitch` | `switching` | Used for page, Current design, or historical source changes. |
| `starting`, `switching` | `kernel.preview.sessionReady` | `live` | Requires matching `previewSessionId`; old-session signals are dropped. |
| `starting`, `switching`, `live` | `kernel.preview.sessionFailed` | `failed` | Carries bounded Gate/host error while the rest of the project remains usable. |
| `failed` | `kernel.preview.openCircuit` | `circuit-open` | Host restart budget is exhausted. |
| `circuit-open` | `kernel.preview.retryCircuit` | `starting` | Explicit retry or supervisor-approved backoff reset. |
| `live` | `kernel.preview.setMode`, `kernel.preview.setTweak`, `kernel.preview.resize`, `kernel.preview.setThemeCapabilities` | `live` | Same-state transitions are legal only for the matching live session and source rules; Tweaks and interactive mutation are unavailable on historical source. |
| `live` | `kernel.preview.forwardInput`, `kernel.preview.queryGeometry` | `live` | Guarded service actions require the matching session; input additionally requires Current interactive mode. They do not bump `stateRevision` unless authoritative Kernel state changes. |
| any open state | `kernel.preview.disable` | `disabled` | Explicitly stops the session through HostSupervisor. |

Frames do not pass through the control-event stream. The UI consumes a bounded,
latest-wins `PreviewSession` frame stream and sends preview intents through Kernel
commands. It never starts, kills, or writes to the host subprocess directly.

### 7.7 Migration model

`MigrationState` is `idle | planning | awaiting-confirmation | backing-up |
transforming | publishing | recovering | blocked`. An immutable migration plan has
one UUIDv7 `migrationPlanId`; accepting its confirmation has one distinct UUIDv7
`migrationActionId` that remains stable through backup, publication, and recovery.

| Source | Named action | Target | Rule |
|---|---|---|---|
| `idle` | `kernel.migration.beginPlan` | `planning` | Requires trusted project in pre-Workspace `opening` or ordinary `ready` state and an older supported format; the CLI migrate command uses the same Kernel path. |
| `planning` | `kernel.migration.planReady` | `awaiting-confirmation` | Mints `migrationPlanId` and publishes the exact rewrite/backup set, source/target versions, hashes, required space, and plan revision; no project write. |
| `planning` | `kernel.migration.planFailed` | `idle` | Too-new, unsafe, or unsupported input remains unchanged. |
| `awaiting-confirmation` | `kernel.migration.confirm` | `backing-up` | Accepts only the active `migrationPlanId` plus acknowledgement, mints `migrationActionId`, and returns it as `operationId`; backup remains outside `.termcraft/`. |
| `awaiting-confirmation` | `kernel.migration.discardPlan` | `idle` | Dismisses the offer with no backup or project write. |
| `backing-up` | `kernel.migration.backupVerified` | `transforming` | Requires the exact external manifest and durable `VERIFIED` marker. |
| `backing-up`, `transforming` | `kernel.migration.failBeforeIntent` | `idle` | No project target changed. |
| `transforming` | `kernel.migration.beginPublication` | `publishing` | Candidates passed current decoders/Gate; mutex-protected CAS and `MigrationTransaction` follow. |
| `publishing` | `kernel.migration.failBeforeIntent` | `idle` | Legal only when journal inspection proves no durable commit intent exists; canonical targets remain unchanged. |
| `publishing` | `kernel.migration.complete` | `idle` | Requires committed marker and successful reopen through current decoders. |
| `publishing` | `kernel.migration.beginRecovery` | `recovering` | Durable intent exists and must roll forward. |
| `idle` | `kernel.migration.beginRecovery` | `recovering` | Startup found a schema-valid Migration journal with durable commit intent and adopts its persisted `migrationPlanId` and `migrationActionId`. |
| `recovering` | `kernel.migration.completeRecovery` | `idle` | Startup or live retry completed the same plan. |
| `recovering` | `kernel.migration.blockRecovery` | `blocked` | Conflict blocks normal project writes. |
| `blocked` | `kernel.migration.retryRecovery` | `recovering` | Retries only after external repair; no abandon/force path. |

When project-open recovery finds a schema-valid intended Restore, ExportPublish, or
Migration journal, `kernel.project.beginRecovery` atomically moves `ProjectState`
from `opening` to `recovering` and invokes exactly one of
`kernel.restore.beginRecovery`, `kernel.export.beginRecovery`, or
`kernel.migration.beginRecovery` from that domain's `idle` state. A journal without
durable intent is discarded and cannot enter recovery. `kernel.project.retryOpen`
likewise invokes the corresponding domain `retryRecovery` action for a blocked
transaction before reopening.
All ordinary project-mutation, turn, Restore, export, and commit guards require
`MigrationState === idle`; read-only diagnosis may remain available. A newly planned
migration additionally requires trusted state, while post-intent recovery runs
before trust because rollback is no longer legal.

## 8. Command contract

### 8.1 Envelope

```ts
type ProtocolVersion = 1
type UUIDv7 = string
type UInt64String = string // canonical unsigned decimal, no leading zero except "0"
type Sha256Hex = string // exactly 64 lowercase hexadecimal characters
type HostNonce = string // exactly 32 lowercase hexadecimal characters

type CommandKindV1 =
  | "project.create" | "project.open" | "project.retryOpen"
  | "project.close" | "project.setTrust"
  | "turn.start" | "turn.cancel"
  | "chat.create" | "chat.switch" | "model.select"
  | "page.renameTitle" | "page.removePlan" | "page.removeConfirm"
  | "page.removeDiscardPlan" | "page.reorder" | "history.open"
  | "preview.selectPage" | "preview.selectHistorical"
  | "preview.selectCurrent" | "preview.resize"
  | "preview.setThemeCapabilities" | "preview.setMode"
  | "preview.forwardInput" | "preview.setTweak"
  | "preview.queryGeometry" | "preview.retry" | "preview.close"
  | "selection.set" | "selection.clear"
  | "pin.create" | "pin.setStatus"
  | "restore.plan" | "restore.confirm" | "restore.discardPlan"
  | "restore.retryRecord"
  | "commit.plan" | "commit.confirm" | "commit.discardPlan"
  | "export.start"
  | "migration.plan" | "migration.confirm"
  | "migration.discardPlan" | "migration.retryRecovery"

type FrameIdentityV1 = Readonly<{
  previewSessionId: UUIDv7
  nonce: HostNonce
  sourceHash: Sha256Hex
  frameSeq: UInt64String
}>

type FrameTokenV1 = UUIDv7 // opaque id; full binding stays in the Kernel ledger
type GeometryTokenV1 = UUIDv7 // opaque id; full anchor binding stays in the Kernel ledger

type PageRemovePlanV1 = Readonly<{
  pageRemovePlanId: UUIDv7
  pageSlug: string
  sourceHash: Sha256Hex
  orderedPageSlugs: readonly string[]
  pageOrderHash: Sha256Hex
  activePageSlug: string | null
  fallbackPageSlug: string | null
  planRevision: UInt64String
}>

type CommandEnvelopeV1<K extends CommandKindV1 = CommandKindV1> = Readonly<{
  protocolVersion: 1
  commandId: UUIDv7
  expectedRevision: UInt64String
  kind: K
  payload: CommandPayloadByKindV1[K]
}>
```

DTOs contain only JSON-compatible objects, arrays, strings, booleans, null, and
bounded safe integers. They contain no `Error`, `Date`, `Map`, `Set`, class instance,
function, `undefined`, or `bigint`. Every in-process command and event passes the
same encode/decode schema used by contract tests so hidden object references cannot
become part of the API.

For each frame-stream item, the Kernel mints a `FrameTokenV1` and includes it beside
the frame. The UI's typed display acknowledgement names `frameTokenId`; it is a
`PreviewSession` broker message, not a Kernel command and does not change
`stateRevision`. The broker keeps exactly one current displayed frame token per live
session. A later display acknowledgement, session/source switch, host nonce change,
or close invalidates the prior token. `preview.queryGeometry` carries only the opaque
`FrameTokenV1`; the Kernel resolves and verifies its ledger entry as the current
displayed frame before forwarding the bounded query. A frame token is never minted
by geometry, never contains element/fraction data, and cannot authorize
`pin.create`.

Only a successful `hit` or `pin-anchor` geometry result that resolves an exact page,
element, and finite fractional point causes the Kernel to mint a separate opaque
`GeometryTokenV1`; its private ledger entry binds
`(FrameIdentityV1, pageSlug, elementId, fx, fy)`. The
Kernel stores the canonical geometry token in a bounded 4,096-entry ledger for at
most 30 seconds; session/source/incarnation/displayed-frame change invalidates it
immediately, and successful `pin.create` consumes it once. The UI cannot inspect or
edit a token binding or synthesize one from a rectangle. This is one-way:
`FrameTokenV1 -> geometry query -> GeometryTokenV1 -> pin.create`; no token depends
on a later token in the chain.

### 8.2 External command kinds

This table is the authoritative v1 intent registry. A feature may add a new kind only
with a protocol-schema change, guard, capability mapping, transition-table entry,
and contract tests.

| Kind | Payload | Immediate Kernel intent |
|---|---|---|
| `project.create` | canonical root, validated creation defaults, initial text | Create/open the project, then begin the first turn through the project and turn models. |
| `project.open` | canonical root | Begin open/recovery. |
| `project.retryOpen` | `{ recovery: { kind: "restore", restoreActionId: UUIDv7 } | { kind: "export", operationId: UUIDv7 } | { kind: "migration", migrationActionId: UUIDv7 } }` | Retry the same blocked intended journal after external repair and atomically re-enter its owning domain recovery model. |
| `project.close` | empty | Begin explicit close. |
| `project.setTrust` | `{ trust: "trusted" | "untrusted-read-only", workspaceIdentity: string }` | Change execution trust after opaque workspace-identity validation. |
| `turn.start` | message text | Kernel captures active chat, valid selection, and resolvable open pins; UI cannot choose persisted pin resolution. |
| `turn.cancel` | `turnId` | Request cancellation of exactly that active turn. |
| `chat.create` | empty | Create and select a fresh chat through a Kernel transaction. |
| `chat.switch` | `chatId` | Select an existing chat without changing shared pages, preview, selection, or pins. |
| `model.select` | backend, model, effort | Validate backend capability and store the machine-local selection. |
| `page.renameTitle` | page slug, validated new title | Mechanically rewrite static `meta.title` through one `project-mutation` transaction. |
| `page.removePlan` | `{ pageSlug }` | Mint and publish one immutable `PageRemovePlanV1`; no project write. |
| `page.removeConfirm` | `{ pageRemovePlanId }` | Revalidate the complete active plan under the project-write mutex and execute its one bound `project-mutation`; no acknowledgement or page identity is accepted from the UI. |
| `page.removeDiscardPlan` | `{ pageRemovePlanId }` | Discard only the matching active page-removal plan. |
| `page.reorder` | exact permutation of listed slugs | Replace only portable page order through one transaction. |
| `history.open` | active page slug | Load current-row/Git-history projection. |
| `preview.selectPage` | page slug | Switch the canonical preview source. |
| `preview.selectHistorical` | page slug, full commit id | Materialize and select a temporary read-only snapshot. |
| `preview.selectCurrent` | page slug | Return to the exact canonical source on disk. |
| `preview.resize` | `previewSessionId`, width and height | Resize matching preview session. |
| `preview.setThemeCapabilities` | `previewSessionId`, theme id, terminal capabilities | Change the non-persistent host-scoped preview override. |
| `preview.setMode` | `previewSessionId`, static or interactive | Change mode when source and product tier permit it. |
| `preview.forwardInput` | `previewSessionId`, typed key/click/mouse input | Forward discrete or coalescible input only to matching Current interactive preview. |
| `preview.setTweak` | `previewSessionId`, tweak id and typed value | Mutate live prototype state on Current design only. |
| `preview.queryGeometry` | `{ frameToken: FrameTokenV1, query }`; `query` is the closed hit/rect/describe/layout/pin-anchor union | Resolve the opaque token as the broker's current displayed frame, then correlate a bounded geometry result through Kernel Events; a successful resolving `hit` or `pin-anchor` query mints a separate opaque `GeometryTokenV1`. `pin-anchor` is a Kernel-level refinement transported as `query-hit` on the host wire; the host protocol's closed query families are unchanged. |
| `preview.retry` | `previewSessionId` | Explicitly retry a failed/circuit-open preview through `kernel.preview.retryCircuit`. |
| `preview.close` | `previewSessionId` | Close the matching facade through `kernel.preview.disable`. |
| `selection.set` | page slug, element id | Resolve and store authoritative selection metadata for the live source. |
| `selection.clear` | empty | Clear selection. |
| `pin.create` | `{ geometryToken: GeometryTokenV1, text }` | Resolve, verify, and consume the Kernel-issued opaque token against the current displayed frame, then append a pin-created event through the Kernel transaction service. No page, element, rectangle, or fractions are accepted separately. |
| `pin.setStatus` | stable `pinId`, `open` or `resolved` | Append a user-action pin-status event if Current design and lifecycle state permit it. |
| `restore.plan` | page slug, full commit id | Build immutable Restore confirmation data. |
| `restore.confirm` | `restorePlanId`, overwrite acknowledgement | Capture `targetChatId`, mint `restoreActionId`, and begin recoverable Restore. |
| `restore.discardPlan` | `restorePlanId` | Discard the active plan. |
| `restore.retryRecord` | `restoreActionId` | Resume only the exactly-once target-chat record step. |
| `commit.plan` | typed commit scope | Build exact path/hash/HEAD confirmation data. |
| `commit.confirm` | `commitPlanId`, message, required warning acknowledgement | Revalidate and execute exactly the planned scope. |
| `commit.discardPlan` | `commitPlanId` | Discard the active plan. |
| `export.start` | empty | Export canonical Current design sources. |
| `migration.plan` | empty or typed selected file-kind scope | Diagnose a supported older format and build exact backup/rewrite confirmation. |
| `migration.confirm` | `{ migrationPlanId, acknowledged: true }` | Revalidate the active plan, mint `migrationActionId`, return it as `operationId`, and begin verified external backup, transform, and recoverable publication. |
| `migration.discardPlan` | `{ migrationPlanId }` | Dismiss the active pre-write migration plan. |
| `migration.retryRecovery` | `{ migrationActionId }` | Retry only the same post-intent action after external repair; transaction ids are not accepted from callers. |

The `Payload` column is the authoritative closed `CommandPayloadByKindV1` schema:
every named object rejects unknown keys, and prose-separated fields are required
fields of one readonly object unless the row says `empty` (the exact empty object).
Opening/closing the slash menu, moving focus, selecting a menu row, and dismissing a
pure presentation modal are UI-local actions with `capability: null`. Confirming
Restore, page removal, migration, or commit is not local: it sends the corresponding
Kernel command.

### 8.3 Results

```ts
type CommandResultV1 = AcceptedCommandV1 | RejectedCommandV1

type AcceptedCommandV1 = Readonly<{
  protocolVersion: 1
  commandId: UUIDv7
  status: "accepted"
  acceptedRevision: UInt64String
  resultingRevision: UInt64String
  disposition: "completed" | "started" | "no-op"
  operationId?: UUIDv7
}>

type RejectedCommandV1 = Readonly<{
  protocolVersion: 1
  commandId: UUIDv7
  status: "rejected"
  currentRevision: UInt64String
  code: CommandRejectionCode
  reasons: readonly [UnavailableReason, ...UnavailableReason[]]
}>
```

`Accepted` means the immediate named transition occurred or an explicitly idempotent
no-op was recognized. For `started`, terminal success/failure arrives as an event
carrying the same `commandId` and `operationId`. A failure after acceptance does not
retroactively change the command result. The operation identity is the domain
identity when one already exists: `turnId` for `turn.start`, `restoreActionId` for
`restore.confirm`, `migrationActionId` for `migration.confirm`, `pinId` for
`pin.create`, and `previewSessionId` for a preview start/switch. Commit execution and
export mint their own UUIDv7 operation ids. Plan commands separately publish their
immutable `pageRemovePlanId`, `restorePlanId`, `commitPlanId`, or
`migrationPlanId`; plan ids are never overloaded as execution operation ids.

### 8.4 Revision and cancel guards

Normal dispatch requires `expectedRevision === stateRevision` before evaluating the
domain guard. Mismatch returns `STALE_REVISION`, the current revision, and no state
change. The UI refreshes its snapshot/capabilities and reconstructs the intent; it
must not silently replace the expected revision and retry a confirmation command.

`turn.cancel` is the sole exception:

1. its payload must name the exact current `turnId`;
2. a stale `expectedRevision` is tolerated if that turn is still active;
3. a running cancellable phase transitions to `stopping`; another active
   pre-intent phase transitions to `terminalizing` after any owned work stops;
4. `stopping` or `terminalizing` returns accepted `no-op` for the same turn;
5. a different/no active turn returns `TURN_ID_MISMATCH` or `TURN_NOT_ACTIVE`;
6. `finalizing` after durable intent returns `CANCEL_TOO_LATE` and continues
   roll-forward.

This guard lets an `Esc` generated from a slightly stale UI stop the intended run
without ever cancelling a newer turn.

### 8.5 Command deduplication

The Kernel keeps a per-process dedupe ledger with at most 65,536 results and a
15-minute retry horizon. Entries are never evicted before the horizon. If capacity
would be exceeded, new commands are rejected with `COMMAND_DEDUPE_CAPACITY` rather
than weakening exactly-once handling. After the horizon, UUIDv7 timestamps older
than the ledger's dedupe floor are rejected with `COMMAND_ID_EXPIRED`; they are never
executed as new commands.

For a first-seen id, the ledger stores a canonical hash of the complete envelope and
an in-flight promise before guard evaluation. A concurrent duplicate waits for that
promise. A later byte-equivalent/canonically equivalent envelope returns the exact
stored result, including generated `operationId`, without a transition, event replay,
or revision change. Reusing the id with any different envelope field returns
`COMMAND_ID_REUSE_MISMATCH`.

The UI creates a UUIDv7 once per user intent and reuses it only to recover an unknown
in-process result. It creates a new id for a deliberate retry after a typed failure.
Page removal's `pageRemovePlanId`, Restore's `restoreActionId`, migration's
`migrationPlanId`/`migrationActionId`, commit's `commitPlanId`, pin `pinId`, turn
`turnId`, and transaction ids provide domain idempotency beyond command-response
dedupe.

## 9. Event contract

```ts
type PageDescriptorV1 =
  | Readonly<{
      status: "ready"
      pageSlug: string
      sourceHash: Sha256Hex
      title: string
      minSize: Readonly<{ w: number; h: number }>
      theme: string
      kitApiVersion: number
    }>
  | Readonly<{
      status: "invalid"
      pageSlug: string
      sourceHash: Sha256Hex
      error: Readonly<{ code: string; safeMessage: string }>
    }>

type PageDescriptorChangeV1 = Readonly<{
  pageSlug: string
  kind: "added" | "updated" | "removed" | "reordered"
  beforeSourceHash: Sha256Hex | null
  afterSourceHash: Sha256Hex | null
}>

type PinDtoV1 = Readonly<{
  pinId: UUIDv7
  pageSlug: string
  elementId: string
  fx: number
  fy: number
  text: string
  status: "open" | "resolved"
  createdRecordId: UUIDv7
  latestRecordId: UUIDv7
  updatedAt: string
}>

type DiagnosticDtoV1 = Readonly<{
  diagnosticId: UUIDv7
  scope: "project" | "turn" | "preview" | "git" | "migration"
  severity: "info" | "warning" | "error"
  code: string
  safeMessage: string
  pageSlug?: string
  sourceHash?: Sha256Hex
}>

type EventKindV1 =
  | "kernel.snapshot" | "kernel.stateChanged"
  | "kernel.capabilitiesChanged"
  | "page.removePlanReady" | "page.descriptorsChanged"
  | "turn.started" | "turn.attemptStarted" | "turn.progress"
  | "turn.gateRejected" | "turn.applyStarted" | "turn.completed"
  | "turn.failed" | "turn.cancelled"
  | "restore.planReady" | "restore.started" | "restore.recordPending"
  | "restore.completed" | "restore.failed"
  | "commit.planReady" | "commit.started" | "commit.completed"
  | "commit.failed"
  | "export.started" | "export.progress" | "export.completed"
  | "export.failed"
  | "migration.planReady" | "migration.started" | "migration.progress"
  | "migration.completed" | "migration.failed"
  | "preview.sourceChanged" | "preview.sessionReady"
  | "preview.geometryResult" | "preview.backpressured"
  | "preview.writable" | "preview.failed" | "preview.circuitOpened"
  | "chat.changed" | "selection.changed" | "pins.changed"
  | "git.statusChanged" | "diagnostics.changed"

type EventPayloadByKindV1 = Readonly<{
  "kernel.snapshot": KernelSnapshotPayloadV1
  "kernel.stateChanged": KernelStateChangedPayloadV1
  "kernel.capabilitiesChanged": KernelCapabilitiesChangedPayloadV1
  "page.removePlanReady": PageRemovePlanReadyPayloadV1
  "page.descriptorsChanged": PageDescriptorsChangedPayloadV1
  "turn.started": TurnStartedPayloadV1
  "turn.attemptStarted": TurnAttemptStartedPayloadV1
  "turn.progress": TurnProgressPayloadV1
  "turn.gateRejected": TurnGateRejectedPayloadV1
  "turn.applyStarted": TurnApplyStartedPayloadV1
  "turn.completed": TurnTerminalPayloadV1
  "turn.failed": TurnTerminalPayloadV1
  "turn.cancelled": TurnTerminalPayloadV1
  "restore.planReady": RestorePlanReadyPayloadV1
  "restore.started": RestoreStartedPayloadV1
  "restore.recordPending": RestoreRecordPendingPayloadV1
  "restore.completed": RestoreTerminalPayloadV1
  "restore.failed": RestoreTerminalPayloadV1
  "commit.planReady": CommitPlanReadyPayloadV1
  "commit.started": CommitStartedPayloadV1
  "commit.completed": CommitTerminalPayloadV1
  "commit.failed": CommitTerminalPayloadV1
  "export.started": ExportStartedPayloadV1
  "export.progress": ExportProgressPayloadV1
  "export.completed": ExportTerminalPayloadV1
  "export.failed": ExportTerminalPayloadV1
  "migration.planReady": MigrationPlanReadyPayloadV1
  "migration.started": MigrationStartedPayloadV1
  "migration.progress": MigrationProgressPayloadV1
  "migration.completed": MigrationTerminalPayloadV1
  "migration.failed": MigrationFailedPayloadV1
  "preview.sourceChanged": PreviewSourceChangedPayloadV1
  "preview.sessionReady": PreviewSessionReadyPayloadV1
  "preview.geometryResult": PreviewGeometryResultPayloadV1
  "preview.backpressured": PreviewBackpressurePayloadV1
  "preview.writable": PreviewBackpressurePayloadV1
  "preview.failed": PreviewFailurePayloadV1
  "preview.circuitOpened": PreviewCircuitOpenedPayloadV1
  "chat.changed": ChatChangedPayloadV1
  "selection.changed": SelectionChangedPayloadV1
  "pins.changed": PinsChangedPayloadV1
  "git.statusChanged": GitStatusChangedPayloadV1
  "diagnostics.changed": DiagnosticsChangedPayloadV1
}>

type EventEnvelopeV1<K extends EventKindV1 = EventKindV1> = Readonly<{
  protocolVersion: 1
  kernelInstanceId: UUIDv7
  eventSeq: UInt64String
  stateRevision: UInt64String
  kind: K
  correlation?: Readonly<{
    commandId?: UUIDv7
    operationId?: UUIDv7
    transactionId?: UUIDv7
    turnId?: UUIDv7
    pageRemovePlanId?: UUIDv7
    restorePlanId?: UUIDv7
    restoreActionId?: UUIDv7
    commitPlanId?: UUIDv7
    migrationPlanId?: UUIDv7
    migrationActionId?: UUIDv7
    previewSessionId?: UUIDv7
    frameTokenId?: UUIDv7
    geometryTokenId?: UUIDv7
    pinId?: UUIDv7
  }>
  payload: EventPayloadByKindV1[K]
}>
```

The type names in `EventPayloadByKindV1` are closed DTO schemas. The following table
defines their exact required fields; fields marked nullable carry JSON `null`, not
omission. Unknown payload keys are invalid.

| Event kind(s) | Exact required payload fields |
|---|---|
| `kernel.snapshot` | `models` (all seven tagged model DTOs), `projectId`, `activePageSlug`, `activeChatId`, `trust`, complete `capabilities`, complete ordered `pageDescriptors`, Git status projection, and current `eventSeq`; nullable identities are explicit. |
| `kernel.stateChanged` | `modelId`, exact named `action`, `previousTag`, `nextTag`, and the action's closed bounded `metadata` union. Sensitive paths and native errors are forbidden. |
| `kernel.capabilitiesChanged` | Complete replacement `CapabilityEntry` values for every changed `(id,target)` key and `removed` keys for targets no longer published. |
| `page.removePlanReady` | Complete `PageRemovePlanV1`. |
| `page.descriptorsChanged` | `{ reason: "project-open" | "turn-apply" | "restore" | "migration" | "rename-title" | "remove-page" | "reorder-pages" | "external-refresh", descriptors: readonly PageDescriptorV1[], changes: readonly PageDescriptorChangeV1[], activePageSlug: string | null }`. The descriptor list is complete and ordered; each non-removed descriptor and every change carries its exact before/after source-hash binding. |
| `turn.started` | `turnId`, captured `chatId`, and absolute deadline. |
| `turn.attemptStarted` | `turnId`, `attempt`, and absolute deadline; `leaseNonce` remains internal. |
| `turn.progress` | `turnId`, `attempt`, normalized progress kind, and bounded backend-neutral content after full internal lease validation. |
| `turn.gateRejected` | `turnId`, `attempt`, retry number, and bounded closed Gate diagnostics. |
| `turn.applyStarted` | `turnId`, candidate hash, and affected page slugs. |
| `turn.completed`, `turn.failed`, `turn.cancelled` | `turnId`, exact outcome code, changed page slugs, resulting source hashes, bounded warnings, and nullable closed failure DTO. |
| `restore.planReady` | `restorePlanId`, page slug, full source commit id, immutable blob hash, pre-Restore source hash, index state, Gate-attestation hash, plan revision, and exact confirmation facts. |
| `restore.started` | `restorePlanId`, `restoreActionId`, page slug, full source commit id, and safe target-chat display identity. |
| `restore.recordPending` | `restoreActionId`, page slug, full source commit id, and safe target-chat display identity. |
| `restore.completed`, `restore.failed` | `restorePlanId`, nullable `restoreActionId`, page slug, full source commit id, phase, and nullable closed failure DTO. The persisted record still relies on its containing chat for chat identity. |
| `commit.planReady` | `commitPlanId`, scope, expected `HEAD`, exact path/state/hash preview, message template, and detached-HEAD warning flag. |
| `commit.started` | `commitPlanId`, execution `operationId`, scope, and exact selected paths. |
| `commit.completed`, `commit.failed` | `commitPlanId`, execution `operationId`, scope, resulting Git status, and nullable closed failure DTO. |
| `export.started` | export `operationId`, immutable source-snapshot digest, page count, render-job count, and destination identity. |
| `export.progress` | export `operationId`, phase, completed jobs, total jobs, nullable page slug, and nullable size. |
| `export.completed`, `export.failed` | export `operationId`, phase, destination identity, nullable generation id, and nullable closed failure DTO. |
| `migration.planReady` | `migrationPlanId`, exact selected file-kind scope, exact rewrite entries `(relativePath, fileKind, beforeHash, fromVersion, toVersion, sizeBytes)`, backup bytes, required free bytes, and plan revision. |
| `migration.started` | `migrationPlanId`, `migrationActionId`, selected scope, and phase `backing-up`. |
| `migration.progress` | `migrationPlanId`, `migrationActionId`, phase (`backing-up | transforming | publishing | recovering`), completed items, total items, and nullable relative path. |
| `migration.completed` | `migrationPlanId`, `migrationActionId`, transaction id, migrated-file count, resulting version map, and `recovered` boolean. |
| `migration.failed` | `{ migrationPlanId: null, migrationActionId: null, transactionId: null, phase: "planning", failure: FailureDtoV1 } | { migrationPlanId: UUIDv7, migrationActionId: UUIDv7, transactionId: UUIDv7 | null, phase: "backing-up" | "transforming" | "publishing" | "recovering", failure: FailureDtoV1 }`. The transaction id becomes non-null only after transaction preparation. |
| `preview.sourceChanged` | `previewSessionId`, page slug, source selector (`current` or full historical commit id), source hash, and host mode. |
| `preview.sessionReady` | `previewSessionId`, current nonce, page slug, source hash, host mode, interaction mode, size, theme, and initial frame sequence. |
| `preview.geometryResult` | `previewSessionId`, `frameTokenId`, queried `FrameIdentityV1`, query kind, closed geometry result, and `geometryToken: GeometryTokenV1 | null`; the token is non-null only for a successful resolving `hit` or `pin-anchor` query. |
| `preview.backpressured`, `preview.writable` | `previewSessionId`, current nonce, ordered-queue size, capacity, and low-water mark. |
| `preview.failed` | `previewSessionId`, current nonce, page slug, source hash, lifecycle phase, and closed host failure. |
| `preview.circuitOpened` | `previewSessionId`, page slug, source hash, attempts, final failure, and retry capability state. This exact lower-camel discriminator is the only circuit-open event kind. |
| `chat.changed` | complete active chat identity plus the exact added/updated chat summaries and removed chat ids. |
| `selection.changed` | nullable selection DTO containing page slug, element id, and source hash. |
| `pins.changed` | page slug, `affectedPins: PinDtoV1[]`, affected record ids, and the transaction/action identity that caused each persisted change. Every created or changed pin therefore returns its stable `pinId`. |
| `git.statusChanged` | repository identity, `HEAD`, sequencer state, and complete three-scope status summaries. |
| `diagnostics.changed` | `{ generation: UInt64String, upserts: readonly DiagnosticDtoV1[], removedDiagnosticIds: readonly UUIDv7[] }`; it replaces the former open-ended “typed diagnostics” family. |

Every payload union has the exact closed v1 discriminator above and a schema test.
Unknown event kinds, unknown payload keys, or a payload type not mapped by
`EventPayloadByKindV1` are protocol errors inside the same-version in-process
implementation; they are not silently interpreted as known events.

The mailbox assigns `eventSeq` at publication. Events produced by one transition are
enqueued contiguously before the next command or internal signal is handled. Their
`stateRevision` is the revision after that transition. Progress events increment
only `eventSeq`. A duplicate command result does not replay prior events. A rejected
command emits no domain event; diagnostics may be logged outside the UI contract.

An in-process subscriber receives one `kernel.snapshot` containing the current
revision, current event sequence, all seven model snapshots, active identities, and
capabilities, then subsequent events. There is no event-resume token, replay buffer,
or reconnect promise in v1.

## 10. Capabilities and UI applicability

### 10.1 Typed capability shape

```ts
type CapabilityState =
  | Readonly<{ available: true }>
  | Readonly<{
      available: false
      reasons: readonly [UnavailableReason, ...UnavailableReason[]]
    }>

type CapabilityId = CommandKindV1

type CapabilityEntry<K extends CapabilityId = CapabilityId> = Readonly<{
  id: K
  target: CapabilityTargetByKindV1[K]
  state: CapabilityState
}>
```

`CapabilityTargetByKindV1` is the following closed map. `null` is a required value,
not an omitted target. The extractor first validates `CommandPayloadByKindV1`, then
normalizes the listed fields; capability projection constructs the same target from
Kernel state. No target contains message/initial/title/pin/commit text, an
acknowledgement, terminal/input/tweak/geometry raw input, dimensions, coordinates,
rectangle fractions, or a page-order permutation.

| Command family/kind | Exact `CapabilityTargetByKindV1[K]` | Extraction |
|---|---|---|
| `project.create`, `project.open`, `project.close`, `turn.start`, `chat.create`, `page.reorder`, `selection.clear`, `export.start`, `migration.plan` | `null` | Literal `null`; paths, creation defaults, user text, permutations, and selected migration file-kind scope remain payload-only. |
| `project.retryOpen` | `{ recovery: { kind: "restore", restoreActionId: UUIDv7 } | { kind: "export", operationId: UUIDv7 } | { kind: "migration", migrationActionId: UUIDv7 } }` | Copy the validated closed `payload.recovery` discriminator and its one domain operation id. |
| `project.setTrust` | `{ workspaceIdentity: string }` | Copy the validated opaque workspace identity; omit the trust decision. |
| `turn.cancel` | `{ turnId: UUIDv7 }` | Copy `payload.turnId`. |
| `chat.switch` | `{ chatId: UUIDv7 }` | Copy `payload.chatId`. |
| `model.select` | `{ backend: string, model: string, effort: string }` | Copy the three validated canonical enum/id values. |
| `page.renameTitle`, `page.removePlan`, `history.open`, `preview.selectPage`, `preview.selectCurrent` | `{ pageSlug: string }` | Copy the normalized page slug; title text is excluded. |
| `page.removeConfirm`, `page.removeDiscardPlan` | `{ pageRemovePlanId: UUIDv7 }` | Copy only `payload.pageRemovePlanId`; plan facts come from the Kernel plan ledger. |
| `preview.selectHistorical` | `{ pageSlug: string, sourceCommit: string }` | Copy normalized page slug and validated full commit id. |
| `preview.resize`, `preview.forwardInput`, `preview.retry`, `preview.close` | `{ previewSessionId: UUIDv7 }` | Copy only the session id; dimensions and forwarded input are excluded. |
| `preview.setThemeCapabilities` | `{ previewSessionId: UUIDv7, themeId: string }` | Copy session and canonical theme ids; terminal capabilities are excluded. |
| `preview.setMode` | `{ previewSessionId: UUIDv7, mode: "static" | "interactive" }` | Copy the session id and closed mode. |
| `preview.setTweak` | `{ previewSessionId: UUIDv7, tweakId: string }` | Copy session and canonical tweak ids; the typed value is excluded. |
| `preview.queryGeometry` | `{ frameTokenId: UUIDv7, queryKind: "hit" | "rect" | "describe" | "layout" | "pin-anchor" }` | Copy the opaque frame token id and closed query discriminator; its frame identity, coordinates, and other query body fields remain payload/ledger-only. |
| `selection.set` | `{ pageSlug: string, elementId: string }` | Copy normalized page and element ids. |
| `pin.create` | `{ geometryTokenId: UUIDv7 }` | Copy only the opaque geometry token id; the private frame/page/element/fraction binding and pin text are excluded. |
| `pin.setStatus` | `{ pinId: UUIDv7, status: "open" | "resolved" }` | Copy the stable pin id and closed status. |
| `restore.plan` | `{ pageSlug: string, sourceCommit: string }` | Copy normalized page slug and validated full commit id. |
| `restore.confirm`, `restore.discardPlan` | `{ restorePlanId: UUIDv7 }` | Copy only the plan id; acknowledgement is excluded. |
| `restore.retryRecord` | `{ restoreActionId: UUIDv7 }` | Copy `payload.restoreActionId`. |
| `commit.plan` | `{ scope: "current-page" | "infrastructure" | "whole-project" }` | Copy the closed normalized scope. |
| `commit.confirm`, `commit.discardPlan` | `{ commitPlanId: UUIDv7 }` | Copy only the plan id; message and acknowledgement are excluded. |
| `migration.confirm`, `migration.discardPlan` | `{ migrationPlanId: UUIDv7 }` | Copy only the plan id; acknowledgement is excluded. |
| `migration.retryRecovery` | `{ migrationActionId: UUIDv7 }` | Copy only `payload.migrationActionId`. |

The first unavailable reason is selected by a stable priority table for the primary
hint; all reasons remain available for diagnostics and accessibility.

### 10.2 One guard implementation

Each command family owns a pure guard over exactly
`(currentKernelState, CapabilityTargetByKindV1[K])`, returning `available` or a
non-empty typed reason list. Dispatch validates the closed payload, extracts the
target by the table above, and calls the guard after revision validation. The
capability projector calls the same function over the current state and the same
normalized target. Payload-only content/schema, freshness, token-ledger, and
operation-specific mutex checks run after the guard and are not capability inputs.
No UI predicate duplicates `turn !== idle`, Git scope checks,
historical-source checks, or trust checks.

Capability/guard parity is an invariant: for the same state and target, a published
available capability must let a direct current-revision command pass the guard, and
an unavailable capability must reject it with the same primary code. External state
may change after publication; revision and operation-specific revalidation remain the
final authority.

### 10.3 UI composition

An action-table entry has:

```ts
type UiActionEntry = Readonly<{
  id: string
  label: string
  description: string
  triggers: readonly UiTrigger[]
  capability: CommandKindV1 | null
  locallyApplicable: (ui: UiViewState) => LocalApplicability
  buildCommand?: (ui: UiViewState, kernel: KernelMirror) => CommandEnvelopeV1
}>
```

The UI computes:

```text
visible = action belongs on the current screen or menu
enabled = visible AND local applicability AND Kernel capability is available
hint    = local reason when locally inapplicable, otherwise Kernel primary reason
```

Focus and modal precedence remain local because they decide which trigger may fire,
not whether a domain mutation is legal. Every UI action that constructs a Kernel
command names that command's exact `CommandKindV1`; every action without a Kernel
command, including chat-list/slash-menu open and pure modal dismissal, uses
`capability: null`. A stale mirrored capability may cause the UI to offer an action
briefly; Kernel revision and guard checks still reject safely.

### 10.4 Required turn-time capability matrix

While `TurnState` is non-idle:

| Intent | Kernel capability |
|---|---|
| Ordinary `turn.start` / Send | unavailable: `TURN_RUNNING` |
| `/new` / `chat.create` | unavailable: `TURN_RUNNING` |
| `/chats`, chat-list open, and `chat.switch` | unavailable: `TURN_RUNNING` |
| `/export` / `export.start` | unavailable: `TURN_RUNNING` |
| `/model` / `model.select` | unavailable: `TURN_RUNNING` |
| Page title/remove-plan/remove-confirm/remove-plan-discard/reorder commands | unavailable: `TURN_RUNNING` |
| Restore planning, confirmation, and execution | unavailable: `TURN_RUNNING` |
| Local slash-command mode | locally available on an otherwise empty composer; no Kernel command is required to open it |
| `/commit-page` | available exactly when the current-page Git scope guard is available |
| `/commit-infra` | available exactly when the infrastructure Git scope guard is available |
| `/commit-all` | available exactly when the whole-project Git scope guard is available |
| `turn.cancel` | available for the exact active turn before commit intent, with the permissive revision rule |
| Read-only page-tab preview switching | available when the preview/page guard permits it |

The commit guards do not include `TURN_RUNNING`. They still include Git executable,
repository, sequencer, scope-dirty, active-plan, and resource-limit reasons. Other
turn-locked slash rows stay visible but dimmed with `TURN_RUNNING`.

## 11. Typed unavailable and error codes

### 11.1 Immediate command rejections

| Code | Meaning |
|---|---|
| `UNSUPPORTED_PROTOCOL` | `protocolVersion` is not supported. |
| `INVALID_ENVELOPE` | DTO schema, UUIDv7, unsigned decimal, kind, or payload validation failed. |
| `COMMAND_ID_REUSE_MISMATCH` | The id already belongs to a different canonical envelope. |
| `COMMAND_ID_EXPIRED` | The id is older than the dedupe floor. |
| `COMMAND_DEDUPE_CAPACITY` | Safe result retention is full; the Kernel refuses to weaken dedupe. |
| `STALE_REVISION` | `expectedRevision` is not current and cancel's narrow exception does not apply. |
| `PROJECT_NOT_READY` | The project model is not `ready`. |
| `PROJECT_UNTRUSTED` | The ready project is `untrusted-read-only` and the command would execute page code or mutate project/machine-local workspace state. |
| `TURN_ALREADY_ACTIVE` | A new turn was requested while one is active. |
| `TURN_RUNNING` | This ordinary action is locked for the duration of the turn. |
| `TURN_NOT_ACTIVE` | No turn exists for cancellation. |
| `TURN_ID_MISMATCH` | Cancel names a different turn. |
| `CANCEL_TOO_LATE` | Durable apply commit intent prevents cancellation. |
| `HISTORICAL_PREVIEW_READ_ONLY` | Send, Tweaks, or pin mutation was requested on a historical source. |
| `GIT_UNAVAILABLE` | Installed Git cannot be used. |
| `NOT_GIT_REPOSITORY` | History/Restore/commit intent has no repository. |
| `GIT_SCOPE_CLEAN` | The selected commit scope has no eligible change. |
| `GIT_SEQUENCER_ACTIVE` | Merge/rebase/cherry-pick/revert blocks termcraft commit. |
| `SOURCE_STAGED` | Restore cannot replace a staged page source. |
| `PLAN_NOT_FOUND` | Page-removal, Restore, commit, or migration plan id is not the active plan of that family. |
| `PLAN_STALE` | Page-removal, Restore, commit, or migration plan facts/revision were invalidated before execution. |
| `CONFIRMATION_REQUIRED` | Required overwrite/detached-HEAD warning was not acknowledged. |
| `NO_PAGES` | Export or page intent requires at least one page. |
| `OPERATION_BUSY` | The relevant single-operation model is not idle. |
| `HOST_BACKPRESSURED` | The matching preview's ordered host queue cannot accept another non-coalescible command. |
| `TOO_MANY_REQUESTS` | The matching preview already has the maximum bounded geometry requests outstanding. |
| `FRAME_TOKEN_INVALID` | A geometry query names an absent, malformed, or non-canonical Kernel frame token. |
| `FRAME_TOKEN_STALE` | The frame token is not the broker's current display-acknowledged frame for its live session/incarnation/source. |
| `GEOMETRY_TOKEN_INVALID` | `pin.create` names an absent, malformed, expired, already-consumed, or non-canonical Kernel geometry token. |
| `GEOMETRY_TOKEN_STALE` | The token's session/incarnation/source/frame is not the current frame acknowledged as displayed. |
| `CAPABILITY_UNAVAILABLE` | Typed fallback for a guard reason that has no more specific public code. |

`UnavailableReason` is a discriminated union using these stable codes plus bounded,
code-specific details such as active `turnId`, scope, page slug, plan id, or required
revision. User-facing prose is presentation data; callers branch on codes, never
message text.

### 11.2 Operational failure codes after acceptance

| Code | Operation |
|---|---|
| `BACKEND_UNAVAILABLE`, `BACKEND_FAILED` | Agent startup or execution. |
| `TURN_DEADLINE_EXCEEDED` | Absolute turn deadline, unaffected by event noise. |
| `GATE_RETRY_EXHAUSTED` | Candidate remains invalid after the retry budget. |
| `APPLY_SOURCE_CHANGED` | A canonical source/page inventory or portable manifest precondition drifted before final apply, including Git-hook side effects; details include `part: "page" | "manifest"`. |
| `APPLY_STALE` | Captured chat or relevant comments/pins drifted; details carry typed `part: "chat" | "pins"`. Send-time local tab/preview/selection changes are snapshot context and do not stale apply. |
| `STALE_BACKEND_EVENT_DROPPED` | Diagnostic only; a turn fence did not match. |
| `TRANSACTION_RECOVERY_CONFLICT` | Durable roll-forward cannot prove a safe operation. |
| `RESTORE_SOURCE_CHANGED`, `RESTORE_OBJECT_MISSING`, `RESTORE_GATE_FAILED` | Restore pre-intent validation. |
| `RESTORE_RECORD_PENDING` | Source is restored but target-chat record completion is still pending/recovering. |
| `COMMIT_PLAN_STALE` | `HEAD`, path set, state, or content hash changed at execution. |
| `GIT_IDENTITY_MISSING`, `GIT_HOOK_FAILED`, `GIT_SIGNING_FAILED`, `GIT_INDEX_BUSY`, `GIT_COMMAND_FAILED` | Scoped Git commit. |
| `EXPORT_SNAPSHOT_STALE`, `EXPORT_RENDER_FAILED`, `EXPORT_PUBLICATION_FAILED` | Export snapshot revalidation, rendering, or publication. |
| `MIGRATION_BACKUP_FAILED`, `MIGRATION_STALE`, `MIGRATION_TRANSFORM_FAILED`, `MIGRATION_PUBLICATION_FAILED` | Migration backup, transform, validation, or transaction publication. |
| `HOST_START_FAILED`, `HOST_PROTOCOL_FAILED`, `HOST_CIRCUIT_OPEN` | Preview HostSupervisor. |
| `PERSISTENCE_FAILED`, `RESOURCE_LIMIT_EXCEEDED` | Bounded storage/process/queue failure. |

Terminal operation events include a typed failure object with code, retryability,
bounded details, and a safe display message. Native `Error` objects and unbounded
stdout/stderr never cross the event DTO.

## 12. Command and event flows

### 12.1 Normal dispatch

1. The UI resolves a trigger through the action registry, checks local
   applicability and the mirrored Kernel capability, generates one UUIDv7
   `commandId`, and sends the current mirrored revision.
2. The mailbox validates the closed DTO and protocol, installs or finds the dedupe
   entry, and performs the revision check.
3. It extracts exactly `CapabilityTargetByKindV1[kind]` by §10.1 and evaluates the
   authoritative guard over that target. A failure records and returns `Rejected`
   without a model transition; payload-only freshness/token/mutex checks remain the
   owning command's subsequent validation and cannot alter capability parity.
4. It calls one or more named model actions in a single Reatom frame. Cross-model
   orchestration is a named Kernel action, never UI-side sequencing.
5. If state changed, the mailbox advances `stateRevision` once, derives
   capabilities, records `Accepted`, and publishes contiguous state/domain events.
6. For async work, the owning service starts after the state transition. Its wrapped
   completion signal returns through the mailbox and causes another legal named
   transition.

### 12.2 Agent turn and late-event fencing

1. `turn.start` captures `chatId`, authoritative selection, and only currently open,
   resolvable pins. The UI sends message text; it neither selects persisted pin ids
   nor writes chat/pin storage.
2. `AgentRunSupervisor` creates a unique per-turn workspace and attempt lease
   `{turnId, attempt, leaseNonce}`. The nonce is a cryptographically random 128-bit
   value encoded base64url.
3. Every backend progress/completion callback carries the full lease. The mailbox
   compares all three fields with `TurnState` before calling an action. A mismatch is
   dropped, counted, and optionally emits a bounded diagnostic event; it cannot
   update chat progress, candidate state, retries, usage, or final text.
4. A retry keeps `turnId`, increments `attempt`, and replaces `leaseNonce`. An event
   from any earlier attempt is stale even if it arrives before cancellation cleanup.
5. Cancellation of a running attempt enters `stopping`, asks the supervisor to
   terminate the exact leased process tree, and remains there until exit is
   confirmed before terminalization. A later turn
   cannot start while cancellation is incomplete.
6. Gate receives an immutable candidate copied by the safe filesystem intake path,
   not the agent's writable workspace.
7. On success, final apply acquires the project-write mutex and revalidates the
complete source, manifest, chat, and comments CAS read set before durable
commit intent. The transaction persists one commit intent defining canonical page
changes, portable page order, any requested local active-page change, the agent
chat record, and pin lifecycle events, then rolls those operations forward
   idempotently. It does not claim a sequence of filesystem renames is atomic.
8. Sent pins are resolved only by this Kernel transaction after successful apply
   when their page is in non-empty `changedPages`; an empty design diff resolves none.
   The UI consumes `pins.changed`; it never appends, rewrites, or resolves pin
   records itself. Pins created after turn capture are not part of that turn and
   remain open.

### 12.3 Commit during an agent turn

The turn and commit models may be active concurrently. Agent streaming, candidate
capture, Gate, and commit planning do not hold the project-write mutex.

- If commit execution acquires the mutex first, it commits the exact currently
  applied scope. It refreshes Git status and releases the mutex. Final apply then
   revalidates its complete captured read-set preconditions. With no conflicting hook
  side effect, apply writes the new design and that result becomes uncommitted. If a
   hook changed a protected input, apply fails with `APPLY_SOURCE_CHANGED` for
   page/manifest drift or `APPLY_STALE` for local/chat/comments/prompt drift and
   never overwrites it.
- If final apply acquires the mutex first, the apply transaction completes and Git
  status refreshes. A previously displayed commit plan no longer matches its scope
  hashes and `commit.confirm` fails with `COMMIT_PLAN_STALE`; the user receives a new
  plan and confirmation.
- If both are waiting, mutex acquisition order decides which valid precondition set
  wins. No priority rule is required for correctness, and neither operation holds
  the mutex while waiting on network, agent, Gate, preview rendering, or user input.

### 12.4 Restore confirmation and record completion

1. `restore.plan` reads the full Git object, current source hash, and index state and
   Gates the exact snapshot without a project write.
2. `restore.confirm` must use the current revision and active `restorePlanId`. The
   Kernel, not the UI, captures the active chat as `targetChatId` and mints
   `restoreActionId` once.
3. Under the project-write mutex, Restore revalidates source hash, index state, full
   object readability, and the stored attestation's source/runtime/policy bindings
   before commit intent. It does not rerun Gate or a matching host at confirmation.
4. The durable transaction replaces only canonical `page.tsx` and appends exactly
   one system record to the captured target chat. The record contains
`restoreActionId`, `pageSlug`, and full source commit id; the containing chat remains its
   persisted chat identity, so the record does not duplicate `targetChatId`.
5. If record acknowledgement is ambiguous after source replacement, state is
   `record-pending`. Retry/recovery checks only the captured target chat for that
   action id and appends if absent. It never repeats Gate/source replacement and is
   safe across chat switches and process restart.

Any state revision change while the confirmation is displayed expires that displayed
confirmation. If only the active chat changed, the Kernel may reuse the immutable
historical-source plan after revalidating its source/index/object facts, but the UI
must present a fresh confirmation naming the new target chat and send a new command
id at the current revision. Source, index, or object drift requires a new plan.

### 12.5 Export and preview

Export snapshots canonical Current design even when the preview is historical and is
unavailable during a turn. Preparation acquires one short `ProjectWritePermit`, reads
the exact ordered page list, source bytes/hashes, and resolved settings into one
immutable snapshot, then releases the permit. HostSupervisor rendering and cache
work run outside the permit/mutex. After all outputs succeed, publication reacquires
the project-write mutex, revalidates the snapshot preconditions, and either records
durable publication intent or returns to `idle` through `failBeforeIntent` with
`EXPORT_SNAPSHOT_STALE`; only the publication phase is recoverable.

Preview source changes are Kernel commands. HostSupervisor assigns and validates
`previewSessionId`; old session events and frames are ignored. Historical source
selection publishes read-only capabilities, while returning to Current design
recomputes Send, Tweaks, and pin capabilities from current state. Frame identity is
incarnation-local: a changed host `nonce` resets `frameSeq`, and no frame/query/token
comparison is valid without the full `(previewSessionId, nonce, sourceHash,
frameSeq)` tuple.

### 12.6 Page removal and geometry-backed pins

1. `page.removePlan` mints one UUIDv7 `pageRemovePlanId` and publishes the complete
   immutable plan without writing.
2. `page.removeConfirm` accepts only that id. Under the project-write mutex it
   compares the current source hash, exact ordered slug list/page-order hash,
   active-page/fallback facts, and plan revision before one transaction. Any drift
   returns `PLAN_STALE`; the UI cannot acknowledge away or replace plan facts.
3. `page.removeDiscardPlan` accepts only the active id and performs no project write.
4. A frame-stream item carries a Kernel-issued `FrameTokenV1`. After the UI displays
   it, the broker's typed acknowledgement makes that token the sole query-authorizing
   token for the live session; a newer acknowledgement invalidates it.
5. `preview.queryGeometry` verifies that frame token before any host request. A
   successful resolving `hit` or `pin-anchor` result causes the Kernel to mint a
   separate `GeometryTokenV1` from `(FrameIdentityV1, pageSlug, elementId, fx, fy)`.
6. `pin.create` accepts only that geometry token plus pin text. The Kernel matches the
   canonical ledger entry to the frame currently acknowledged as displayed and
   consumes it once; stale incarnation/session/source/frame rejects. The resulting
   `pins.changed` carries the complete affected `PinDtoV1`, including `pinId`.

### 12.7 Migration and startup recovery

`migration.planReady` mints the UUIDv7 `migrationPlanId`. `migration.confirm`
accepts that active plan id, mints a distinct UUIDv7 `migrationActionId`, and returns
the action id as `operationId`; later `migration.retryRecovery` accepts only that
same action id. It never accepts a transaction id or mints a replacement action id.

During project open, journal inspection first proves schema validity and durable
commit intent. `kernel.project.beginRecovery` then routes exactly one intended
Restore, ExportPublish, or Migration journal from that domain's `idle` state to
`recovering`. Journals with no intent are discarded. In a live Export or Migration
publication failure, `publishing -> failBeforeIntent -> idle` is legal only after
journal inspection proves no durable intent; otherwise the operation must enter
recovery and roll forward.

### 12.8 Trust refusal

An explicit trust refusal completes open as `ready` with
`trust: "untrusted-read-only"`. It keeps already-loaded read-only projections and
permits only the Kernel commands listed in §7.1; it neither transitions to `closed`
nor starts Gate, HostSupervisor, migration transformation, export, or any mutation.

## 13. Testing strategy

### 13.1 State-machine transition tables

For each of the seven models, table-driven tests enumerate every state/action pair:

- listed pairs assert target state, revision delta, emitted event kinds, and changed
  capabilities;
- unlisted pairs assert the exact rejection code, no state/revision change, and no
  domain event;
- same-state legal actions assert whether they are a real revision-changing update
  or an explicit no-op;
- project-open cases assert trust refusal ends in `ready/untrusted-read-only`, and
  each schema-valid intended Restore, ExportPublish, and Migration journal takes the
  owning model's exact `idle -> recovering` transition through
  `kernel.project.beginRecovery`;
- Export and Migration permit `publishing -> failBeforeIntent -> idle` only with a
  journal proof of no durable intent; an intended journal must recover instead;
- tests run in isolated Reatom contexts and assert all units have the required trace
  names.

### 13.2 Command boundary contracts

- **Direct command bypass:** send `turn.start`, chat, model, export, Restore, pin, and
  historical-mutation envelopes directly to the mailbox while illegal; each must
  reject even though no action-table predicate ran.
- **Stale revision:** every command family rejects stale expected revisions without
  side effects; `turn.cancel` alone follows the exact-turn permissive matrix.
- **Duplicates:** same id/same envelope while in flight and after completion returns
  the same result and operation id once; no extra transition/event/write occurs.
  Same id/different envelope rejects. Expired ids and capacity exhaustion never
  execute.
- **Capability/guard parity:** property tests generate legal model combinations and
  every exact `CapabilityTargetByKindV1` target, compare every projected capability
  with direct guard output, and verify primary reason priority. Exhaustive type/schema
  tests require `CapabilityId === CommandKindV1`, a target row for every command, and
  `capability: null` for every UI-local action; target snapshots reject user text,
  acknowledgement, raw input, dimensions/coordinates, fractions, and page-order
  permutations.
- **DTO round trip and closure:** every `CommandKindV1` has exactly one closed
  `CommandPayloadByKindV1` schema and target extractor, every `EventKindV1` has
  exactly one closed `EventPayloadByKindV1` schema, unknown discriminators/keys
  reject, and every command, result, event, capability reason, and error round-trips
  through the versioned serializer with no class/object identity. Golden tests cover
  exact `diagnostics.changed`, source-bound `page.descriptorsChanged`, complete
  migration correlations, and the sole circuit discriminator
  `preview.circuitOpened`.

### 13.3 Ordering and fencing

- `eventSeq` is strictly monotonic across state and progress events;
  `stateRevision` changes only for authoritative transitions and may repeat across
  several events.
- Events from one transition are contiguous; a snapshot reports the current event
  sequence and revision.
- Duplicate and rejected commands emit no duplicate domain events.
- Old `turnId`, old attempt, and old `leaseNonce` events are independently rejected;
  a matrix covers every one-field and multi-field mismatch.
- Cancellation does not reach `idle` until process-tree exit is confirmed, and a new
  turn cannot start earlier.
- Old `previewSessionId` signals and frames cannot replace the selected session.
  A matrix independently changes `previewSessionId`, host `nonce`, `sourceHash`, and
  incarnation-local `frameSeq`; every mismatch rejects frame-token geometry and
  geometry-token pin reuse, while a nonce change permits frame sequence to restart
  without identity collision. A frame token is unusable before display
  acknowledgement and stale after the next acknowledgement.

### 13.4 Domain concurrency and recovery

- **Commit during turn, commit wins:** commit records current design; later apply
  becomes uncommitted, unless hook drift produces the matching
  `APPLY_SOURCE_CHANGED` or `APPLY_STALE` without overwrite.
- **Commit during turn, apply wins:** old commit plan fails
  `COMMIT_PLAN_STALE` and requires reconfirmation.
- Commit scope capabilities remain independent of `TURN_RUNNING`; Send, `/new`,
  `/chats`, export, model, and Restore remain unavailable; local slash mode opens.
- Restore confirmation captures chat A; switching to chat B before execution/retry
  still writes exactly one action record to A and none to B.
- Duplicate `restore.confirm` returns the same `restoreActionId` and does not replace
  the source twice.
- Restore source/index/object drift before intent produces no write. Post-intent
  interruption recovers by roll-forward, including after restart. Planning invokes
  Gate/matching-host attestation once; confirmation only revalidates the stored
  source/runtime/policy bindings under the mutex and never invokes Gate again.
- Page removal plans use UUIDv7 ids and bind source hash, exact order/order hash,
  active/fallback page, and revision. Each bound-field drift rejects confirm with no
  write; discard clears only the matching active plan.
- Migration plan readiness mints one `migrationPlanId`; confirm mints one distinct
  `migrationActionId`, returns it as `operationId`, and duplicate confirm returns the
  same action id. Recovery retry accepts only that action id and never a transaction
  or plan id.
- Final apply resolves only captured pin ids on pages in non-empty `changedPages`. UI
  storage doubles are never called because no UI store port exists.
- Token-chain tests prove the non-cyclic path: a display-acknowledged `FrameTokenV1`
  authorizes geometry but never pin creation; only a successful resolving `hit` or
  `pin-anchor` response mints a distinct `GeometryTokenV1`; that geometry token plus
  text creates exactly one pin. Expiry, consumption, token substitution, or any
  current-displayed-frame identity mismatch rejects. `pins.changed` always contains
  the complete affected `PinDtoV1`, including the stable `pinId`.
- Export preparation holds a `ProjectWritePermit` only while capturing one coherent
  order/source/settings snapshot; rendering assertions prove no permit/mutex is held.
  Publication reacquires the mutex and revalidates that snapshot. Rendering failure
  publishes nothing; interrupted intended publication recovers to a complete package.

### 13.5 UI tests

- Action entries render labels/triggers/hints from the registry but enabled state is
  the conjunction of local applicability and mirrored Kernel capability.
- Focus/modal rules can hide or suppress a trigger but cannot enable a Kernel-blocked
  action.
- Turn-time slash mode shows `/commit-*` according to each Git scope and dims all
  required locked rows with typed hints.
- A Kernel rejection caused by state changing after render refreshes the mirror and
  displays the stable typed reason; the UI does not silently force a retry.
- `pins.changed`, not a local persistence call, drives resolved/reopened pin UI.
- Trust refusal keeps the project shell in ready read-only mode with loaded
  projections visible; execution/write commands are disabled with
  `PROJECT_UNTRUSTED`, while close and validated trust change remain available.

## 14. Acceptance criteria

- Every domain command enters the serialized Kernel mailbox and reaches state only
  through named Reatom model actions.
- Project, turn, Restore, commit, export, preview, and migration each have explicit tagged
  states, legal transition tables, trace names, and exhaustive transition tests.
- The UI action table contains presentation, trigger, hint, local applicability, and
  command-building metadata; it is not the sole or final lock authority.
- Commands carry protocol version, UUIDv7 id, expected revision, kind, and typed
  payload and return typed accepted/rejected results with stable codes.
- State revision and event sequence are independently monotonic according to §4;
  host frame ordering is separate.
- Duplicate ids cannot repeat a transition or write within the declared window, and
  unsafe expiry/capacity cases reject rather than execute.
- Stale commands reject, while stale exact-turn cancellation remains safe and
  permissive without cancelling a newer turn.
- `CapabilityId` is exactly the closed `CommandKindV1`; UI-local actions use
  `capability: null`, and every command has one exact non-sensitive target extractor.
  Kernel capabilities use typed unavailable reasons and are provably derived from
  the same guards and targets as direct dispatch.
- During a turn, ordinary Send, `/new`, `/chats`, export, model changes, and Restore
  are unavailable; local slash mode and `/commit-page`, `/commit-infra`, and
  `/commit-all` remain available according to Git scope.
- Actual commit and final apply serialize through the project-write mutex; neither
  network streaming nor Gate holds it.
- Export captures its coherent source/settings snapshot under a short
  `ProjectWritePermit`, renders outside the mutex, and reacquires the publication
  mutex for CAS, intent, and publication.
- Sent pins on changed pages are resolved only by the successful Kernel apply transaction, and the UI
  has no project-store write path.
- Backend events lacking the exact active `turnId`, attempt, and `leaseNonce` cannot
  affect state, events, chat, or apply.
- Restore durably preserves confirmation-time `targetChatId` and exactly-once
  `restoreActionId`; planning performs Gate/host attestation and confirmation only
  revalidates its bindings under the mutex. Commit execution independently
  revalidates plan freshness.
- Migration uses distinct UUIDv7 `migrationPlanId` and `migrationActionId`, returns
  the action id as confirm's `operationId`, and retries recovery only by action id.
- Startup routes valid intended Restore, ExportPublish, and Migration journals from
  `idle` to `recovering`; Export/Migration may fail from publishing to idle only with
  proof that no intent exists.
- Frame identities are incarnation-local. A display-acknowledged Kernel
  `FrameTokenV1` can authorize geometry only; successful resolving hit/pin geometry
  mints a separate current-frame `GeometryTokenV1`, and only that token plus text can
  create a pin. `pins.changed` returns complete affected-pin DTOs including `pinId`.
- Page removal is the plan/confirm/discard command family with a UUIDv7 plan bound to
  source hash, exact page order, active/fallback facts, and revision; no UI
  acknowledgement can replace freshness checks.
- Refusing trust leaves the project `ready` and untrusted/read-only; it does not
  close the project.
- Host, transaction, and process lifetime remains explicit in supervisors/services;
  no critical resource depends on a Reatom subscriber remaining connected.
- DTO encode/decode tests prove serializability and versioning, while docs and code
  make no claim that the in-process channel has daemon-grade IPC semantics.

## 15. Out of scope

- daemon process management, client authentication or authorization;
- reconnect, command retry across reconnect, event replay/resume, snapshots after
  gaps, and compatibility negotiation between independently deployed binaries;
- multiple clients, per-client capability views, conflict arbitration, distributed
  locking, and cross-machine command deduplication;
- changing the approved Git-history walk, commit scopes, explicit-confirmation
  policy, or prohibition on automatic commits and branch/ref management;
- changing the canonical page-source or immutable slug model;
- defining host protocol framing/frame encoding, durable transaction journal file
  layout, safe-filesystem algorithms, or storage-identity schemas owned by their
  respective production-hardening designs;
- using Reatom rollback as durable filesystem recovery;
- making the UI action table or a shared reactive graph an authorization boundary.

## 16. Supersession and integration

This document is the detailed design owned by §3.5 of
`2026-07-16-production-hardening-decisions-design.md`.

It supersedes the following older claims where they conflict:

- `2026-07-13-termcraft-design.md` §4.1 wording that the UI action table's
  availability predicate is the only place that checks a lock;
- the same section's claim that the current in-process command/event pair can simply
  become a wire protocol with no additional client/transport semantics;
- `docs/architecture/modules.md` wording that gives the UI action table sole domain
  availability ownership, gives the Kernel direct host-process ownership rather than
  HostSupervisor ownership, or permits direct UI-to-host process/protocol ownership;
- `docs/architecture/flows/chats.md`, `generation-turn.md`, and `versions.md` wherever
  they describe UI-derived locks as authoritative, unfenced reused staging, UI pin
  persistence, in-memory-only Restore recovery, or non-transactional final apply.

It preserves and depends on the Git-backed page-history design's canonical Current
design, first-parent history, exact commit scopes, explicit commit confirmations,
commit-during-turn availability, Restore `targetChatId`/`restoreActionId` semantics,
and prohibition on commit-to-chat correlation. It also preserves the production
hardening register's unique turn workspaces, immutable candidate, durable transaction
engine, safe filesystem boundary, runtime facade, local/portable state split, and
explicit resource owners.

Until the master spec and architecture flow documents are synchronized in a separate
authorized documentation task, this document governs command authority, state
machines, capability/guard behavior, command/event DTOs, revisions, sequencing,
deduplication, fencing, and the affected concurrency/recovery wording.
