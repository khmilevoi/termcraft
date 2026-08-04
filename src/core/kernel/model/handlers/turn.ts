import { wrap } from "@reatom/core";

import { truncateChatDisplayName } from "core/chats";
import type { TransitionOutcome, TurnAction, TurnState } from "core/machines";
import type { EventCorrelationV1, PublishableEventV1 } from "core/mailbox";
import type {
  AgentBackend,
  AgentPromptContextV1,
  AgentTask,
  ChangedDesignFileOpV1,
  ReadSetAppendBaseV1,
  ReasoningEffort,
  SessionPlan,
  StagedTurnReadSetV1,
  StagingService,
  StagingTreeFileV1,
  TurnWorkspaceV1,
} from "core/ports";
import { readPageOrder } from "core/project";
import {
  type CommandPayloadByKindV1,
  type EventPayloadByKindV1,
  type FailureDtoV1,
  type Sha256Hex,
  type UUIDv7,
  isOperationalFailureCode,
  isUuidv7,
} from "core/protocol";
import {
  type AdmissionCandidatePinV1,
  type AdmissionInputV1,
  type AdmissionOutcomeV1,
  type RunTurnDeps,
  type RunTurnFinalizeMaterialV1,
  type RunTurnInputV1,
  type RunTurnResultV1,
  type RunTurnValidationMaterialV1,
  type TurnCandidateV1,
  advanceSessionCheckpoint,
  candidateTreeInventory,
  createTurnDeadlines,
  evaluateSessionPlan,
  foldGateDiagnosticsIntoPrompt,
  readSetTreeInventory,
  runTurn,
  selectChangedPages,
  terminalizeTurn,
} from "core/turns";
import type { ChatSelection } from "entities/chat";
import { DESIGN_DIRNAME } from "entities/design-tree";
import type { PageEntryV1 } from "entities/design-tree";
import { type PageSlug, parsePageSlug } from "entities/page";
import { trace } from "infrastructure/debug-log";
import { uuidv7 } from "infrastructure/uuid";

import { designTreeFilePath, publishPageDescriptorsChanged } from "./page-descriptors";
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
 *   `workspace.treeFiles` / `readSet.designFiles`: ONE `DesignTreeReader.listTree()` call
 *   (task 14). The canonical design tree is staged WHOLE — every file it names, at the SAME
 *   tree-relative path inside the workspace, which is what makes design §10's hard requirement
 *   hold (the two trees agree, so no import specifier is ever rewritten on apply). Each entry's
 *   `sourcePath` is `designTreeFilePath(projectStore.root, relPath)` =
 *   `` `${projectRoot}/.termcraft/design/<relPath>` ``, and its read-set snapshot's
 *   `sha256`/`size` come from that SAME `listTree()` result — never a second read, never
 *   fabricated.
 *
 *   WHAT THIS REPLACED, AND WHY IT HAD TO GO: a `for (const pageSlug of pageSlugs)` loop over
 *   `pageReader.listSlugs()`, one `readSource(pageSlug)` per page, plus a SYNTHESIZED
 *   `manifestSlice: JSON.stringify({pages: <those slugs>, active: <workspaceState>})`. Every
 *   part of that assumed a slug names a file, which the multi-file design tree retires: a page's
 *   file is whatever `design/pages.json`'s `entry` says, shared modules belong to no page at
 *   all, and `pages.json` is a REAL file the agent edits — synthesizing it per turn threw away
 *   the agent's own edits to page order and identity.
 *
 *   `DesignTreeReader.readManifest()` is read ONCE, beside `listTree()`, for the prompt's
 *   `pageOrder`. A decode failure is an idempotent, logged refusal in the same
 *   `abortEarlyAdmission` shape the old `listSlugs` failure used — never a fabricated empty
 *   order, which would tell the agent the project has no pages.
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
 *   SAME `WorkspaceStateV1.activePageSlug` and `readManifest()` page order the staging
 *   assembly above already reads), `kitApiVersion` from `context.deps.exportRender
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
 *   is NOT called here at all any more, unconditionally or otherwise (Task 5, fix-bundle spec
 *   §1.5's own follow-up finding to Task 4's discipline below): clearing it only once `runTurn`'s
 *   promise has resolved left a window where the turn machine had already settled to `idle` —
 *   candidate retirement and all — while `activeTurnId` still named the just-finished turn, so a
 *   new `turn.start` could pass the `phase === "idle"` guard and this stale handler would then
 *   clear the NEW turn's id instead of its own. `RunTurnDeps.onSettled` (`runTurnDeps`, below)
 *   closes that window by clearing it from INSIDE `finalizeTurn`/`terminalizeTurn`
 *   (`core/turns/model/finalize.ts` / `terminalize.ts`), the INSTANT their own `settle` transition
 *   applies — before either function's post-settle candidate retirement, and long before this
 *   `runTurn` composition as a whole ever resolves. That same "clear at settle, not at resolve"
 *   discipline now covers every OTHER exit this file has, not only the ordinary finalize/terminalize
 *   arc (Task 4, fix-bundle spec §1.2/§1.3/§1.5's own follow-up finding): a rejected admission
 *   clears it via `terminalizeRejectedAdmission`'s own call into `terminalizeTurn` (below, now also
 *   wired through `onSettled` rather than an unconditional post-`await` clear), and every one of the
 *   TEN early-refusal branches that returns before `admission`/`runAdmission` is ever built clears it
 *   via `abortEarlyAdmission` (Task 3's own fix; Task 4 additionally has that helper publish a
 *   `turn.failed` naming the branch's real cause — see that function's own doc comment for both). No
 *   exit from `runTurnStart` leaves `activeTurnId` non-null without also leaving the turn machine
 *   `idle`, and no exit clears it before the machine has actually reached `idle` either.
 *
 *   TURN.STARTED — NOW PUBLISHED (was: "deliberately not published"; corrected per
 *   fixlane-K1-turn-spine.json's seam finding, votes 3/notRefuted 3): at the time this fix
 *   landed, `ui/mirror/model/mirror.ts`'s own `case "turn.started"` was the ONLY transition
 *   that moved `TurnMirror` into `"running"` — every later `turn.attemptStarted`/
 *   `turn.progress`/`turn.gateRejected` the mirror applies is gated on `phase === "running"`
 *   already, so treating the first `turn.attemptStarted` as sufficient proof (this file's prior
 *   design) left the mirror permanently `"idle"` for the WHOLE turn: no streamed reasoning/tool
 *   steps, no gate-retry lines, and (via `actionContext.turnRunning`) no working Esc-to-cancel.
 *   UPDATED (fix-bundle Task 11 fix round 1): `mirror.ts` now ALSO moves `TurnMirror` into
 *   `"running"` from `kernel.turn.beginAdmission` — `case "turn.started"` (mirror.ts:266) is no
 *   longer the only transition that does, though it still unconditionally overwrites whatever
 *   that earlier fold set the moment it fires, with the real `deadline` the admission-time fold
 *   cannot yet know. `publish` (below) now synthesizes and sends a schema-valid
 *   `PublishableEventV1<"turn.started">` —
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
 *   it back to `false` UNCONDITIONALLY once `runTurn` resolves (unlike `activeTurnId`, this bit
 *   has no `onSettled`-style hook of its own — `onCommitIntentRecorded` only ever fires `true`,
 *   never `false`, so clearing it back down is still this caller's own post-`await` job), so the
 *   bit never leaks `true` into a LATER, unrelated turn's own `finalizing` phase.
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
 *     `outcome` field carries the REAL §7.2 outcome and the event KIND matches it —
 *     `turn.cancelled` for a cancel, `turn.failed` otherwise. CORRECTED (defect fix,
 *     2026-07-26): this used to read "the wire `outcome` field itself still only ever publishes
 *     `"failed"` ... widening IT would misrepresent a guess as spec-fixed fact". That was true
 *     when written and stopped being true in this same file's own "GATE-EXHAUSTION-VS-BACKEND-
 *     FAILURE — CLOSED" landing, which made `TerminalizeTurnResultV1` echo the requested
 *     `TurnTerminalOutcome` back verbatim — so it is a value READ, not a guess. See
 *     {@link terminalOutcomeCode} for what the stale literal cost the user. `failure`, the DTO
 *     alongside it, is narrowed separately — see "GATE-EXHAUSTION-VS-BACKEND-FAILURE — CLOSED"
 *     below.
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
 * One tree file's path INSIDE a staged workspace or frozen candidate: `design/<treeRelPath>`,
 * relative to that workspace/candidate root — never to the project root.
 *
 * REPLACES `workspacePageRelPath(pageSlug)` (task 14, and the brief's own named interface
 * change). That helper computed `design/pages/<slug>.tsx` FROM THE SLUG; this one takes the
 * tree-relative path the design tree already speaks — the path `design/pages.json` bound to
 * the page, or a shared module's own path, which belongs to no page at all. The `design/`
 * prefix is design-mandated, not a stopgap (multi-file design tree design §10: the tree, the
 * manifest included, lives inside `design/`), and staging copies each file to the SAME
 * tree-relative path so no import specifier is ever rewritten on apply.
 *
 * `designTreeFilePath(projectRoot, treeRelPath)` (`./page-descriptors`) is the PROJECT-root
 * half of the same convention — `<projectRoot>/.termcraft/design/<treeRelPath>`. The two are
 * deliberately distinct functions with distinct names: Gap G was one helper being joined onto
 * both roots.
 */
function workspaceTreeRelPath(treeRelPath: string): string {
  return `${DESIGN_DIRNAME}/${treeRelPath}`;
}

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
 * when ALL THREE are absent. Refuses when the registry cannot honestly supply exactly one
 * default: zero registered backends, or more than one with no picker to choose between them
 * (MVP registers Claude only — `agent-registry.ts`'s own "MVP ships exactly one entry" — so
 * this branch is a documented guard against a future registry shape, not a case this build
 * can exercise).
 *
 * Returns a `FailureDtoV1` on refusal (Task 4, fix-bundle spec §1.3/§1.4's own follow-up
 * finding), not a bare `null`: `runTurnStart`'s own call site now has to hand
 * `abortEarlyAdmission` a real cause, and the ONLY honest source of that cause is whichever
 * of the three `console.warn` lines below actually fired — never a second, reconstructed
 * message at the call site. `code` is `"PERSISTENCE_FAILED"` for all three (no port failure
 * exists to carry a more specific one — this is a registry-shape refusal, not a read
 * failure), `safeMessage` is the SAME string the matching `console.warn` logs, verbatim.
 */
function resolveStoredOrDefaultAgentTriple(
  context: HandlerContext,
  stored: {
    readonly backend: string | null;
    readonly model: string | null;
    readonly effort: string | null;
  },
): StoredOrDefaultAgentTripleV1 | FailureDtoV1 {
  if (stored.backend !== null && stored.model !== null && stored.effort !== null) {
    return { backend: stored.backend, model: stored.model, effort: stored.effort };
  }

  const registered = context.deps.agentRegistry.list();
  if (registered.length === 0) {
    const reason =
      "turn.start refused — no agent selection stored and no backend registered to default from";
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: reason, details: {} };
  }
  if (registered.length > 1) {
    const reason = `turn.start refused — no agent selection stored and ${registered.length} backends are registered; MVP has no picker to choose a default among them`;
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: reason, details: {} };
  }
  const [only] = registered;
  if (only === undefined) {
    // Unreachable given the length checks above (`=== 0` and `> 1` both returned already, so
    // exactly one element remains) — kept explicit per this project's "never silently assume
    // success" rule.
    const reason = "turn.start refused — registry reported one backend but yielded none on read";
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: reason, details: {} };
  }
  return {
    backend: only.backendId,
    model: only.defaultSelection.model,
    effort: only.defaultSelection.effort,
  };
}

/** Same "return the real cause, not `null`" rule as {@link resolveStoredOrDefaultAgentTriple} — see its own doc comment. */
function resolveAgentSelection(
  context: HandlerContext,
  backendId: string,
  model: string,
  effort: string,
): ResolvedAgentSelectionV1 | FailureDtoV1 {
  const capabilities = context.deps.agentRegistry.list().find((b) => b.backendId === backendId);
  if (capabilities === undefined) {
    const reason = `turn.start refused — unknown backend "${backendId}"`;
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: reason, details: {} };
  }
  const modelCapability = capabilities.models.find((m) => m.model === model);
  if (modelCapability === undefined) {
    const reason = `turn.start refused — backend "${backendId}" does not offer model "${model}"`;
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: reason, details: {} };
  }
  const resolvedEffort = modelCapability.efforts.find((e) => e === effort);
  if (resolvedEffort === undefined) {
    const reason = `turn.start refused — model "${model}" does not offer effort "${effort}"`;
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: reason, details: {} };
  }
  const agentBackend = context.deps.agentRegistry.get(backendId);
  if (agentBackend === null) {
    const reason = `turn.start refused — registry lost backend "${backendId}" between list() and get()`;
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: reason, details: {} };
  }
  return { backendId, model, effort: resolvedEffort, agentBackend };
}

/** Captured once, from the LAST `buildFinalizeInput` call, so the terminal `turn.completed` event can report what actually changed without re-deriving it a second time. */
interface FinalizeSummaryV1 {
  readonly changedPages: readonly { readonly pageSlug: PageSlug; readonly sourceHash: Sha256Hex }[];
  readonly gateWarnings: readonly { readonly kind: string; readonly message: string }[];
}

/**
 * `turn.completed`'s own `changedPages` — the wire DTO is `{pageSlug, sourceHash}`, so each
 * changed page still needs ONE hash to name it, even though "changed" is now a CLOSURE fact
 * (design §7: a page changes when any file it reaches changes, including one whose own entry
 * file's bytes never moved).
 *
 * The hash reported is the page's ENTRY FILE's, resolved through the validated manifest and
 * then through the candidate's own inventory. That is the only honest single hash available:
 * `sourceHash` on this payload has always meant "the identity of the page's own source", and a
 * closure hash would be a different quantity under the same field name. A page whose closure
 * changed but whose entry did not therefore reports its UNCHANGED entry hash — correct for
 * what the field says, and the reason the field alone can no longer be used to decide whether
 * a page changed (`changedPageSlugs`, from `selectChangedPages`, is that answer).
 *
 * A slug with no manifest entry, or an entry with no file in the candidate, is DROPPED rather
 * than reported with a fabricated hash — both are unreachable on this path (a passing
 * validation means every entry resolved in `treePaths`), and each drop logs.
 */
export function terminalChangedPages(
  changedPageSlugs: readonly PageSlug[],
  entries: readonly PageEntryV1[],
  candidate: TurnCandidateV1,
): readonly { readonly pageSlug: PageSlug; readonly sourceHash: Sha256Hex }[] {
  const shaByRelPath = new Map(candidate.treeFiles.map((file) => [file.relPath, file.sha256]));
  const changed: { pageSlug: PageSlug; sourceHash: Sha256Hex }[] = [];
  for (const pageSlug of changedPageSlugs) {
    const entry = entries.find((candidateEntry) => candidateEntry.slug === pageSlug);
    const sourceHash = entry === undefined ? undefined : shaByRelPath.get(entry.entry);
    if (sourceHash === undefined) {
      console.warn(
        `core/kernel/handlers/turn: changed page "${pageSlug}" has no resolvable entry hash in the frozen candidate — omitted from turn.completed's changedPages rather than reported with a fabricated one`,
      );
      continue;
    }
    changed.push({ pageSlug, sourceHash });
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
 * The REAL terminal outcome for a `RunTurnResultV1` that did not commit.
 *
 * WHY THIS EXISTS (defect fix, 2026-07-26): this composer used to publish the literal
 * `outcome: "failed"` for every non-committed result, and both this file's header and
 * `event-payload.ts`'s `TurnTerminalPayloadV1` doc justified it with "this composer still
 * cannot honestly reconstruct WHICH `TurnTerminalOutcome` a turn ended on". THAT IS NO LONGER
 * TRUE, and the fix that made it untrue is quoted in `terminalize.ts:95-107`'s own doc:
 * `TerminalizeTurnResultV1` echoes the originally requested `TurnTerminalOutcome` back verbatim
 * on BOTH the `"recorded"` and `"unrecorded"` variants, "added specifically so this caller
 * could rebuild the real outcome". Nothing here is a guess — it is a value read back.
 *
 * The user-visible cost of the stale literal: pressing Esc during a turn is a normal, hinted
 * action (`Workspace.tsx` draws `esc cancel` while a turn runs), and the cancel really does
 * reach `run-turn.ts`'s `terminalize("cancelled", ...)` — but the wire said `"failed"`, so
 * `Workspace.tsx`'s `terminalRecordLines` rendered `✗ failed` in the chat stream, giving a
 * deliberate cancel the same treatment as a backend crash.
 *
 * `TurnTerminalOutcome` (`failed | cancelled | stale | interrupted`) is a strict subset of the
 * wire's `TurnOutcomeCodeV1` (that set plus `completed`), so the echo needs no mapping table.
 * The two branches that carry no echoed outcome — the defensive `"illegal"` variant and the
 * practically-unreachable `"finalized"` shapes (see this file's header, "THE TERMINAL EVENT")
 * — keep `"failed"`, which is the honest answer for "terminalization itself was refused".
 */
function terminalOutcomeCode(
  result: RunTurnResultV1,
): EventPayloadByKindV1["turn.failed"]["outcome"] {
  if (result.kind !== "terminalized") return "failed";
  if (result.result.kind === "illegal") return "failed";
  return result.result.outcome;
}

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
 * One step of {@link abortEarlyAdmission}'s walk-back: applies `action`, warns (never throws,
 * never swallows) if the table rejects it, and returns the `kernel.stateChanged` event only
 * when a real transition happened. `action` is narrowed to the three edges that walk-back
 * actually uses — a defensive-only shape, since none of the three has a same-state `noOp` row
 * in `TURN_TRANSITION_TABLE` (`core/machines/model/turn-machine.ts`), so `"no-op"` is
 * unreachable here in practice but still handled rather than assumed away.
 */
function applyAbortStep(
  context: HandlerContext,
  turnId: UUIDv7,
  action: "beginTerminalization" | "finishTerminalization" | "settle",
): PublishableEventV1<"kernel.stateChanged"> | null {
  const outcome = context.machines.turn.apply(action);
  if (outcome.kind === "illegal") {
    console.warn(
      `core/kernel/handlers/turn: abortEarlyAdmission — ${action} was illegal for turn ${turnId} (${outcome.code})`,
    );
    return null;
  }
  if (outcome.kind !== "changed") return null;
  return turnStateChangedEvent(`kernel.turn.${action}`, outcome, { turnId });
}

/**
 * The give-back for every early-refusal branch inside `runTurnStart` that returns before
 * `admission`/`runAdmission` is ever built (fix-bundle spec §1.2's own follow-up finding —
 * fix round 1 review). `beginTurn` (below) now admits UNCONDITIONALLY, synchronously, before
 * any of `runTurnStart`'s own port reads ever run — so a refusal that used to just `return []`
 * left the machine permanently stranded in `"admitting"` with a non-null `activeTurnId`:
 * `capabilities/model/guards.ts`'s own `turnStartReason` then rejects every LATER `turn.start`
 * with `TURN_ALREADY_ACTIVE` (phase !== "idle"). UPDATED (fix-bundle Task 11 fix round 1):
 * `ui/mirror`'s `TurnMirror` now reaches `"running"` the moment `kernel.turn.beginAdmission`
 * publishes, not only on `turn.started`, so Esc CAN reach `turn.cancel` with the real admitted
 * id during this same window (a legal `admitting -> terminalizing` row) — but that is not a
 * substitute for this helper: every one of these ten branches resolves automatically, from a
 * port read or a resolver refusing, well before a user could notice anything is wrong and press
 * a key, so recoverability here must not depend on a keystroke that may never come. Before
 * `beginTurn` existed, `beginAdmission` lived inside `runAdmission`, downstream of every one of
 * these refusals, so an early failure left the machine in `idle` and the user could simply
 * retry — this helper restores that same recoverability, automatically.
 *
 * Walks the REAL legal edges `TURN_TRANSITION_TABLE` defines for exactly this exit —
 * `admitting -> terminalizing` (Task 2's own row, added for precisely this case) ->
 * `terminalizing -> terminal` -> `terminal -> idle` — never inventing a shortcut edge.
 * Deliberately NOT `core/turns/model/terminalize.ts`'s `terminalizeTurn`: that function ALSO
 * writes a durable `system:error` chat record and needs a `targetChatId`/`staging`/durable-write
 * ceremony several of these branches fire before an `activeChatId` is even known (e.g. the "no
 * active chat yet" branch itself). The durable chat record stays exclusive to
 * `terminalizeRejectedAdmission` (below), which handles the one branch that DOES already have a
 * committed user record and a known `targetChatId` to attach it to — every one of THESE ten
 * branches fires before that is true.
 *
 * Returns every `kernel.stateChanged` event a transition that actually happened produced, PLUS
 * exactly one `turn.failed` naming `failure` as its cause (Task 4, fix-bundle spec §1.4's own
 * follow-up finding: an accepted command must reach a terminal event, and these ten branches
 * accept — `turn.start` returns `disposition: "started"` — every bit as much as the
 * `admission-rejected` branch this bundle's other half fixes). Never `[]`: the mailbox layer's
 * `applyTransition` already advanced the Kernel's revision the moment `beginAdmission` applied
 * inside `beginTurn`, strictly BEFORE `runTurnStart` (and this function) ever run, so a caller
 * that returned nothing here would desynchronise every subscriber exactly like the
 * `admission-rejected` defect this bundle fixes elsewhere — the identical shape of bug,
 * reintroduced here, is not an acceptable trade for a shorter return.
 */
function abortEarlyAdmission(
  context: HandlerContext,
  turnId: UUIDv7,
  failure: FailureDtoV1,
): readonly PublishableEventV1[] {
  const events: PublishableEventV1[] = [];
  const beginEvent = applyAbortStep(context, turnId, "beginTerminalization");
  if (beginEvent !== null) events.push(beginEvent);
  const finishEvent = applyAbortStep(context, turnId, "finishTerminalization");
  if (finishEvent !== null) events.push(finishEvent);
  const settleEvent = applyAbortStep(context, turnId, "settle");
  if (settleEvent !== null) events.push(settleEvent);
  // Unconditional, matching `runTurnStart`'s own terminal-path `setActiveTurnId(null)`: the
  // invariant (`core/capabilities/types.ts:93`) must hold in both directions — `idle` implies
  // `null`, not merely "non-idle implies non-null".
  context.setActiveTurnId(null);
  events.push({
    kind: "turn.failed",
    payload: { turnId, outcome: "failed", changedPages: [], warnings: [], failure },
    correlation: { turnId },
  });
  return events;
}

/**
 * The real cause, from the value that already carried it (fix-bundle spec §1.4).
 * `AdmissionOutcomeV1`'s `blocked` variants carry `phase`
 * (`admit | chat-append-base | workspace | read-set | fence`) plus either a real `FailureDtoV1`
 * or a typed translation/fence error — all of which used to be discarded at the log line. That
 * discard is exactly why the observed rejection went unexplained until a temporary trace widening
 * named it on the first re-run; the durable half is this DTO.
 *
 * A real `FailureDtoV1` is spread verbatim so its own `code`/`details` survive — including the
 * two codes whose wire schema demands a typed `details.part` (`APPLY_SOURCE_CHANGED`,
 * `APPLY_STALE`), which is why this needs none of `terminalFailureDto`'s exclusion set: nothing
 * is reconstructed here, only re-messaged.
 */
/**
 * Whether the admitted chat is still UNNAMED, and if so the `createdAt` a republished summary
 * must carry.
 *
 * Must run BEFORE `runTurn`: admission appends this turn's own `user` record, and once it has,
 * every chat looks named and the "was it already named?" question can no longer be answered.
 * Returning `null` means "leave the summary alone" — the chat already has a name (so §3.9's
 * FIRST user record, not this one, owns it), or the read failed.
 *
 * `createdAt` is re-read rather than assumed: `ChatSummaryV1` requires it, and republishing a
 * summary with a wrong one would reorder the `/chats` popup, which sorts newest-first on
 * exactly that field (`ui/mirror/model/chats.ts`).
 *
 * The test is "is this chat EMPTY", not `resolveChatDisplayName`'s "what is its name". The two
 * agree here — a chat with any content already owns a name derived from its own first record,
 * which by definition is not this turn's — but the cheap one runs in a single `loadTail`,
 * whereas the naming walk pages `loadBefore` backwards to the chat's very beginning. That walk
 * is right when the answer is needed (`chat.switch`) and wrong on a path that runs on EVERY
 * send: it would grow a turn's fixed cost with the chat's own length.
 *
 * Best-effort by construction: a chat naming is cosmetic next to running the turn, so a failed
 * read is logged and skipped (errore rule 21), never propagated into the turn's own outcome.
 */
async function resolvePendingChatNaming(
  context: HandlerContext,
  chatId: string,
): Promise<{ readonly createdAt: string } | null> {
  const handle = await wrap(context.deps.chatReader.open(chatId));
  if ("code" in handle) {
    console.warn(
      `core/kernel/handlers/turn: could not open chat "${chatId}" to check whether it still needs a name: ${handle.safeMessage}`,
    );
    return null;
  }
  const tail = await wrap(handle.loadTail());
  if ("code" in tail) {
    console.warn(
      `core/kernel/handlers/turn: could not read chat "${chatId}"'s tail to check whether it still needs a name: ${tail.safeMessage}`,
    );
    return null;
  }
  // Empty tail AND no earlier page: the chat holds nothing at all, so the record admission is
  // about to append is genuinely its first.
  if (tail.records.length > 0 || tail.prevCursor !== null) return null;
  return { createdAt: handle.header.createdAt };
}

function admissionFailureDto(
  outcome: Exclude<AdmissionOutcomeV1, { kind: "workspace-ready" }>,
): FailureDtoV1 {
  if (outcome.kind === "illegal") {
    // NEVER "could not be admitted" once the user record IS committed (defect fix, 2026-07-26).
    // `finishAdmission` going illegal means a `turn.cancel` raced admission's own multi-step
    // async work — and by then `runAdmission` has already durably appended the user's message.
    // The old flat wording was written into the chat as a `system:error` record sitting directly
    // beneath that very message, so the app contradicted itself on screen: "the turn could not be
    // admitted", one line under the admitted message. What actually happened is a cancel, and
    // that is what this says.
    if (outcome.userRecordCommitted) {
      return {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "the turn was cancelled while it was being prepared",
        details: {},
      };
    }
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: `the turn could not be admitted (${outcome.code})`,
      details: {},
    };
  }
  if ("failure" in outcome) {
    return {
      ...outcome.failure,
      safeMessage: `admission failed at the ${outcome.phase} phase: ${outcome.failure.safeMessage}`,
    };
  }
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: `admission failed at the ${outcome.phase} phase: ${outcome.error.message}`,
    details: { phase: outcome.phase },
  };
}

/**
 * A rejected admission takes the SAME `terminalizeTurn` every other non-committing outcome
 * already takes (fix-bundle spec §1.3): it applies `finishTerminalization`, durably writes a
 * `system:error` chat record, and applies `settle` back to `idle`. No separate path for a failed
 * admission exists, and none is invented here.
 *
 * `turnTransactions.terminalize` builds and appends its OWN record from this input — it does not
 * depend on the turn's user record having committed — so a rejection blocked at the `admit`
 * phase still leaves a durable trace, matching what the orphan-turn scan already writes on
 * restart (turn-durability §7.7).
 *
 * `activeTurnId` clears via `TerminalizeTurnDeps.onSettled` (Task 5, fix-bundle spec §1.5), the
 * SAME hook `runTurnDeps` (below) wires for the ordinary finalize/terminalize arc — never an
 * unconditional clear after `terminalizeTurn` resolves, which would reopen the exact
 * mirror-image window that hook exists to close (see `runTurnStart`'s own header, "LIVE EVENTS").
 */
async function terminalizeRejectedAdmission(
  context: HandlerContext,
  turnId: UUIDv7,
  targetChatId: string,
  outcome: Exclude<AdmissionOutcomeV1, { kind: "workspace-ready" }>,
): Promise<readonly PublishableEventV1[]> {
  const failure = admissionFailureDto(outcome);

  const bridged = context.machines.turn.apply("beginTerminalization");
  if (bridged.kind === "illegal") {
    // Defensive only — `admitting -> terminalizing` is a table row as of spec §1.1, and the
    // machine cannot have left `admitting` while this operation owned it. Logged, never swallowed.
    console.warn(
      `core/kernel/handlers/turn: beginTerminalization was illegal for turn ${turnId}'s rejected admission (${bridged.code})`,
    );
  }

  const terminalized = await wrap(
    terminalizeTurn(
      {
        // The FULL `StateMachine` (`phaseAtom` included), not `context.machines.turn`'s
        // narrower `HandlerMachine` view — `terminalizeTurn` needs the same full object
        // `run-turn.ts`'s own `RunTurnDeps.machine: context.turnRunner.machine` already uses
        // (this file's header: "the SAME full `StateMachine<TurnState, TurnAction>`").
        machine: context.turnRunner.machine,
        turnTransactions: context.deps.turnTransactions,
        staging: context.deps.staging,
        // Spec §1.5 — see this function's own header. Fires the instant `settle` applies, not
        // once this `await` resolves.
        onSettled: () => context.setActiveTurnId(null),
      },
      {
        turnId,
        targetChatId,
        outcome: "failed",
        text: failure.safeMessage,
        reason: failure.code,
        createdAt: context.deps.clock.now().toISOString(),
        // No candidate has ever been frozen for a turn that never reached an attempt.
        candidateRoot: null,
      },
    ),
  );

  if (terminalized.kind === "illegal") {
    // Defensive only, like `beginTerminalization`'s own illegal check above — `finishTerminalization`
    // is a legal edge from `terminalizing`, and this function's own `beginTerminalization` call
    // just put the machine there. `terminalizeTurn` never reaches its own `settle` call on this
    // exit, so `onSettled` never fires and `activeTurnId` is left as-is — matching every other
    // unreachable-in-practice illegal-transition branch in this file (e.g. `applyAbortStep`),
    // which likewise logs rather than invents a compensating clear.
    console.warn(
      `core/kernel/handlers/turn: terminalizeTurn was illegal for turn ${turnId}'s rejected admission (${terminalized.code})`,
    );
  }

  return [
    {
      kind: "turn.failed",
      payload: { turnId, outcome: "failed", changedPages: [], warnings: [], failure },
      correlation: { turnId },
    },
  ];
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
    const reason = `turn.start refused — could not read workspace state: ${workspaceState.safeMessage}`;
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return abortEarlyAdmission(context, turnId, { ...workspaceState, safeMessage: reason });
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
    const reason = "turn.start refused — no active chat yet";
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return abortEarlyAdmission(context, turnId, {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: reason,
      details: {},
    });
  }
  // A fresh, explicitly-typed `const`: `publish` below is a nested closure, and TypeScript
  // does not carry the null-check narrowing above into nested function bodies — re-binding
  // the already-narrowed value here (never reassigned) sidesteps that cleanly, no cast needed.
  const admittedChatId: string = activeChatId;

  const agentTriple = resolveStoredOrDefaultAgentTriple(context, { backend, model, effort });
  trace("kernel.turnStart", { step: "agentTriple resolved", agentTriple });
  if ("code" in agentTriple) return abortEarlyAdmission(context, turnId, agentTriple);

  const resolvedAgent = resolveAgentSelection(
    context,
    agentTriple.backend,
    agentTriple.model,
    agentTriple.effort,
  );
  trace("kernel.turnStart", {
    step: "resolveAgentSelection returned",
    refused: "code" in resolvedAgent,
  });
  if ("code" in resolvedAgent) return abortEarlyAdmission(context, turnId, resolvedAgent);

  trace("kernel.turnStart", { step: "agent selection resolved" });

  const manifestSnapshot = await wrap(context.deps.projectStore.readManifestSnapshot());
  trace("kernel.turnStart", { step: "readManifestSnapshot done" });
  if ("code" in manifestSnapshot) {
    const reason = `turn.start refused — could not read project.toml's snapshot: ${manifestSnapshot.safeMessage}`;
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return abortEarlyAdmission(context, turnId, { ...manifestSnapshot, safeMessage: reason });
  }

  // WP-7: a SECOND, different call to the SAME port — `readManifestSnapshot` above returns
  // only `{sha256, size}` (the CAS read-set baseline), never the parsed `projectId` this
  // handler's own `sessionScopeId` needs below. A failure here is a LOGGED, idempotent
  // refusal, in the exact shape as the read above — never a fabricated `workspaceIdentity`.
  const manifest = await wrap(context.deps.projectStore.readManifest());
  trace("kernel.turnStart", { step: "readManifest done" });
  if ("code" in manifest) {
    const reason = `turn.start refused — could not read project.toml's manifest for its workspaceIdentity: ${manifest.safeMessage}`;
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return abortEarlyAdmission(context, turnId, { ...manifest, safeMessage: reason });
  }

  // THE WHOLE TREE, IN ONE CALL (task 14; brief step 3). `listTree()` is the only enumeration
  // of the canonical tree — every file it names is staged, and the SAME result supplies each
  // file's read-set `sha256`/`size`, so the bytes staged and the bytes CAS-checked at finalize
  // can never come from two different reads.
  const treeList = await wrap(context.deps.designReader.listTree());
  trace("kernel.turnStart", { step: "listTree done" });
  if ("code" in treeList) {
    const reason = `turn.start refused — could not list the design tree: ${treeList.safeMessage}`;
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return abortEarlyAdmission(context, turnId, { ...treeList, safeMessage: reason });
  }

  const treeFiles: StagingTreeFileV1[] = treeList.map((file) => ({
    relPath: file.relPath,
    sourcePath: designTreeFilePath(context.deps.projectStore.root, file.relPath),
  }));
  const designFiles: StagedTurnReadSetV1["designFiles"] = treeList.map((file) => ({
    relPath: file.relPath,
    snapshot: { sha256: file.sha256, size: file.size },
  }));

  // `design/pages.json`, decoded — the page-ORDER authority for the agent's prompt. A decode
  // failure refuses the turn (the brief's own step 3: "refusing the turn on a decode failure
  // with the same `abortEarlyAdmission` shape the existing `listSlugs` failure uses") rather
  // than sending the agent an empty page order, which would read as "this project has no
  // pages" and invite it to recreate them. A tree that does not name `pages.json` AT ALL is a
  // different fact and IS an honest empty order — a project's first turn is the one that
  // creates the manifest; `readPageOrder` draws that line structurally (see its own doc), and
  // is handed the inventory just walked so it never re-walks the tree to do it.
  const treePathsForOrder = treeList.map((file) => file.relPath);
  const pageEntries = await wrap(readPageOrder(context.deps.designReader, treePathsForOrder));
  trace("kernel.turnStart", { step: "readManifest (design tree) done" });
  if ("code" in pageEntries) {
    const reason = `turn.start refused — could not decode design/pages.json: ${pageEntries.safeMessage}`;
    console.warn(`core/kernel/handlers/turn: ${reason}`);
    return abortEarlyAdmission(context, turnId, { ...pageEntries, safeMessage: reason });
  }
  const pageSlugs = pageEntries.map((entry) => entry.slug);

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
      const reason = `turn.start refused — could not fold pins for active page "${activePageSlug}": ${pins.safeMessage}`;
      console.warn(`core/kernel/handlers/turn: ${reason}`);
      return abortEarlyAdmission(context, turnId, { ...pins, safeMessage: reason });
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
        const reason = `turn.start refused — could not read pin append-base for active page "${activePageSlug}": ${pinsAppendBase.safeMessage}`;
        console.warn(`core/kernel/handlers/turn: ${reason}`);
        return abortEarlyAdmission(context, turnId, { ...pinsAppendBase, safeMessage: reason });
      }
      readSetPins.push({ pageSlug: activePageSlug, base: pinsAppendBase });
    }
  }

  // WP-7: the real resume-or-fresh decision (storage-identity §6.2), replacing the
  // unconditional `{kind: "fresh", seed}` this handler used to build directly from
  // `selectSeed`. `sessionScopeId` folds in `workspaceIdentity` (the manifest read just
  // above) and a documented `account: null` literal — see this file's own header,
  // "`baseTask.session: SessionPlan`," for the full account/cross-restart rationale.
  trace("kernel.turnStart", {
    step: "tree and pins folded",
    treeFileCount: treeFiles.length,
    pageCount: pageSlugs.length,
  });

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
      treeFiles,
      // NOW REAL (phase-8 WP-3) — see this file's header, "`runtimeDocs`," for the full
      // citation.
      runtimeDocs: context.deps.agentPromptSource.runtimeDocs(),
      readSet: {
        manifest: manifestSnapshot,
        designFiles,
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

  /**
   * THE TURN'S SEND-TIME TREE INVENTORY — the `before` side of design §7's closure diff, built
   * ONCE here and read by BOTH consumers below: the Gate's smoke scoping (design §8 step 8,
   * through `buildValidationInput`) and the turn's own `changedPages` report (through
   * `buildFinalizeInput`'s `selectChangedPages`).
   *
   * One construction, deliberately. Both answer the same question — "which pages changed since
   * this turn was sent" — from the same `designFiles` read set, and a second construction is the
   * shape in which the Gate could skip a page's smoke render while the very same turn reports
   * that page to the designer as changed.
   */
  const sendTimeTreeInventory = readSetTreeInventory(designFiles);

  /**
   * WHOLE-TREE, NOT PER-PAGE (task 14). `runTurnValidation` decides which pages exist by
   * decoding the candidate's OWN `design/pages.json`; this builder's job is to hand it the
   * tree, not a page list.
   *
   * `files` carries EVERY tree file's text with no filter of this ring's own — see
   * `RunTurnValidationInputV1.files`' own doc for why "no predicate" is the only choice that
   * cannot drift from `gate/model/tree-scan.ts`'s measured `isCodeFile`, and why Task 13's
   * closure-completeness contract makes a partial map worse than useless (a missing code file
   * makes its page report "unchanged" forever, or trips a refusal).
   *
   * `manifestText` comes straight off `TurnCandidateV1` — `freezeTurnCandidate` already read
   * `design/pages.json` back at freeze time (task 13), so the separate `decodeCachedUtf8` call
   * this builder used to make for the same file is gone.
   */
  const buildValidationInput: RunTurnInputV1["buildValidationInput"] = (
    candidate,
  ): RunTurnValidationMaterialV1 => ({
    manifestText: candidate.manifestText,
    treePaths: candidate.treeFiles.map((file) => file.relPath),
    // The same candidate file list with its hashes kept — what the Gate's smoke stage
    // hash-verifies the mounted closure against (design §9.2). Built through
    // `candidateTreeInventory` rather than open-coded so this and `buildFinalizeInput`'s
    // changed-page diff cannot disagree about the inventory's shape.
    treeInventory: candidateTreeInventory(candidate.treeFiles).files,
    // THE OTHER SIDE OF THE SAME DIFF (design §8 step 8): the tree as it stood when this turn
    // was SENT, so `runTurnValidation` can smoke only the pages whose closure actually moved.
    // The SAME value `buildFinalizeInput` diffs below for the turn's own `changedPages` report
    // — see {@link sendTimeTreeInventory}.
    sendTimeInventory: sendTimeTreeInventory,
    files: new Map(
      candidate.treeFiles.map((file) => [
        file.relPath,
        decodeCachedUtf8(cachingStaging, candidate.root, workspaceTreeRelPath(file.relPath)),
      ]),
    ),
    // The absolute staged candidate `design/` root (`gate/adapters/gate-runner.ts`'s CRITICAL
    // smoke finding, fixlane-K1-turn-spine.json): the real host `SmokeRenderer` resolves a
    // page's source via `Bun.file` inside a fresh scratch-directory child process, so a
    // tree-relative path never resolves there. `runTurnValidation` joins each entry onto it
    // for `runPage.treeRoot` and passes the SHORT tree-relative name as `entryRelPath`, so a
    // Gate rejection reports `pages/home.tsx`, never the absolute path.
    designRoot: `${candidate.root}/${DESIGN_DIRNAME}`,
  });

  let finalizeSummary: FinalizeSummaryV1 | null = null;
  // WP-7: captured the SAME way `finalizeSummary` above already is — from inside
  // `buildFinalizeInput`, the one closure that receives the LAST attempt's own
  // `TurnAttemptOutcomeV1` (`attempt.sessionId`, always present on a `"completed"` outcome).
  // Read after `runTurn` resolves, only on the `"committed"` branch below, to advance the
  // checkpoint for the scope `sessionScopeId` (Task 1) already resolved.
  let capturedSessionId: string | null = null;
  /**
   * The pin ids `runAdmission` confirmed still open and wrote onto this turn's durable user
   * record (`TurnContextV1.userRecord.pins`), captured through `RunTurnDeps.onAdmitted`. Empty
   * until admission succeeds, which is always before `buildFinalizeInput` can run.
   */
  let admittedPinIds: readonly string[] = [];

  const buildFinalizeInput: RunTurnInputV1["buildFinalizeInput"] = ({
    turnId,
    attempt,
    candidate,
    validation,
  }): RunTurnFinalizeMaterialV1 => {
    capturedSessionId = attempt.sessionId;
    // THE FILE DIFF: every design-tree file whose bytes moved this turn, tree-relative —
    // shared modules included, and no longer keyed by page at all (a `lib/theme.ts` edit has
    // no page of its own to be filed under, which is exactly why `ChangedPageOpV1` could not
    // survive the design tree).
    const changedFiles: ChangedDesignFileOpV1[] = [];
    for (const change of candidate.fileChanges) {
      if (change.change === "removed") {
        changedFiles.push({ relPath: change.relPath, change: "delete" });
        continue;
      }
      const bytes = cachingStaging.readCandidateBytes(
        candidate.root,
        workspaceTreeRelPath(change.relPath),
      );
      if (bytes === null) {
        console.warn(
          `core/kernel/handlers/turn: no cached candidate bytes for changed file "${change.relPath}" — dropping it from this attempt's finalize diff`,
        );
        continue;
      }
      changedFiles.push({ relPath: change.relPath, change: "replace", newBytes: bytes });
    }

    // THE PAGE DIFF, WHICH IS A DIFFERENT QUESTION (design §7). Not derivable from
    // `changedFiles`: an edit to `lib/theme.ts` changes what every page reaching it renders
    // while no page entry's own bytes move, so a diff keyed on entry-file hashes reports
    // "nothing changed" for every such page. `selectChangedPages` compares each entry's
    // CLOSURE hash across the two inventories, and its `closures` come from the same
    // whole-tree scan that just enforced the import allowlist — never recomputed here, since
    // `core` has no specifier resolver and may not import `gate`.
    //
    // Both inventories are built by `core/turns`' own exported helpers rather than open-coded
    // here: the two sides must agree on tree-relative paths and on "expected-absent means
    // omitted", and a caller re-deriving either one is how they come to disagree.
    const changedPageSlugs = selectChangedPages({
      closures: validation.closures,
      // The SAME send-time inventory `buildValidationInput` handed the Gate for its smoke
      // scoping (design §8 step 8) — built once above, so this report and that decision are
      // literally the same comparison, not two agreeing ones.
      beforeInventory: sendTimeTreeInventory,
      afterInventory: candidateTreeInventory(candidate.treeFiles),
    });

    finalizeSummary = {
      changedPages: terminalChangedPages(changedPageSlugs, validation.slice.pages, candidate),
      gateWarnings: validation.warnings.map((w) => ({ kind: w.kind, message: w.message })),
    };

    return {
      changedFiles,
      changedPageSlugs,
      requestedActivePage: validation.slice.active,
      agentRecord: {
        kind: "agent",
        recordId: uuidv7(),
        turnId,
        text: attempt.finalText,
        // The chat record names PAGES the user can see changed, not the tree files that moved
        // — a `lib/theme.ts` edit belongs in this list as the pages it altered, and the raw
        // path would mean nothing in a chat transcript.
        changedPages: [...changedPageSlugs],
        warnings: validation.warnings.map((w) => ({ kind: w.kind, message: w.message })),
        ts: context.deps.clock.now().toISOString(),
      },
      // THE PINS THIS MESSAGE CARRIED (defect fix, 2026-07-26).
      //
      // Hardcoded `[]` until now, which made `core/pins`'s `resolveSentPinAppends` — the
      // implementation of §12.2 item 8 / turn-durability §7.4 item 5, "sent pins are resolved
      // by this Kernel transaction after successful apply when their page is in non-empty
      // changedPages" — unreachable in production: it always received an empty list and always
      // returned no appends. A pin the user attached to a message stayed open forever, even
      // after the agent edited exactly that page in response, and had to be closed by hand.
      //
      // Built from the two halves that each know one field, joined here rather than either one
      // guessing the other: `admittedPinIds` is admission's OWN verdict on which candidates
      // were still open (the same list written to the durable user record, so what resolves is
      // exactly what the message is recorded as having carried), and `candidatePins` is where
      // this handler read each of those ids from, so it is the honest source of their page.
      // An id with no candidate entry is dropped rather than assigned a guessed page — it
      // cannot happen (every admitted id came from this very list) and is not worth inventing
      // a page slug for if it ever does.
      sentPins: admittedPinIds.flatMap((pinId) => {
        const candidate = candidatePins.find((pin) => pin.pinId === pinId);
        return candidate === undefined ? [] : [{ pinId, pageSlug: candidate.pageSlug }];
      }),
    };
  };

  // Resolved BEFORE `runTurn` runs, because afterwards the answer has already changed: this
  // turn's own admission is what appends the record that names the chat. See
  // {@link resolvePendingChatNaming}.
  const pendingChatNaming = await wrap(resolvePendingChatNaming(context, admittedChatId));

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
      publishChatNaming();
    }
    context.publishOperationEvent(event);
  }

  /**
   * Republishes the admitted chat's summary once its FIRST `user` record exists — the record
   * admission durably appended a moment before `turn.attemptStarted` fires.
   *
   * WHY (defect fix, 2026-07-26): `ChatSummaryV1.displayName` is derived, never stored (design
   * §3.9), and the Kernel filled it in exactly three places — `chat.create`, `chat.switch`,
   * `project.open`. None of them runs when a message is SENT, and `chat.create` publishes its
   * summary while the chat is still empty, so a chat created by `/new` kept
   * `displayName: null` for the rest of the session and the `/chats` popup showed the
   * design's own fresh-chat placeholder (`new chat — fresh context`) instead of the prompt the
   * user had actually sent — where the design shows only real names
   * (`design/termcraft-engine.js:1026-1039`, whose every sample row is a prompt). Switching
   * away and back, or restarting, was the only way to make the name appear.
   *
   * The name comes from `truncateChatDisplayName(text)` — the SAME §3.9 rule
   * `deriveChatDisplayName` applies to a loaded record, given the very text admission just
   * wrote — rather than re-reading the tail, which would cost another round trip to re-derive a
   * string this handler already holds.
   */
  function publishChatNaming(): void {
    if (pendingChatNaming === null || !isUuidv7(admittedChatId)) return;
    const displayName = truncateChatDisplayName(text);
    // A blank/whitespace-only first line is not a name (`display-name.ts`'s own rule) — leave
    // the summary alone rather than publish an empty label.
    if (displayName === null) return;
    context.publishOperationEvent({
      kind: "chat.changed",
      payload: {
        activeChatId: admittedChatId,
        added: [],
        updated: [{ chatId: admittedChatId, createdAt: pendingChatNaming.createdAt, displayName }],
        removedChatIds: [],
      },
      correlation: { turnId },
    });
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
    // Spec §1.5 — the one place the active turn id is cleared on a turn that actually ran.
    onSettled: () => context.setActiveTurnId(null),
    // The admission-resolved pin set — see {@link buildFinalizeInput}'s `sentPins`.
    onAdmitted: (admitted) => {
      admittedPinIds = admitted.userRecord.pins ?? [];
    },
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
    // Spec §1.4: an accepted command must reach a terminal event. Returning `[]` here advanced
    // the Kernel's revision with nothing published, which desynchronised every subscriber by
    // construction — the `STALE_REVISION` rejection on the NEXT `turn.start` was that desync,
    // not a second bug, and it disappears with this return value rather than a separate fix.
    return terminalizeRejectedAdmission(context, turnId, admittedChatId, result.outcome);
  }

  // Clear the attempt-handle slot too — `onAttemptStarted(null)` already ran for the LAST
  // attempt once its own outcome settled, but this is the one place that is true for every
  // reachable path (finalize or terminalize), so it is repeated here defensively rather than
  // trusted implicitly.
  context.turnRunner.setActiveAttempt(null);

  // `activeTurnId` is no longer cleared here — `RunTurnDeps.onSettled` (above) already cleared
  // it the instant the turn machine's own `settle` applied, before this `runTurn` promise even
  // resolved (fix-bundle spec §1.5). Clearing it again here, unconditionally, after the fact
  // would reopen exactly the mirror-image window this task closes.
  // `setCommitIntentRecorded(false)` still fires unconditionally here, though: `onCommitIntentRecorded`
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
    // THE EVENT THAT MAKES A TURN'S RESULT VISIBLE (defect fix, 2026-07-26).
    //
    // `page.descriptorsChanged` used to be published by `handlers/project.ts` alone, on project
    // open — even though its own reason union has always carried a `"turn-apply"` member. The
    // turn that actually writes a page announced nothing, and two things followed:
    //
    //   * `ui/mirror` sets `project.activePageSlug` from THIS event and no other. A brand-new
    //     project opens with an empty page list and `activePageSlug: null`, so after the FIRST
    //     turn created a page the slug was still null — and `ui/app/model/deps.ts`'s preview
    //     subscriber only asks for a session once a non-null slug appears. The first generation
    //     ended on "preparing preview…" forever: describe a TUI, never see it.
    //   * Editing the page already on screen was equally invisible — same slug, and the
    //     mirror's descriptor list kept the pre-turn `sourceHash`, so the live preview went on
    //     rendering the old source. Against the master design's own "The preview updates after
    //     the recoverable turn transaction commits."
    //
    // Ordered BEFORE `turn.completed` in the batch: a subscriber that reacts to the turn ending
    // by reading the page model should already see the pages that turn produced.
    const descriptorEvents = await wrap(publishPageDescriptorsChanged(context, "turn-apply"));
    return [
      ...descriptorEvents,
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
  // CLOSED": `failure`'s own `code` is as precise as `TerminalizeTurnResultV1`'s echoed
  // `reason` honestly allows — `terminalFailureDto` (above) does the narrowing — and, since
  // this fix, so is `outcome` itself.
  const branch =
    result.kind === "finalized"
      ? `finalized/${result.result.kind}`
      : `terminalized/${result.result.kind}`;
  const propagatedFailure = terminalFailureDto(result, branch);
  const outcome = terminalOutcomeCode(result);
  // §7.2's own vocabulary maps one-to-one onto the wire's three terminal event kinds
  // (`event-payload.ts:65`: "`turn.completed`/`turn.failed`/`turn.cancelled` ->
  // `TurnTerminalPayloadV1`"), so a cancel gets the kind that names it. Both consumers already
  // handle it — `ui/mirror/model/mirror.ts`'s terminal case lists all three kinds together, and
  // `entrypoint/model/run-app.ts`'s turn-settled wait already accepts `turn.cancelled`.
  const kind = outcome === "cancelled" ? "turn.cancelled" : "turn.failed";
  console.warn(
    `core/kernel/handlers/turn: turn.start ended on ${branch} — publishing ${kind} with outcome "${outcome}" (see ./turn.ts's header, "THE TERMINAL EVENT")`,
  );
  return [
    {
      kind,
      payload: {
        turnId,
        outcome,
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
  if (began.kind !== "changed") {
    // Unreachable given `beginAdmission`'s own table (`turn-machine.ts`) has no same-state
    // `noOp` row — kept explicit, in the same voice as the `illegal` branch just above, per
    // this project's "never silently assume success" rule.
    console.warn(
      `core/kernel/handlers/turn: beginTurn refused — beginAdmission returned "${began.kind}" (phase ${began.phase}) instead of a real transition`,
    );
    return [];
  }
  context.setActiveTurnId(turnId);
  context.launchOperation("kernel.turn.run", () => runTurnStart(turnId, input.text, context));
  return [turnStateChangedEvent("kernel.turn.beginAdmission", began, { turnId })];
}

function handleTurnStart(
  payload: CommandPayloadByKindV1["turn.start"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const events = beginTurn(context, { text: payload.text });
  // `beginTurn` returns `[]` ONLY on its own defensive illegal/no-op branches (nothing was
  // admitted, nothing was launched) — an empty list here is a genuine no-op, not a started
  // operation with zero events. Matches `handleTurnCancel`'s identical illegal/no-op ->
  // `noOpOutcome()` mapping just below.
  if (events.length === 0) return noOpOutcome();
  return startedOutcome(events);
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
