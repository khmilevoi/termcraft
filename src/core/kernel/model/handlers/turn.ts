import { wrap } from "@reatom/core";

import type { TransitionOutcome, TurnAction, TurnState } from "core/machines";
import type { EventCorrelationV1, PublishableEventV1 } from "core/mailbox";
import type {
  AgentBackend,
  AgentPromptContextV1,
  AgentTask,
  ChangedPageOpV1,
  ReadSetAppendBaseV1,
  ReadSetFileSnapshotV1,
  ReasoningEffort,
  SessionPlan,
  StagingPageSourceV1,
  StagingService,
  TurnWorkspaceV1,
} from "core/ports";
import {
  type CommandPayloadByKindV1,
  type FailureDtoV1,
  type Sha256Hex,
  type UUIDv7,
  isOperationalFailureCode,
  isUuidv7,
} from "core/protocol";
import {
  type AdmissionCandidatePinV1,
  type AdmissionInputV1,
  type RunTurnDeps,
  type RunTurnFinalizeMaterialV1,
  type RunTurnInputV1,
  type RunTurnResultV1,
  type RunTurnValidationMaterialV1,
  type TurnCandidateV1,
  advanceSessionCheckpoint,
  createTurnDeadlines,
  evaluateSessionPlan,
  foldGateDiagnosticsIntoPrompt,
  runTurn,
} from "core/turns";
import type { ChatSelection } from "entities/chat";
import { type PageSlug, parsePageSlug } from "entities/page";
import { trace } from "infrastructure/debug-log";
import { uuidv7 } from "infrastructure/uuid";

import type {
  CommandOutcomeV1,
  FamilyHandlerMap,
  HandlerContext,
  SelectionSnapshotV1,
} from "./types";
import { completedOutcome, noOpOutcome, startedOutcome } from "./types";

/**
 * `turn.start` / `turn.cancel` — kernel-assembly WP-1 task 9, Step C2 (`turn.cancel`, real)
 * and Steps C3/Gap-4-closeout (this file: `turn.start`, now REAL end to end).
 *
 * `.superpowers/sdd/task9-family-turn-report.md` (the original NEEDS_CONTEXT investigation),
 * and `.superpowers/sdd/task-9-report.md`'s "Step C1"/"Step C2 turn"/"Step C3"/"Gap 4
 * closure" sections are read in full before this file. Step C1 closed Gap 1 in full
 * (`context.turnRunner.machine` is the SAME full `StateMachine<TurnState, TurnAction>`
 * `kernel.ts` holds) and built Gap 2's storage (`context.turnRunner.setActiveAttempt`/
 * `activeAttempt`). Step C2 made `turn.cancel` real end to end and found Gap 3. Step C3
 * closed Gap 3 at the ports layer (`StagingService.readCandidateFile`), built the
 * live-publish primitive (`HandlerContext.publishOperationEvent`) and the attempt-handle
 * producer hook (`RunTurnDeps.onAttemptStarted`) — then, composing `RunTurnInputV1.admission`
 * for real, found Gap 4: `AdmissionInputV1.workspace.readSet` needed a send-time chat
 * append-base and manifest hash+size no `core/ports` surface could honestly produce.
 *
 * GAP 4 — CLOSED. `core/ports/chat-store.ts`'s `ChatReader.readAppendBase(chatId)` and
 * `core/ports/project-store.ts`'s `ProjectStore.readManifestSnapshot()` (both port + fake
 * only, real adapters are WP-2's job) supply the two missing facts. `turn.start` below
 * composes `runTurn` for real using them.
 *
 * GAP 4 CLOSURE BUG, FOUND AND FIXED (§10 smoke closeout): the FIRST implementation of Gap
 * 4's closure read `readSet.chat` HERE, in this handler, BEFORE ever calling `runTurn` —
 * i.e. before `core/turns/model/admission.ts`'s own `runAdmission` durably appends this
 * exact turn's user record to that same chat. That stale, one-record-too-early baseline
 * then flowed verbatim into `finalizeTurn`'s own CAS precondition, which always found a
 * length/hash mismatch (`APPLY_STALE`/`chat`) — on EVERY real turn, not a corner case; no
 * real turn could ever commit through the composed graph. The honest chat append-base read
 * is NOT this handler's job at all: it now lives inside `runAdmission` itself
 * (`admission.ts`'s own header, step 1b), the only place that runs strictly between
 * `turnTransactions.admit(...)` and `staging.createTurnWorkspace(...)` and can therefore
 * observe the chat's state at the one honest moment. This handler only THREADS its own
 * `context.deps.chatReader` down through `RunTurnDeps.chatReader` (below) — it builds no
 * `readSet.chat` value of its own anymore.
 *
 * - `turn.cancel` is real, end to end (unchanged from Step C2/C3 — see the function's own
 *   doc comment below for the full citation).
 *
 * - `turn.start` composes `runTurn` (`core/turns`) inside ONE `launchOperation` closure
 *   (`runTurnStart`, below). Every piece of `RunTurnInputV1` this closure builds:
 *
 *   `AdmissionInputV1.targetChatId` and the agent's `backend`/`model`/`effort` triple: ALL
 *   FOUR are read asynchronously via `context.deps.projectStore.readWorkspaceState()`
 *   (`WorkspaceStateV1.activeChatId`/`backend`/`model`/`effort`). A `null` `activeChatId` is
 *   still an IDEMPOTENT REFUSAL (logged, resolved with zero events) — there is no honest
 *   default for "which chat," so this is unchanged from before WP-4.
 *
 *   WP-4 (default agent selection): MVP ships no `/model` picker (roadmap "Out of scope for
 *   MVP"), so a stored `backend`/`model`/`effort` triple that is entirely absent no longer
 *   refuses the turn on its own. `resolveStoredOrDefaultAgentTriple` (below) falls back to
 *   the SINGLE registered backend's own `BackendCapabilities.defaultSelection` — a real,
 *   backend-declared value (`claudeCapabilities()` declares `claude-sonnet-5`/`high`), never
 *   a fabricated one. Nothing is written to disk by this fallback: `workspace.local.toml`
 *   stays exactly as it was, and `model.select`'s own validate-and-persist path is untouched.
 *   The fallback itself still refuses (logged) if the registry is EMPTY (no default can be
 *   conjured from an empty catalog) or offers MORE THAN ONE backend (today's registry is
 *   Claude-only, per `agent-registry.ts`'s own "MVP ships exactly one entry" — a
 *   multi-backend registry has no picker-free way to choose among their defaults, so it
 *   refuses rather than silently guessing). A PARTIALLY-set triple (e.g. only `model` stored)
 *   is passed through unchanged to `resolveAgentSelection`'s own validation below, exactly as
 *   before — the fallback only fires when all three are absent. `effort` is narrowed from the
 *   durable plain string to the branded `ReasoningEffort` union by looking it up inside the
 *   matched model's own `BackendCapabilities.models[].efforts: readonly ReasoningEffort[]`
 *   array (`.find(e => e === effort)`) — cast-free, since the array's own element type is
 *   already `ReasoningEffort`. A resolved triple naming a `backend`/`model`/`effort` string
 *   the live `AgentRegistry` does not currently offer is still an IDEMPOTENT REFUSAL, exactly
 *   as before WP-4.
 *
 *   `pages: StagingPageSourceV1[]` / `readSet.canonicalPages`: one entry per
 *   `context.deps.pageReader.listSlugs()` result. Each page's `sourcePath` is built from
 *   `canonicalPageSourcePath(context.deps.projectStore.root, pageSlug)` (below): the CANONICAL
 *   absolute source, `` `${projectRoot}/.termcraft/pages/<slug>/page.tsx` `` (Gap G —
 *   `store/safe-fs/model/limits.ts:134-135`'s own prose, `store/transaction/model/wrappers.ts`'s
 *   `canonicalPagePath`) — NOT the flat `pages/<slug>.tsx` `core/turns/model/candidate.ts`'s own
 *   `PAGE_FILE_PATTERN` documents, which is `workspacePageRelPath`'s staged-workspace/candidate-
 *   relative convention instead. `readSet.canonicalPages`'s own `sha256`/`size` come from the
 *   SAME `PageReader.readSource(pageSlug)` call this handler makes to resolve that fact
 *   honestly (never fabricated) — a read failure for an already-*listed* page blocks admission
 *   with a logged refusal, since `null` on that entry would falsely claim "expected absence."
 *
 *   `manifestSlice: Uint8Array`: `JSON.stringify({pages: <the SAME listSlugs() result>,
 *   active: <workspaceState.activePageSlug>})`, UTF-8 encoded — the exact `ManifestSliceV1`
 *   shape (`core/ports/gate-runner.ts`) `pages.json` already carries.
 *
 *   `readSet.manifest`: `context.deps.projectStore.readManifestSnapshot()` — Gap 4's
 *   remaining new primitive this handler itself calls. A failure is an idempotent refusal
 *   (logged) — never a fabricated CAS baseline (this project's hardest rule: a false
 *   baseline defeats the exact concurrent-mutation check the read-set exists to catch).
 *   `readSet.chat` is NOT built here at all anymore (see "GAP 4 CLOSURE BUG" above) —
 *   `AdmissionWorkspaceMaterialV1.readSet` (`core/turns/types.ts`) excludes `chat` from
 *   what a caller may supply; `runAdmission` reads it itself, honestly, right after
 *   `admit()` commits, via the SAME `context.deps.chatReader` this handler threads through
 *   `RunTurnDeps.chatReader` below.
 *
 *   `runtimeDocs`: NOW REAL (phase-8 WP-3) — `context.deps.agentPromptSource.runtimeDocs()`
 *   (`core/ports/agent-prompt.ts`, implemented by `agent/prompt/`) returns the two files
 *   staged alongside `pages/`/`pages.json`: `runtime.d.ts` (the generated `@termcraft/runtime`
 *   ambient declaration, `runtime/generated/runtime.generated.d.ts`) and `RUNTIME.md` (the
 *   hand-authored guide). Both are ordinary files inside the installed package — under npm
 *   there is no startup staging step, only a path (phase-8 design §WP-3).
 *
 *   `candidatePins`: NOW REAL (Task 10 — kernel-command-contract §12.2 item 1: "captures ...
 *   only currently open, resolvable pins"). Folded live from
 *   `context.deps.pinReader.fold(activePageSlug)` — `WorkspaceStateV1.activePageSlug`, the
 *   SAME field `manifestSlice` already reads — right before `admission` is built. Only pins
 *   whose folded `status` is `"open"` become a `{pageSlug, pinId}` candidate; `resolveOpenPins`
 *   (`core/turns/model/admission.ts`) re-folds and re-checks the SAME page a moment later, at
 *   the only honest "send-time" instant, before committing any pin id into the chat's own
 *   `userRecord.pins` — this handler's own fold is the CANDIDATE step §12.2 names, never the
 *   final decision. A fold failure is a LOGGED, idempotent refusal (mirrors the
 *   `readManifestSnapshot` refusal just above it) — never a silently empty candidate list,
 *   which would look identical to "the user had no pins open." `activePageSlug === null` (no
 *   page currently selected) is handled honestly as "nothing to fold": an empty candidate
 *   list there means exactly that, not a refusal.
 *
 *   `readSet.pins` — NOW REAL (phase-8 WP-6, closing the gap this header used to document as
 *   "still an honest empty"): `PinReader.readAppendBase(pageSlug)` (`core/ports/pin-store.ts`)
 *   is now the direct pin-log analogue of `ChatReader.readAppendBase` (Gap 4's own precedent,
 *   above) — a real `core/ports` surface addition, port + fake only (the real adapter is
 *   `store/adapters/pin-store.ts`'s job), so this handler no longer needs to invent a
 *   serialization from `readEvents()`'s parsed events (the exact shortcut this header used to
 *   flag as rejected — it would not have matched the real store adapter's own on-disk
 *   append-base, silently defeating the concurrent-mutation check the read-set exists to
 *   catch). Read ONLY when `candidatePins` above actually gained an entry for the active
 *   page — a page that folds fine but has zero open pins never enters `readSet.pins` at all,
 *   mirroring turn-durability §7.2 step 4's "sent pins contributed context" (`core/turns/
 *   types.ts`'s own `AdmissionWorkspaceMaterialV1` header quotes the identical rule). A
 *   `readAppendBase` failure is a LOGGED, idempotent refusal, exactly like the `fold` failure
 *   just above it — never a silently empty `readSet.pins` entry, which would be
 *   indistinguishable from "this page had no open pins" and would leave
 *   `buildFinalizeCasPrecondition`'s `pins:<slug>` check disabled for exactly the turn that
 *   needed it (`store/transaction/model/wrappers.ts`'s own citation, unchanged from before).
 *
 *   `context.selection()`: read synchronously at the very top of `runTurnStart`, before any
 *   await, matching kernel-command-contract §12.2's "captures ... authoritative selection"
 *   — never from the payload, which carries none.
 *
 *   `baseTask.session: SessionPlan`: resolved via `evaluateSessionPlan` (`core/turns`) — phase-8
 *   WP-7, closing this file's own former "documented divergence" here. `workspaceIdentity` comes
 *   from `context.deps.projectStore.readManifest().projectId` — a SECOND call this handler now
 *   makes alongside its existing `readManifestSnapshot()` call just above (that one returns only
 *   `{sha256, size}`, `core/ports/staging.ts`'s `ReadSetFileSnapshotV1`, never the parsed DTO
 *   `projectId` lives on). A read failure is a LOGGED, idempotent refusal, in the exact shape as
 *   the `readManifestSnapshot`/pin-fold refusals elsewhere in this function — never a fabricated
 *   identity. `manifest.projectId` is the SAME value `core`'s own `runProjectReadySequence`
 *   (`handlers/project.ts:507,531,595`) already reads on every `project.open`/`project.create`,
 *   and the SAME value `entrypoint/model/create-shell.ts`'s `resolveEnvWithProjectIdentity`
 *   already threads into `UiEnv.workspaceIdentity` on every shell construction — so no new
 *   persisted field is needed (phase-8 WP-7's own design amendment: the original plan to persist
 *   a copy into `workspace.local.toml` was dropped once this direct read was confirmed to work on
 *   the SAME path `project.open` already takes; see the sub-plan's own "Amendment" section).
 *   `sessionScopeId` comes from `resolvedAgent.agentBackend.sessionScope({account: null, model,
 *   workspaceIdentity})` — `account` is a documented `null` literal, not a fresh `healthCheck()`
 *   call, because Claude's own probe (`agent/claude/backend/model/probe.ts`) returns
 *   `account: null` on EVERY branch today, so a fresh probe would report the identical `null` at
 *   the cost of one more round trip; wiring master §9's "checked ... before each send" health
 *   check into `turn.start` for real is a separate, larger gap this task does not close (see this
 *   plan's "Known softness"). **CROSS-RESTART RESUME REMAINS UNREACHABLE**: `deriveSessionScope`
 *   (`agent/session/model/session-scope.ts`) substitutes a fresh per-PROCESS
 *   `UNRESUMABLE_ACCOUNT` whenever `account` is `null`, which it always is for Claude — so
 *   `sessionScopeId` differs across every process restart regardless of `workspaceIdentity`, and
 *   `evaluateResume` honestly reports "fresh" every first turn of a new process. What resumes is
 *   the SECOND and later turn of the SAME process (storage-identity §6.2's own escape hatch: "a
 *   backend that cannot supply a stable account ... returns a fresh scope for each process, which
 *   safely disables cross-process resume for that backend").
 *
 *   `baseTask.systemPrompt`: NOW REAL (phase-8 WP-3) — `context.deps.agentPromptSource
 *   .systemPrompt(promptContext)`, where `promptContext: AgentPromptContextV1` is built just
 *   above from facts this handler already holds honestly: `activePageSlug`/`pageSlugs` (the
 *   SAME `WorkspaceStateV1.activePageSlug` and `pageReader.listSlugs()` result the manifest
 *   slice above already reads), `kitApiVersion` from `context.deps.exportRender
 *   .runtimeDeclaration.currentKitApiVersion` (the SAME already-wired constant
 *   `ExportRenderPort` carries — no new `KernelDeps` field needed), and `openPins` folded in
 *   the SAME loop that builds `candidatePins` just above, from the SAME `PinReader.fold`
 *   result — never a second port call, never a fabricated pin text. `agent/prompt/`
 *   (implementing `core/ports/agent-prompt.ts`) owns the prose: role, §5.8's design-code
 *   rules including the slug mask, the page-file layout, and answer-style guidance — `core`
 *   imports only the port, never `agent/prompt/` itself. NOTE: `agent/session/model/
 *   prompt.ts`'s `buildPrompt` is a DIFFERENT function entirely — it composes the per-attempt
 *   USER message (a resume delta, or the fresh-session seed transcript), never the system
 *   prompt; the two were never in conflict.
 *
 *   `buildValidationInput`/`buildFinalizeInput`: both are SYNCHRONOUS per `RunTurnInputV1`'s
 *   own signature, but the only honest source of a frozen candidate's byte content —
 *   `StagingService.readCandidateFile` — is async. `createContentCachingStaging` (below)
 *   resolves this without touching `core/turns`: it wraps `context.deps.staging` so that the
 *   MOMENT `snapshotToCandidate` resolves (already an awaited step inside `runTurn`'s own
 *   loop), every one of the frozen candidate's files is read back through the REAL
 *   `readCandidateFile` port call and cached by `(root, relPath)` — never fabricated bytes,
 *   just fetched slightly earlier than the two synchronous builders need them. A
 *   `readCandidateFile` failure during that eager read is propagated as `snapshotToCandidate`'s
 *   own failure, so `freezeTurnCandidate` (`core/turns`) sees it exactly as if the read had
 *   failed inline — no new failure shape invented.
 *
 *   LIVE EVENTS: `RunTurnDeps.publish` maps onto `context.publishOperationEvent`
 *   (Step C3's live-publish primitive) — `turn.attemptStarted`/`turn.progress`/
 *   `turn.gateRejected` stream AS THEY HAPPEN. `context.setActiveTurnId` no longer fires from
 *   inside this wrapper (fix-bundle spec §1.2) — `beginTurn` (below) records the id
 *   synchronously, alongside the `idle -> admitting` transition, BEFORE `runTurnStart` (and
 *   therefore this whole `runTurn` composition) is ever launched. The first `turn.attemptStarted`
 *   this wrapper observes still marks when `turn.started` synthesizes and publishes (see "TURN.
 *   STARTED — NOW PUBLISHED" below), just not when the active turn id is set. `setActiveTurnId(null)`
 *   still runs once `runTurn`'s own result is `terminalized`/`finalized`; `admission-rejected` is
 *   Task 4's job (fix-bundle spec §1.3/§1.4) — this task does not clear it on that branch.
 *
 *   TURN.STARTED — NOW PUBLISHED (was: "deliberately not published"; corrected per
 *   fixlane-K1-turn-spine.json's seam finding, votes 3/notRefuted 3): `ui/mirror/model
 *   /mirror.ts`'s own `case "turn.started"` is the ONLY transition that moves `TurnMirror`
 *   into `"running"` — every later `turn.attemptStarted`/`turn.progress`/`turn.gateRejected`
 *   the mirror applies is gated on `phase === "running"` already, so treating the first
 *   `turn.attemptStarted` as sufficient proof (this file's prior design) left the mirror
 *   permanently `"idle"` for the WHOLE turn: no streamed reasoning/tool steps, no gate-retry
 *   lines, and (via `actionContext.turnRunning`) no working Esc-to-cancel. `publish` (below)
 *   now synthesizes and sends a schema-valid `PublishableEventV1<"turn.started">` —
 *   `{turnId, chatId: activeChatId, deadline}` (`event-payload.ts`'s `TurnStartedPayloadV1`) —
 *   the MOMENT it observes the first `turn.attemptStarted`, strictly BEFORE forwarding that
 *   event itself. `deadline` is the SAME non-resettable absolute bound `attempt.ts` already
 *   computed for that `turn.attemptStarted` (`deps.deadlines.absoluteDeadlineAt()`), reused
 *   verbatim rather than recomputed a second time. `chatId` is `activeChatId`, the SAME
 *   send-time target this closure resolved from `workspaceState` before admission ever began.
 *
 *   THE ATTEMPT-HANDLE SLOT: `RunTurnDeps.onAttemptStarted` maps directly onto
 *   `context.turnRunner.setActiveAttempt` — the REAL handle `onAttemptStarted` hands over
 *   (never a separately hand-wrapped copy — see `run-turn.ts`'s own doc comment for exactly
 *   why that matters for `attempt.ts`'s internal `cancelRequested` coordination), closing
 *   Gap 2's remaining producer side: `turn.cancel`'s own `handle.requestCancel()` (below)
 *   now reaches the SAME `attempt.ts`-coordinated cancel path `startTurnAttempt` returns.
 *
 *   THE COMMIT-INTENT BIT — NOW WIRED (corrected per fixlane-K1-turn-spine.json's kernel
 *   finding): `RunTurnDeps.onCommitIntentRecorded` maps onto `context.setCommitIntentRecorded`
 *   — the ONE legitimate caller `handlers/types.ts`'s own `HandlerContext` doc names ("the
 *   turn finalize/terminalize path that records or clears durable commit intent"). Before
 *   this wiring, NO production handler ever called it, so `kernel.ts`'s own
 *   `commitIntentRecordedAtom` was permanently `false` — both `revision-guard.ts`'s
 *   `durableIntentRecorded` and `capabilities/model/guards.ts`'s `commitIntentRecorded` (§8.4
 *   rule 6 / §7.2's "in finalizing after durable intent, cancellation is forbidden") had their
 *   forbidding branch dead in every real Kernel. `runTurn` calls the hook with `true` the
 *   moment `turnTransactions.finalize` durably confirms a commit (`run-turn.ts`'s own doc
 *   comment on the hook has the exact timing and its one honest limitation: the underlying
 *   store gives no mid-flight signal, so this can only ever be recorded post-hoc, once
 *   `finalizeTurn`'s own promise resolves — never in time to prevent the documented pre-intent
 *   cancel race itself, only to record that a commit genuinely happened). This handler clears
 *   it back to `false` UNCONDITIONALLY once `runTurn` resolves (mirroring
 *   `setActiveTurnId(null)` just above it), so the bit never leaks `true` into a LATER,
 *   unrelated turn's own `finalizing` phase.
 *
 *   THE TERMINAL EVENT: once `runTurn` resolves, the ONE terminal batch event this operation
 *   returns is built from `RunTurnResultV1`:
 *   - `"finalized"` + `result.kind === "committed"` -> `turn.completed` with `outcome:
 *     "completed"`, the changed-page hashes and Gate warnings captured (by side channel)
 *     during the LAST `buildFinalizeInput` call, and `failure: null`.
 *   - `"terminalized"` (cancelled, Gate-exhausted, deadline-exceeded, backend failure, a
 *     finalize CAS/deadline failure, OR a finalize `illegal` result AFTER a durable commit
 *     already landed — a raced concurrent cancel most likely won the pre-intent window — all
 *     now bridged into `terminalizeTurn` by `run-turn.ts` itself — see that file's own header,
 *     "FINALIZE FAILURES DO BRIDGE"/"`{kind:\"illegal\"}` ALSO BRIDGES" — so neither
 *     `{kind:"finalized", result:{kind:"failed"}}` NOR `{kind:"finalized",
 *     result:{kind:"illegal"}}` is a reachable `RunTurnResultV1` shape at all, ...): the wire
 *     `outcome` field itself still only ever publishes `"failed"` for every one of these
 *     causes — widening IT would misrepresent a guess as spec-fixed fact (§7.2 fixes the
 *     `cancelled`/`failed`/`stale`/`interrupted` vocabulary verbatim), so this driver never
 *     tries. What CAN be, and now is, more precise is `failure`, the DTO alongside it — see
 *     "GATE-EXHAUSTION-VS-BACKEND-FAILURE — CLOSED" below.
 *
 *     ONE SUB-CASE WAS TYPED FIRST, NOT FABRICATED (WP-8 item 4, phase-8 design's
 *     documented-debt sweep — "Generic `turn.failed`, a typed outcome instead of the
 *     catch-all"): `TerminalizeTurnResultV1`'s `"unrecorded"` variant means
 *     `terminalizeTurn`'s own append of the terminal chat record ITSELF failed
 *     (turn-durability §7.5: "If even that append cannot be made safely, the UI reports the
 *     unrecorded stale turn and startup orphan recovery retries terminalization") — and that
 *     variant already carries a REAL `FailureDtoV1`, produced by
 *     `turnTransactions.terminalize`'s own adapter (`store/adapters/turn-transactions.ts`'s
 *     `toFailureDto`), never a placeholder. `terminalFailureDto` (below) propagates that DTO
 *     verbatim as `turn.failed`'s own `failure` field instead of discarding it for the
 *     generic bucket — unchanged by this task.
 *
 *     GATE-EXHAUSTION-VS-BACKEND-FAILURE — CLOSED (this task's own follow-up to WP-8 item 4):
 *     every OTHER branch — `"recorded"` (an ordinary terminal chat record WAS durably written,
 *     whatever its real cause), the defensive `"illegal"` case, and the two
 *     practically-unreachable `"finalized"` cases above — USED TO get the SAME generic
 *     `PERSISTENCE_FAILED` DTO regardless of cause, which is why a Gate-exhausted turn and a
 *     backend-failed turn published byte-identical `turn.failed` payloads: both land on
 *     `"recorded"`, and `"recorded"` used to carry no further breakdown at all.
 *     `core/turns/model/terminalize.ts`'s `TerminalizeTurnResultV1` now echoes back the
 *     ORIGINALLY REQUESTED `TurnTerminalOutcome` and `TerminalizeTurnInputV1.reason` on BOTH
 *     the `"recorded"` and `"unrecorded"` variants, never discarded. `run-turn.ts` already
 *     passed a real, closed `OperationalFailureCode` as `reason` for several call sites before
 *     this task (Gate exhaustion's own `"GATE_RETRY_EXHAUSTED"`; a finalize CAS/deadline
 *     failure's own `FailureDtoV1.code`, e.g. `"TURN_DEADLINE_EXCEEDED"`/`"PERSISTENCE_FAILED"`);
 *     the one gap was the agent-backend-failure call site (`outcome.kind === "failed"` in
 *     `run-turn.ts`'s retry loop), which passed `reason: undefined` — now `"BACKEND_FAILED"`,
 *     the code the vocabulary already reserved for exactly this (that call site's own comment).
 *     `terminalFailureDto` (below) narrows the echoed `reason` with `isOperationalFailureCode`
 *     — a TYPED discriminant, never a string match on `safeMessage` prose (fragile: a reworded
 *     message would silently break a prose match, where a closed code union cannot) — and uses
 *     it as this failure's `code` when it recognizes one THAT ITS OWN WIRE SCHEMA ALSO ACCEPTS
 *     WITH BARE `details`: `"APPLY_SOURCE_CHANGED"`/`"APPLY_STALE"` are excluded even though
 *     they ARE real operational-failure codes a finalize CAS failure can legitimately pass as
 *     `reason` — their own schema variants require a typed `details.part` this layer only has
 *     the bare code string for, never the original detail (`terminalFailureDto`'s own
 *     `FAILURE_CODES_NEEDING_TYPED_DETAILS`, below). Every other unusable `"recorded"` reason
 *     (e.g. `undefined`, or a `CommandRejectionCode` from the disjoint command-rejection
 *     vocabulary such as `"TURN_ALREADY_ACTIVE"`) still falls back to the generic
 *     `PERSISTENCE_FAILED` bucket exactly as before — nothing invented for causes this
 *     composition genuinely cannot distinguish (the attempt-budget/deadline/gate-fold-error
 *     call sites, none of which pass a typed `reason` today). `"unrecorded"`'s REAL
 *     adapter-level `FailureDtoV1` still wins outright over the echoed reason: that failure
 *     describes something more specific (the append itself broke) than why the turn
 *     terminalized in the first place.
 *
 *     A widened `TurnTerminalPayloadV1` (a brand-new wire field distinguishing
 *     recorded/unrecorded, or Gate-exhaustion/backend-failure) was considered and rejected —
 *     unchanged reasoning from WP-8 item 4: `TurnTerminalPayloadV1` is a `z.strictObject`
 *     shared verbatim by `turn.completed`/`turn.failed`/`turn.cancelled` and is constructed as
 *     typed literals in `ui/app`/`ui/workspace` test fixtures this task does not own — a new
 *     REQUIRED field there ripples into files outside this task's scope, and an optional field
 *     would break `event-payload.ts`'s own "nullable, never optional" convention for a payload
 *     the KCC spec already fixes verbatim (§9). Enriching the EXISTING `failure` field's VALUE,
 *     as done here, needs no schema change AND touches no such fixture at all: neither
 *     `GATE_RETRY_EXHAUSTED` nor `BACKEND_FAILED` appears in any `ui/app`/`ui/workspace` test
 *     literal today, and `event-payload.test.ts`'s own closure test already proved every code
 *     this can now produce round-trips `turn.failed`'s wire schema.
 *
 * HARD RULES OBSERVED: no cast anywhere; `wrap()` at the async boundary inside `turn.cancel`'s
 * `launchOperation` closure AND at the outer boundary `launchOperation` itself wraps
 * `runTurnStart` (Step C's own `kernel.ts` implementation) — every port call inside
 * `runTurnStart` is itself `await wrap(...)`-ed, matching `admission.ts`'s identical rule
 * (code after each await touches `context`, a Reatom-adjacent read); no module-level mutable
 * state (every fact this file reads/writes lives on `context`, or in a `run`-closure-local
 * variable scoped to one `turn.start` dispatch); `turn.cancel` composes
 * `context.machines.turn`/`context.turnRunner` verbatim, never reimplementing the turn
 * machine's own transition table; `turn.start` composes `runTurn` verbatim, never
 * reimplementing admission/attempt/validation/finalize/terminalize.
 */

// --- Shared: `kernel.stateChanged` construction for a real turn-machine transition ---------

function turnStateChangedEvent(
  action: `kernel.turn.${TurnAction}`,
  outcome: Extract<TransitionOutcome<TurnState, TurnAction>, { kind: "changed" }>,
  correlation: EventCorrelationV1,
): PublishableEventV1<"kernel.stateChanged"> {
  return {
    kind: "kernel.stateChanged",
    payload: {
      modelId: "kernel.turn.state",
      action,
      previousTag: outcome.from,
      nextTag: outcome.to,
      metadata: {},
    },
    correlation,
  };
}

// --- turn.start — real, composing `runTurn` ------------------------------------------------

/**
 * The agent WORKSPACE's own flat page-file convention (`store/sandbox/model/staging-store.ts`'s
 * `stageAllFiles`, transcribed by `core/turns/model/candidate.ts`'s `PAGE_FILE_PATTERN`):
 * `pages/<slug>.tsx`, relative to a STAGED workspace or candidate root — never to the project
 * root. Named for its namespace after Gap G, where the un-namespaced old name (`pageFileRelPath`)
 * let the same helper be joined onto `projectStore.root` and produce a path that does not exist.
 */
function workspacePageRelPath(pageSlug: PageSlug): string {
  return `pages/${pageSlug}.tsx`;
}

/** The directory canonical project state lives in, under the project root (storage-identity §4). */
const PROJECT_STATE_DIRNAME = ".termcraft";

/**
 * CANONICAL page storage, absolute: `<projectRoot>/.termcraft/pages/<slug>/page.tsx`.
 * `store/safe-fs/model/limits.ts:134-135` states the rule in prose ("deliberately NOT the
 * agent's flat `pages/<slug>.tsx` shape") and `store/transaction/model/wrappers.ts`'s
 * `canonicalPagePath` is its `.termcraft`-relative half. `core` may not import `store`, so the
 * convention is transcribed here rather than shared — the same way `./preview-export.ts` already
 * names `.termcraft/export` for its own destination.
 */
function canonicalPageSourcePath(projectRoot: string, pageSlug: PageSlug): string {
  return `${projectRoot}/${PROJECT_STATE_DIRNAME}/pages/${pageSlug}/page.tsx`;
}

const MANIFEST_SLICE_REL_PATH = "pages.json";

/**
 * Wraps a real `StagingService` so the frozen candidate's own byte content is available
 * SYNCHRONOUSLY to `buildValidationInput`/`buildFinalizeInput` (both fixed synchronous
 * signatures on `RunTurnInputV1`) without fabricating anything — see this file's header for
 * the full reasoning. Every file `snapshotToCandidate` reports is read back through the base
 * port's own `readCandidateFile` the moment freezing succeeds (an already-awaited step
 * inside `runTurn`'s own loop), cached by `(root, relPath)`; a read failure there is
 * propagated as `snapshotToCandidate`'s own failure, exactly like an inline read failure
 * would be.
 *
 * Spreads `base`'s other four methods unchanged (`createTurnWorkspace`/`retireWorkspace`/
 * `readCandidateFile`/`retireCandidate`) — safe because every `StagingService` in this ring
 * (today's fakes, and any adapter following the same closure-factory convention every other
 * port fake/adapter in this codebase uses) is plain closures over its own factory-local state,
 * never a class instance whose methods read `this`.
 */
interface ContentCachingStagingV1 {
  readonly staging: StagingService;
  readonly readCandidateBytes: (root: string, relPath: string) => Uint8Array | null;
}

function createContentCachingStaging(base: StagingService): ContentCachingStagingV1 {
  const cache = new Map<string, Uint8Array>();

  function cacheKey(root: string, relPath: string): string {
    return `${root} ${relPath}`;
  }

  async function snapshotToCandidate(
    workspace: TurnWorkspaceV1,
  ): ReturnType<StagingService["snapshotToCandidate"]> {
    const candidate = await base.snapshotToCandidate(workspace);
    if ("code" in candidate) return candidate;

    for (const file of candidate.files) {
      const bytes = await base.readCandidateFile(candidate.root, file.relPath);
      if ("code" in bytes) return bytes;
      cache.set(cacheKey(candidate.root, file.relPath), bytes);
    }
    return candidate;
  }

  return {
    staging: { ...base, snapshotToCandidate },
    readCandidateBytes: (root, relPath) => cache.get(cacheKey(root, relPath)) ?? null,
  };
}

/** Decodes cached candidate bytes as UTF-8, logging (never throwing) on an unreachable cache miss — the caching wrapper above already blocks admission before either builder below is ever called if any candidate file's read genuinely fails. */
function decodeCachedUtf8(
  cachingStaging: ContentCachingStagingV1,
  root: string,
  relPath: string,
): string {
  const bytes = cachingStaging.readCandidateBytes(root, relPath);
  if (bytes === null) {
    console.warn(
      `core/kernel/handlers/turn: no cached candidate content for "${relPath}" under "${root}" — defensive, should be unreachable (the caching wrapper reads every file eagerly at freeze time)`,
    );
    return "";
  }
  return new TextDecoder().decode(bytes);
}

/** The one live agent selection this turn will run against — `null` is always an honest, logged refusal, never a fabricated default. */
interface ResolvedAgentSelectionV1 {
  readonly backendId: string;
  readonly model: string;
  readonly effort: ReasoningEffort;
  readonly agentBackend: AgentBackend;
}

/** The `(backend, model, effort)` triple this turn resolves against, before catalog validation. */
interface StoredOrDefaultAgentTripleV1 {
  readonly backend: string;
  readonly model: string;
  readonly effort: string;
}

/**
 * WP-4 (default agent selection — see this file's header for the full rationale): returns
 * `stored` unchanged whenever ANY of its three fields is already set (including a partially
 * set triple, which `resolveAgentSelection` below still validates and can still refuse).
 * Falls back to the single registered backend's `BackendCapabilities.defaultSelection` only
 * when ALL THREE are absent. Refuses (logged, `null`) when the registry cannot honestly
 * supply exactly one default: zero registered backends, or more than one with no picker to
 * choose between them (MVP registers Claude only — `agent-registry.ts`'s own "MVP ships
 * exactly one entry" — so this branch is a documented guard against a future registry shape,
 * not a case this build can exercise).
 */
function resolveStoredOrDefaultAgentTriple(
  context: HandlerContext,
  stored: {
    readonly backend: string | null;
    readonly model: string | null;
    readonly effort: string | null;
  },
): StoredOrDefaultAgentTripleV1 | null {
  if (stored.backend !== null && stored.model !== null && stored.effort !== null) {
    return { backend: stored.backend, model: stored.model, effort: stored.effort };
  }

  const registered = context.deps.agentRegistry.list();
  if (registered.length === 0) {
    console.warn(
      "core/kernel/handlers/turn: turn.start refused — no agent selection stored and no backend registered to default from",
    );
    return null;
  }
  if (registered.length > 1) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — no agent selection stored and ${registered.length} backends are registered; MVP has no picker to choose a default among them`,
    );
    return null;
  }
  const [only] = registered;
  if (only === undefined) {
    // Unreachable given the length checks above (`=== 0` and `> 1` both returned already, so
    // exactly one element remains) — kept explicit per this project's "never silently assume
    // success" rule.
    console.warn(
      "core/kernel/handlers/turn: turn.start refused — registry reported one backend but yielded none on read",
    );
    return null;
  }
  return {
    backend: only.backendId,
    model: only.defaultSelection.model,
    effort: only.defaultSelection.effort,
  };
}

function resolveAgentSelection(
  context: HandlerContext,
  backendId: string,
  model: string,
  effort: string,
): ResolvedAgentSelectionV1 | null {
  const capabilities = context.deps.agentRegistry.list().find((b) => b.backendId === backendId);
  if (capabilities === undefined) {
    console.warn(`core/kernel/handlers/turn: turn.start refused — unknown backend "${backendId}"`);
    return null;
  }
  const modelCapability = capabilities.models.find((m) => m.model === model);
  if (modelCapability === undefined) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — backend "${backendId}" does not offer model "${model}"`,
    );
    return null;
  }
  const resolvedEffort = modelCapability.efforts.find((e) => e === effort);
  if (resolvedEffort === undefined) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — model "${model}" does not offer effort "${effort}"`,
    );
    return null;
  }
  const agentBackend = context.deps.agentRegistry.get(backendId);
  if (agentBackend === null) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — registry lost backend "${backendId}" between list() and get()`,
    );
    return null;
  }
  return { backendId, model, effort: resolvedEffort, agentBackend };
}

/** Captured once, from the LAST `buildFinalizeInput` call, so the terminal `turn.completed` event can report what actually changed without re-deriving it a second time. */
interface FinalizeSummaryV1 {
  readonly changedPages: readonly { readonly pageSlug: PageSlug; readonly sourceHash: Sha256Hex }[];
  readonly gateWarnings: readonly { readonly kind: string; readonly message: string }[];
}

function terminalChangedPagesFromCandidate(
  candidate: TurnCandidateV1,
): readonly { readonly pageSlug: PageSlug; readonly sourceHash: Sha256Hex }[] {
  const changed: { pageSlug: PageSlug; sourceHash: Sha256Hex }[] = [];
  for (const change of candidate.changes) {
    if (change.change === "removed" || change.sha256 === null) continue;
    changed.push({ pageSlug: change.pageSlug, sourceHash: change.sha256 });
  }
  return changed;
}

/**
 * `context.selection()` returns the WIDER `SelectionSnapshotV1` (`{pageSlug: string,
 * elementId, sourceHash}` — `selection-model.ts`'s own render-facing DTO), not
 * `entities/chat`'s narrower `ChatSelection` (`{pageSlug: PageSlug, element}`)
 * `AdmissionInputV1.selection` needs — field names differ (`elementId` vs `element`) and
 * `sourceHash` has no home on `ChatSelection` at all. `pageSlug` is RE-VALIDATED via
 * `parsePageSlug` (never blindly cast back to the branded type) because
 * `EventPayloadByKindV1["selection.changed"]` types it as a plain `string` — the value was
 * already a real `PageSlug` when captured, so a genuine parse failure here is defensive
 * only (logged, selection dropped for this turn — never fatal to sending the message).
 */
function toAdmissionSelection(selection: SelectionSnapshotV1 | null): ChatSelection | null {
  if (selection === null) return null;
  const pageSlug = parsePageSlug(selection.pageSlug);
  if (pageSlug instanceof Error) {
    console.warn(
      `core/kernel/handlers/turn: turn.start dropped an unparseable selection page slug "${selection.pageSlug}": ${pageSlug.message}`,
    );
    return null;
  }
  return { pageSlug, element: selection.elementId };
}

/**
 * The two `OperationalFailureCode`s whose OWN wire schema demands more than the general
 * bounded-`details` shape (`core/protocol/model/failure.ts`'s `applySourceChangedFailureSchema`/
 * `applyStaleFailureSchema` — each requires a typed `details.part`). `TerminalizeTurnResultV1`
 * only echoes back a bare `reason: string`, never the typed detail that produced it, so
 * `terminalFailureDto` below cannot honestly reconstruct either shape — reusing the code with
 * an empty `details` would build a `FailureDtoV1` `turnTerminalPayloadV1Schema` itself rejects.
 * Excluded from reuse, not silently risked.
 */
const FAILURE_CODES_NEEDING_TYPED_DETAILS: ReadonlySet<string> = new Set([
  "APPLY_SOURCE_CHANGED",
  "APPLY_STALE",
]);

/**
 * `turn.failed`'s `failure` DTO for every `RunTurnResultV1` that did not commit — this file's
 * header, "GATE-EXHAUSTION-VS-BACKEND-FAILURE — CLOSED". `"unrecorded"`'s REAL adapter-level
 * `FailureDtoV1` always wins first (unchanged from WP-8 item 4). Otherwise, a `"recorded"`
 * result's echoed `TerminalizeTurnResultV1.reason` (`core/turns/model/terminalize.ts`) becomes
 * this failure's `code` when — and only when — `isOperationalFailureCode` recognizes it as a
 * real, closed `OperationalFailureCode` NOT in {@link FAILURE_CODES_NEEDING_TYPED_DETAILS}: a
 * TYPED discriminant, never a match on `safeMessage` prose. Every other case (no reason, an
 * unrecognized one, one needing typed details this layer does not have, or the defensive
 * `"illegal"`/practically-unreachable `"finalized"` branches) falls back to the same generic
 * `PERSISTENCE_FAILED` bucket this file has always used — nothing invented for a cause this
 * composition genuinely cannot distinguish.
 */
function terminalFailureDto(result: RunTurnResultV1, branch: string): FailureDtoV1 {
  if (result.kind === "terminalized" && result.result.kind === "unrecorded") {
    return result.result.failure;
  }
  const reason =
    result.kind === "terminalized" && result.result.kind === "recorded"
      ? result.result.reason
      : undefined;
  const code =
    reason !== undefined &&
    isOperationalFailureCode(reason) &&
    !FAILURE_CODES_NEEDING_TYPED_DETAILS.has(reason)
      ? reason
      : "PERSISTENCE_FAILED";
  return {
    code,
    retryable: false,
    safeMessage: `the turn ended without committing (${branch})`,
    details: {},
  };
}

/**
 * The whole `turn.start` composition, run inside `launchOperation`'s own async closure (see
 * this file's header for the full recipe). Every port call is `await wrap(...)`-ed — code
 * after each await calls `context.publishOperationEvent`/`context.setActiveTurnId`, both of
 * which touch Reatom-adjacent state built inside `kernel.ts`'s own `context.start(...)` frame.
 */
async function runTurnStart(
  turnId: UUIDv7,
  text: string,
  context: HandlerContext,
): Promise<readonly PublishableEventV1[]> {
  // Captured synchronously, before any await — kernel-command-contract §12.2's "captures
  // the authoritative selection" at the moment admission begins.
  const selection = toAdmissionSelection(context.selection());

  // DIAGNOSTIC (infrastructure/debug-log): this function is a chain of `await wrap(...)` port
  // reads, and a live run showed `turn.start` accepted followed by total silence — no event, no
  // console line, no disk write, no agent process. Every REFUSAL below logs; a stall inside an
  // await logs nothing at all. These step markers are what separate the two.
  trace("kernel.turnStart", { step: "entry" });

  const workspaceState = await wrap(context.deps.projectStore.readWorkspaceState());
  trace("kernel.turnStart", { step: "readWorkspaceState done" });
  if ("code" in workspaceState) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — could not read workspace state: ${workspaceState.safeMessage}`,
    );
    return [];
  }
  const { activeChatId, backend, model, effort, activePageSlug } = workspaceState.state;

  // DIAGNOSTIC: a live run stopped between the marker above and the one below `resolveAgentSelection`,
  // with NO console line — even though every refusal in that span is supposed to log. Record the raw
  // inputs and each resolver's verdict so the next run names the exact branch instead of narrowing it.
  trace("kernel.turnStart", {
    step: "workspaceState read ok",
    stored: { backend, model, effort },
    activeChatId,
    activePageSlug,
    registryLength: context.deps.agentRegistry.list().length,
    registryIds: context.deps.agentRegistry.list().map((b) => b.backendId),
  });

  if (activeChatId === null) {
    console.warn("core/kernel/handlers/turn: turn.start refused — no active chat yet");
    return [];
  }
  // A fresh, explicitly-typed `const`: `publish` below is a nested closure, and TypeScript
  // does not carry the null-check narrowing above into nested function bodies — re-binding
  // the already-narrowed value here (never reassigned) sidesteps that cleanly, no cast needed.
  const admittedChatId: string = activeChatId;

  const agentTriple = resolveStoredOrDefaultAgentTriple(context, { backend, model, effort });
  trace("kernel.turnStart", { step: "agentTriple resolved", agentTriple });
  if (agentTriple === null) return [];

  const resolvedAgent = resolveAgentSelection(
    context,
    agentTriple.backend,
    agentTriple.model,
    agentTriple.effort,
  );
  trace("kernel.turnStart", {
    step: "resolveAgentSelection returned",
    isNull: resolvedAgent === null,
  });
  if (resolvedAgent === null) return [];

  trace("kernel.turnStart", { step: "agent selection resolved" });

  const manifestSnapshot = await wrap(context.deps.projectStore.readManifestSnapshot());
  trace("kernel.turnStart", { step: "readManifestSnapshot done" });
  if ("code" in manifestSnapshot) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — could not read project.toml's snapshot: ${manifestSnapshot.safeMessage}`,
    );
    return [];
  }

  // WP-7: a SECOND, different call to the SAME port — `readManifestSnapshot` above returns
  // only `{sha256, size}` (the CAS read-set baseline), never the parsed `projectId` this
  // handler's own `sessionScopeId` needs below. A failure here is a LOGGED, idempotent
  // refusal, in the exact shape as the read above — never a fabricated `workspaceIdentity`.
  const manifest = await wrap(context.deps.projectStore.readManifest());
  trace("kernel.turnStart", { step: "readManifest done" });
  if ("code" in manifest) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — could not read project.toml's manifest for its workspaceIdentity: ${manifest.safeMessage}`,
    );
    return [];
  }

  const pageSlugs = await wrap(context.deps.pageReader.listSlugs());
  trace("kernel.turnStart", { step: "listSlugs done" });
  if ("code" in pageSlugs) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — could not list page slugs: ${pageSlugs.safeMessage}`,
    );
    return [];
  }

  const pages: StagingPageSourceV1[] = [];
  const canonicalPages: { pageSlug: PageSlug; snapshot: ReadSetFileSnapshotV1 | null }[] = [];
  for (const pageSlug of pageSlugs) {
    const source = await wrap(context.deps.pageReader.readSource(pageSlug));
    if ("code" in source) {
      console.warn(
        `core/kernel/handlers/turn: turn.start refused — could not read canonical page "${pageSlug}": ${source.safeMessage}`,
      );
      return [];
    }
    pages.push({
      pageSlug,
      sourcePath: canonicalPageSourcePath(context.deps.projectStore.root, pageSlug),
    });
    canonicalPages.push({
      pageSlug,
      snapshot: { sha256: source.sourceHash, size: source.bytes.byteLength },
    });
  }

  const manifestSlice = new TextEncoder().encode(
    JSON.stringify({ pages: pageSlugs, active: activePageSlug }),
  );

  // kernel-command-contract §12.2 item 1 ("captures ... only currently open, resolvable
  // pins") — see this file's header, "candidatePins," for the full rationale. No active page
  // means nothing to fold: an empty candidate list then is an honest empty, not a refusal.
  const candidatePins: AdmissionCandidatePinV1[] = [];
  // The prompt library's own `openPins` list (phase-8 WP-3) — folded in this SAME loop, from
  // the SAME `PinReader.fold` result `candidatePins` is built from, never a second port call
  // and never a fabricated pin text (this file's header, "`baseTask.systemPrompt`").
  const openPinsForPrompt: { pageSlug: PageSlug; text: string }[] = [];
  const readSetPins: { pageSlug: PageSlug; base: ReadSetAppendBaseV1 }[] = [];
  if (activePageSlug !== null) {
    const pins = await wrap(context.deps.pinReader.fold(activePageSlug));
    if ("code" in pins) {
      console.warn(
        `core/kernel/handlers/turn: turn.start refused — could not fold pins for active page "${activePageSlug}": ${pins.safeMessage}`,
      );
      return [];
    }
    for (const pin of pins) {
      if (pin.status !== "open") continue;
      candidatePins.push({ pageSlug: activePageSlug, pinId: pin.pinId });
      openPinsForPrompt.push({ pageSlug: activePageSlug, text: pin.text });
    }

    // `readSet.pins` (see this file's header, "readSet.pins," for the full WP-6 citation):
    // the active page's comments-log append-base, read ONLY when it genuinely contributed a
    // candidate pin above — a page folded fine but with zero open pins never enters the CAS
    // read-set, mirroring turn-durability §7.2 step 4's "sent pins contributed context."
    if (candidatePins.length > 0) {
      const pinsAppendBase = await wrap(context.deps.pinReader.readAppendBase(activePageSlug));
      if ("code" in pinsAppendBase) {
        console.warn(
          `core/kernel/handlers/turn: turn.start refused — could not read pin append-base for active page "${activePageSlug}": ${pinsAppendBase.safeMessage}`,
        );
        return [];
      }
      readSetPins.push({ pageSlug: activePageSlug, base: pinsAppendBase });
    }
  }

  // WP-7: the real resume-or-fresh decision (storage-identity §6.2), replacing the
  // unconditional `{kind: "fresh", seed}` this handler used to build directly from
  // `selectSeed`. `sessionScopeId` folds in `workspaceIdentity` (the manifest read just
  // above) and a documented `account: null` literal — see this file's own header,
  // "`baseTask.session: SessionPlan`," for the full account/cross-restart rationale.
  trace("kernel.turnStart", { step: "pages and pins folded", pageCount: pageSlugs.length });

  const sessionScopeId = resolvedAgent.agentBackend.sessionScope({
    account: null,
    model: resolvedAgent.model,
    workspaceIdentity: manifest.projectId,
  });
  trace("kernel.turnStart", { step: "sessionScope resolved" });
  // Flat, not a nested async IIFE: an `await` on an unwrapped inner promise (even one
  // that itself calls `wrap(...)`) is its OWN unwrapped async boundary the moment it
  // resolves — `references/async-notes.md`'s "Where the async context is lost" table
  // ("continuation after `await`... inside a unit" needs `wrap(...)`, and an IIFE's own
  // returned promise is exactly such a continuation). A single top-level `await wrap(...)`
  // keeps this call on the SAME pattern every other port read in this function already uses.
  const sessionPlanResult = await wrap(
    evaluateSessionPlan(
      { sessionCheckpoint: context.deps.sessionCheckpoint },
      { chatId: activeChatId, sessionScopeId },
    ),
  );
  trace("kernel.turnStart", { step: "evaluateSessionPlan done" });
  if ("code" in sessionPlanResult) {
    console.warn(
      `core/kernel/handlers/turn: turn.start's evaluateSessionPlan failed for chat "${activeChatId}" scope "${sessionScopeId}" — ${sessionPlanResult.safeMessage}; starting with an empty seed`,
    );
  }
  const sessionPlan: SessionPlan =
    "code" in sessionPlanResult ? { kind: "fresh", seed: [] } : sessionPlanResult;

  const admission: AdmissionInputV1 = {
    turnId,
    targetChatId: activeChatId,
    text,
    ...(selection !== null ? { selection } : {}),
    candidatePins,
    workspace: {
      pages,
      manifestSlice,
      // NOW REAL (phase-8 WP-3) — see this file's header, "`runtimeDocs`," for the full
      // citation.
      runtimeDocs: context.deps.agentPromptSource.runtimeDocs(),
      readSet: {
        manifest: manifestSnapshot,
        canonicalPages,
        // NOW REAL (WP-6) — see this file's header, "readSet.pins," for the full citation.
        pins: readSetPins,
      },
    },
  };

  // See this file's header, "`baseTask.systemPrompt`" — every field here traces to a fact
  // this handler already holds honestly: `activePageSlug`/`pageSlugs` from the manifest
  // slice above, `kitApiVersion` from the already-wired `ExportRenderPort`, `openPins` from
  // the SAME pin-fold loop above `candidatePins` is built from.
  const promptContext: AgentPromptContextV1 = {
    activePageSlug,
    pageOrder: pageSlugs,
    kitApiVersion: context.deps.exportRender.runtimeDeclaration.currentKitApiVersion,
    openPins: openPinsForPrompt,
  };

  const baseTask: Omit<AgentTask, "fence"> = {
    workspacePath: "/unset", // always overridden by runTurn from the minted turn workspace
    // NOW REAL (phase-8 WP-3) — see this file's header, "`baseTask.systemPrompt`," for the
    // full citation.
    systemPrompt: context.deps.agentPromptSource.systemPrompt(promptContext),
    userMessage: text,
    model: resolvedAgent.model,
    effort: resolvedAgent.effort,
    session: sessionPlan,
  };

  const cachingStaging = createContentCachingStaging(context.deps.staging);

  const buildValidationInput: RunTurnInputV1["buildValidationInput"] = (
    candidate,
  ): RunTurnValidationMaterialV1 => ({
    manifestText: decodeCachedUtf8(cachingStaging, candidate.root, MANIFEST_SLICE_REL_PATH),
    pages: candidate.presentSlugs.map((pageSlug) => ({
      pageSlug,
      source: decodeCachedUtf8(cachingStaging, candidate.root, workspacePageRelPath(pageSlug)),
      // The absolute staged candidate path (`gate/adapters/gate-runner.ts`'s CRITICAL smoke
      // finding, fixlane-K1-turn-spine.json): the real host `SmokeRenderer` resolves a page's
      // source via `Bun.file` inside a fresh scratch-directory child process, so a bare
      // `${slug}.tsx` never resolves there. `TurnValidationPageInputV1.sourcePath`
      // (`core/turns/model/validation.ts`) carries it through to `GateRunner.runPage`'s own
      // `sourcePath`, which the Gate smoke stage resolves via `Bun.file`. `fileName` stays the
      // SHORT display name `runGate` echoes into `GateErrorV1.file` for diagnostics, so a
      // turn-validation Gate rejection reports `${slug}.tsx`, never the absolute staged path.
      fileName: workspacePageRelPath(pageSlug),
      sourcePath: `${candidate.root}/${workspacePageRelPath(pageSlug)}`,
    })),
  });

  let finalizeSummary: FinalizeSummaryV1 | null = null;
  // WP-7: captured the SAME way `finalizeSummary` above already is — from inside
  // `buildFinalizeInput`, the one closure that receives the LAST attempt's own
  // `TurnAttemptOutcomeV1` (`attempt.sessionId`, always present on a `"completed"` outcome).
  // Read after `runTurn` resolves, only on the `"committed"` branch below, to advance the
  // checkpoint for the scope `sessionScopeId` (Task 1) already resolved.
  let capturedSessionId: string | null = null;

  const buildFinalizeInput: RunTurnInputV1["buildFinalizeInput"] = ({
    turnId,
    attempt,
    candidate,
    validation,
  }): RunTurnFinalizeMaterialV1 => {
    capturedSessionId = attempt.sessionId;
    const changedPages: ChangedPageOpV1[] = [];
    for (const change of candidate.changes) {
      if (change.change === "removed") {
        changedPages.push({ pageSlug: change.pageSlug, change: "delete" });
        continue;
      }
      const bytes = cachingStaging.readCandidateBytes(
        candidate.root,
        workspacePageRelPath(change.pageSlug),
      );
      if (bytes === null) {
        console.warn(
          `core/kernel/handlers/turn: no cached candidate bytes for changed page "${change.pageSlug}" — dropping it from this attempt's finalize diff`,
        );
        continue;
      }
      changedPages.push({ pageSlug: change.pageSlug, change: "replace", newBytes: bytes });
    }

    finalizeSummary = {
      changedPages: terminalChangedPagesFromCandidate(candidate),
      gateWarnings: validation.warnings.map((w) => ({ kind: w.kind, message: w.message })),
    };

    return {
      changedPages,
      validatedPageSlugs: validation.slice.pages,
      requestedActivePage: validation.slice.active,
      agentRecord: {
        kind: "agent",
        recordId: uuidv7(),
        turnId,
        text: attempt.finalText,
        changedPages: changedPages
          .filter((c): c is ChangedPageOpV1 & { change: "replace" } => c.change === "replace")
          .map((c) => c.pageSlug),
        warnings: validation.warnings.map((w) => ({ kind: w.kind, message: w.message })),
        ts: context.deps.clock.now().toISOString(),
      },
      sentPins: [],
    };
  };

  let startedPublished = false;
  function publish(
    event:
      | PublishableEventV1<"turn.attemptStarted">
      | PublishableEventV1<"turn.progress">
      | PublishableEventV1<"turn.gateRejected">,
  ): void {
    if (!startedPublished && event.kind === "turn.attemptStarted") {
      startedPublished = true;
      // See this file's header, "TURN.STARTED — NOW PUBLISHED". `setActiveTurnId` is NOT called
      // here any more: `beginTurn` recorded the id synchronously, before this operation ever
      // launched (fix-bundle spec §1.2).
      // `admittedChatId` is `WorkspaceStateV1.activeChatId` (`core/ports/project-store.ts`
      // keeps it a plain `string`, not the branded `UUIDv7` the wire DTO needs) — validated,
      // never cast, matching this file's own `toAdmissionSelection`/`parsePageSlug` precedent.
      // A real Kernel always mints `activeChatId` via `uuidv7()` (`chat.create`), so a mismatch
      // here is defensive only: `turn.started` is skipped (logged), never sent with a
      // fabricated `chatId` — the turn itself is unaffected, since admission never validated
      // this field's format either.
      if (isUuidv7(admittedChatId)) {
        context.publishOperationEvent({
          kind: "turn.started",
          payload: { turnId, chatId: admittedChatId, deadline: event.payload.deadline },
          correlation: { turnId },
        });
      } else {
        console.warn(
          `core/kernel/handlers/turn: turn.start's activeChatId "${admittedChatId}" is not a valid UUIDv7 — turn.started skipped (defensive only)`,
        );
      }
    }
    context.publishOperationEvent(event);
  }

  const runTurnDeps: RunTurnDeps = {
    machine: context.turnRunner.machine,
    clock: context.deps.clock,
    pinReader: context.deps.pinReader,
    turnTransactions: context.deps.turnTransactions,
    chatReader: context.deps.chatReader,
    staging: cachingStaging.staging,
    agentBackend: resolvedAgent.agentBackend,
    gateRunner: context.deps.gateRunner,
    deadlines: createTurnDeadlines({ clock: context.deps.clock }),
    publish,
    foldGateDiagnosticsIntoPrompt,
    onAttemptStarted: (handle) => context.turnRunner.setActiveAttempt(handle),
    // See this file's header, "THE COMMIT-INTENT BIT — NOW WIRED": mirrors `onAttemptStarted`
    // above verbatim — `runTurn` (`core/turns`) calls this the moment a durable commit is
    // confirmed; this handler is the one legitimate caller of `context.setCommitIntentRecorded`
    // per `handlers/types.ts`'s own doc ("the turn finalize/terminalize path").
    onCommitIntentRecorded: (recorded) => context.setCommitIntentRecorded(recorded),
  };

  const runTurnInput: RunTurnInputV1 = {
    admission,
    baseTask,
    buildValidationInput,
    buildFinalizeInput,
  };

  trace("kernel.turnStart", { step: "calling runTurn" });
  const result: RunTurnResultV1 = await wrap(runTurn(runTurnDeps, runTurnInput));
  trace("kernel.turnStart", { step: "runTurn resolved", kind: result.kind });

  if (result.kind === "admission-rejected") {
    // TEMPORARY DIAGNOSTIC (2026-07-26): `outcome.kind` alone says only "blocked", which is what
    // left the last live rejection unexplained. `AdmissionOutcomeV1`'s blocked variants already
    // carry the deciding fact — `phase` (admit | chat-append-base | workspace | read-set | fence)
    // plus the failure itself — and it was being discarded here. This widening is the diagnostic
    // half of the fix the spec prescribes (§1.4); the durable half is a real terminal event.
    const detail: Record<string, unknown> = { kind: result.outcome.kind };
    if (result.outcome.kind === "blocked") {
      detail.phase = result.outcome.phase;
      detail.failure =
        "failure" in result.outcome ? result.outcome.failure : String(result.outcome.error);
    } else if (result.outcome.kind === "illegal") {
      detail.code = result.outcome.code;
    }
    trace("kernel.turnStart", { step: "admission rejected", ...detail });
    console.warn(
      `core/kernel/handlers/turn: turn.start's admission was rejected ${JSON.stringify(detail)}`,
    );
    return [];
  }

  // Clear the attempt-handle slot too — `onAttemptStarted(null)` already ran for the LAST
  // attempt once its own outcome settled, but this is the one place that is true for every
  // reachable path (finalize or terminalize), so it is repeated here defensively rather than
  // trusted implicitly.
  context.turnRunner.setActiveAttempt(null);

  context.setActiveTurnId(null);
  // Unconditional, exactly like `setActiveTurnId(null)` just above: `onCommitIntentRecorded`
  // may have fired `true` during the finalize step (a genuine commit), and this Kernel-wide
  // atom must never leak `true` into a LATER, unrelated turn's own `finalizing` phase — see
  // `RunTurnDeps.onCommitIntentRecorded`'s own doc comment (`core/turns/model/run-turn.ts`)
  // for why clearing it is this caller's job, not `runTurn`'s.
  context.setCommitIntentRecorded(false);

  if (result.kind === "finalized" && result.result.kind === "committed") {
    // WP-7: the write half of the resume-or-fresh decision (finding 4) — without this,
    // `sessionScopeId`'s checkpoint (Task 1) would never exist for a later turn to resume
    // from. `capturedSessionId` is only ever `null` if `buildFinalizeInput` itself never ran,
    // which cannot happen on THIS branch (reaching a `"committed"` result requires a finalize
    // attempt to have completed) — the guard is defensive, matching this project's own "never
    // silently assume success" convention.
    if (capturedSessionId !== null) {
      const advanced = await wrap(
        advanceSessionCheckpoint(
          { sessionCheckpoint: context.deps.sessionCheckpoint },
          { chatId: admittedChatId, sessionScopeId, sessionId: capturedSessionId },
        ),
      );
      if (advanced !== undefined) {
        // storage-identity §6.2: "Session checkpoint failure never changes chat history." The
        // turn already committed durably above — this is a non-fatal, logged best-effort step:
        // the NEXT turn simply evaluates "fresh" again, honestly, rather than resuming.
        console.warn(
          `core/kernel/handlers/turn: turn.start could not advance the session checkpoint for chat "${admittedChatId}" scope "${sessionScopeId}": ${advanced.safeMessage}`,
        );
      }
    }
    const summary: FinalizeSummaryV1 = finalizeSummary ?? { changedPages: [], gateWarnings: [] };
    return [
      {
        kind: "turn.completed",
        payload: {
          turnId,
          outcome: "completed",
          changedPages: summary.changedPages,
          warnings: summary.gateWarnings.map((w) => ({ code: w.kind, safeMessage: w.message })),
          failure: null,
        },
        correlation: { turnId },
      },
    ];
  }

  // See this file's header, "THE TERMINAL EVENT" / "GATE-EXHAUSTION-VS-BACKEND-FAILURE —
  // CLOSED": the wire `outcome` field still only ever publishes `"failed"` here (widening it
  // would misrepresent a guess as spec-fixed fact), but `failure`'s own `code` is now as
  // precise as `TerminalizeTurnResultV1`'s echoed `reason` honestly allows — `terminalFailureDto`
  // (above) does the narrowing.
  const branch =
    result.kind === "finalized"
      ? `finalized/${result.result.kind}`
      : `terminalized/${result.result.kind}`;
  const propagatedFailure = terminalFailureDto(result, branch);
  console.warn(
    `core/kernel/handlers/turn: turn.start ended on ${branch} — publishing turn.failed (see ./turn.ts's header, "THE TERMINAL EVENT")`,
  );
  return [
    {
      kind: "turn.failed",
      payload: {
        turnId,
        outcome: "failed",
        changedPages: [],
        warnings: [],
        failure: propagatedFailure,
      },
      correlation: { turnId },
    },
  ];
}

/**
 * THE ONE ENTRY POINT INTO A TURN (fix-bundle spec §1.6). `turn.start`'s handler and
 * `runProjectReadySequence`'s first-turn chain (spec §3.1) both call this, so "one path" is
 * literal rather than aspirational.
 *
 * The three steps below run with NO `await` between them — mint the id, apply `beginAdmission`,
 * record the id — because that atomicity IS the invariant `core/capabilities/types.ts` states
 * (a non-idle phase always carries a non-null `activeTurnId`). The invariant survives this being
 * called from inside an async closure (the ready sequence's case): it rests on the trio, not on
 * being in a command handler. `./project.ts`'s `beginProjectOpen` is the exact precedent —
 * transition applied synchronously in the handler, its own id minted beside it, `launchOperation`
 * only afterwards.
 *
 * Returns the admission events the caller must publish. An illegal `beginAdmission` returns `[]`
 * (logged) and launches nothing.
 */
export function beginTurn(
  context: HandlerContext,
  input: { readonly text: string },
): readonly PublishableEventV1[] {
  const turnId = uuidv7();
  const began = context.machines.turn.apply("beginAdmission");
  if (began.kind === "illegal") {
    console.warn(
      `core/kernel/handlers/turn: beginTurn refused — beginAdmission was illegal (${began.code})`,
    );
    return [];
  }
  if (began.kind !== "changed") return [];
  context.setActiveTurnId(turnId);
  context.launchOperation("kernel.turn.run", () => runTurnStart(turnId, input.text, context));
  return [turnStateChangedEvent("kernel.turn.beginAdmission", began, { turnId })];
}

function handleTurnStart(
  payload: CommandPayloadByKindV1["turn.start"],
  context: HandlerContext,
): CommandOutcomeV1 {
  return startedOutcome(beginTurn(context, { text: payload.text }));
}

// --- turn.cancel — real, end to end -------------------------------------------------------

/**
 * Always applies `requestCancel` first — legal from every cancelable phase the guard
 * (`capabilities/model/guards.ts`'s `turnCancelReason`) already let through, per
 * `turn-machine.ts`'s own table (this file's header). Then branches ONLY on whether a live
 * `AgentBackend` run is currently registered (`context.turnRunner.activeAttempt`):
 * - `null` — no live process (every phase except a currently-attempting `"running"`); the
 *   transition above is already the complete, correct action.
 * - non-null — a live run IS in flight; this genuinely stops it via the registered handle's
 *   own `requestCancel()`, inside `launchOperation` (the one sanctioned async boundary),
 *   never a second, competing terminal event — the real `turn.completed`/`turn.failed` is
 *   published by the STILL-RUNNING `turn.start` operation's own completion once its composed
 *   `runTurn` observes the confirmed cancellation.
 */
function handleTurnCancel(
  payload: CommandPayloadByKindV1["turn.cancel"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const applied = context.machines.turn.apply("requestCancel");

  if (applied.kind === "illegal") {
    // Defensive only — `turnCancelReason` already confirmed phase legality and turnId match
    // before dispatch ever reached this handler; unreachable in a correctly-wired Kernel,
    // kept explicit per this project's "never silently assume success" rule (mirrors
    // `project.ts`'s identical defensive posture for its own `tryApply` calls).
    console.warn(
      `core/kernel/handlers/turn: turn.cancel's requestCancel was illegal despite the guard confirming legality (turnId ${payload.turnId})`,
    );
    return noOpOutcome();
  }

  if (applied.kind === "no-op") {
    // §8.4 point 4 / turn-machine.ts's own noOp edges: a repeated cancel while already
    // "stopping" or "terminalizing" is an accepted no-op, not a failure — nothing further to
    // do, and nothing changed to report.
    return noOpOutcome();
  }

  const admissionEvent = turnStateChangedEvent("kernel.turn.requestCancel", applied, {
    turnId: payload.turnId,
  });

  const handle = context.turnRunner.activeAttempt(payload.turnId);
  if (handle === null) {
    return completedOutcome([admissionEvent]);
  }

  context.launchOperation("kernel.turn.cancel", async () => {
    await wrap(handle.requestCancel());
    // No event of its own: see this function's own doc comment above.
    return [];
  });

  return startedOutcome([admissionEvent]);
}

// --- The family map -------------------------------------------------------------------------

export const turnHandlers: FamilyHandlerMap<"turn"> = {
  "turn.start": handleTurnStart,
  "turn.cancel": handleTurnCancel,
};
