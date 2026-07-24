import { wrap } from "@reatom/core";

import type { TransitionOutcome, TurnAction, TurnState } from "core/machines";
import type { EventCorrelationV1, PublishableEventV1 } from "core/mailbox";
import type {
  AgentBackend,
  AgentTask,
  ChangedPageOpV1,
  ReadSetFileSnapshotV1,
  ReasoningEffort,
  SessionPlan,
  StagingPageSourceV1,
  StagingService,
  TurnWorkspaceV1,
} from "core/ports";
import type { CommandPayloadByKindV1, Sha256Hex, UUIDv7 } from "core/protocol";
import {
  type AdmissionInputV1,
  type RunTurnDeps,
  type RunTurnFinalizeMaterialV1,
  type RunTurnInputV1,
  type RunTurnResultV1,
  type RunTurnValidationMaterialV1,
  type TurnCandidateV1,
  createTurnDeadlines,
  foldGateDiagnosticsIntoPrompt,
  runTurn,
} from "core/turns";
import type { ChatSelection } from "entities/chat";
import { type PageSlug, parsePageSlug } from "entities/page";
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
 * - `turn.cancel` is real, end to end (unchanged from Step C2/C3 — see the function's own
 *   doc comment below for the full citation).
 *
 * - `turn.start` composes `runTurn` (`core/turns`) inside ONE `launchOperation` closure
 *   (`runTurnStart`, below). Every piece of `RunTurnInputV1` this closure builds:
 *
 *   `AdmissionInputV1.targetChatId` and the agent's `backend`/`model`/`effort` triple: ALL
 *   FOUR are read asynchronously via `context.deps.projectStore.readWorkspaceState()`
 *   (`WorkspaceStateV1.activeChatId`/`backend`/`model`/`effort`). A `null` in any of the
 *   four, or a `backend`/`model`/`effort` string the live `AgentRegistry` does not
 *   currently offer, is an IDEMPOTENT REFUSAL (logged, resolved with zero events) — never a
 *   fabricated default. `effort` is narrowed from the durable plain string to the branded
 *   `ReasoningEffort` union by looking it up inside the matched model's own
 *   `BackendCapabilities.models[].efforts: readonly ReasoningEffort[]` array (`.find(e => e
 *   === effort)`) — cast-free, since the array's own element type is already
 *   `ReasoningEffort`.
 *
 *   `pages: StagingPageSourceV1[]` / `readSet.canonicalPages`: one entry per
 *   `context.deps.pageReader.listSlugs()` result. Each page's `sourcePath` is built from
 *   `` `${context.deps.projectStore.root}/pages/${pageSlug}.tsx` `` (the canonical
 *   page-file layout `core/turns/model/candidate.ts`'s own `PAGE_FILE_PATTERN` already
 *   documents), and its `readSet.canonicalPages` entry's `sha256`/`size` come from the SAME
 *   `PageReader.readSource(pageSlug)` call this handler makes to resolve that fact honestly
 *   (never fabricated) — a read failure for an already-*listed* page blocks admission with a
 *   logged refusal, since `null` on that entry would falsely claim "expected absence."
 *
 *   `manifestSlice: Uint8Array`: `JSON.stringify({pages: <the SAME listSlugs() result>,
 *   active: <workspaceState.activePageSlug>})`, UTF-8 encoded — the exact `ManifestSliceV1`
 *   shape (`core/ports/gate-runner.ts`) `pages.json` already carries.
 *
 *   `readSet.manifest`/`readSet.chat`: `context.deps.projectStore.readManifestSnapshot()`
 *   and `context.deps.chatReader.readAppendBase(targetChatId)` — Gap 4's own two new
 *   primitives. Either failing is an idempotent refusal (logged) — never a fabricated CAS
 *   baseline (this project's hardest rule: a false baseline defeats the exact concurrent-
 *   mutation check the read-set exists to catch).
 *
 *   `runtimeDocs: []` / `candidatePins: []` / `readSet.pins: []`: honest empty values, not
 *   fabrications — no port anywhere in `KernelDeps` sources a runtime-doc file's content,
 *   tracks "which pins the composer currently shows as open," or names a contributing
 *   comments log, so an empty list here means exactly what it would for a turn genuinely
 *   sent with none of those, never a guess (mirrors `kernel.ts`'s own `PLACEHOLDER_GIT_STATUS`
 *   precedent for "a real value would need a port that does not exist yet").
 *
 *   `context.selection()`: read synchronously at the very top of `runTurnStart`, before any
 *   await, matching kernel-command-contract §12.2's "captures ... authoritative selection"
 *   — never from the payload, which carries none.
 *
 *   `baseTask.session: SessionPlan`: ALWAYS `{kind: "fresh", seed}`, seeded honestly via
 *   `context.deps.sessionCheckpoint.selectSeed(targetChatId)` (a REAL port call, real prior
 *   chat history — never fabricated). **Documented divergence, separate from Gap 4**:
 *   resuming a previous SDK session needs `AgentBackend.sessionScope({account, model,
 *   workspaceIdentity})`, and `workspaceIdentity` (turn-durability §6.3 item 4) has no
 *   durable `core/ports` source at all — it exists ONLY as a payload-only fact on
 *   `project.create`/`project.setTrust` (`ui/app/model/deps.ts`'s own `UiEnv.workspaceIdentity`),
 *   never persisted anywhere `core` can read back later. Building a `sessionScopeId` would
 *   need either fabricating `workspaceIdentity` or a NEW port primitive outside this task's
 *   authorized chat-store/project-store extension — flagged here for whoever closes it next,
 *   exactly like Gap 3/Gap 4 were each flagged in their own turn; a fresh (never resumed),
 *   honestly-seeded session is the sanctioned interim behavior, not a silent shortcut.
 *
 *   `baseTask.systemPrompt`: `TURN_START_SYSTEM_PROMPT_PLACEHOLDER` (below) — no port
 *   anywhere sources the compiled system-prompt text, and `agent/`'s own real prompt
 *   composition (`agent/session/model/prompt.ts`) lives outside `core`'s import boundary
 *   (module DAG: `core` imports only `entities/` + its own `ports/`) — mirrors `kernel.ts`'s
 *   own `PLACEHOLDER_GIT_STATUS` precedent for "a real value would need a port that does not
 *   exist yet," not a fabricated value dressed up as real.
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
 *   `turn.gateRejected` stream AS THEY HAPPEN. The very FIRST `turn.attemptStarted` this
 *   wrapper observes is also where `context.setActiveTurnId(event.payload.turnId)` fires —
 *   admission itself never surfaces a `turnId` to this driver's own caller (it is minted
 *   INSIDE `runAdmission`), but attempt 1 always starts immediately after a successful
 *   admission, so the FIRST `turn.attemptStarted` IS "admission just succeeded, with this
 *   turnId" for this purpose. `setActiveTurnId(null)` runs once `runTurn`'s own result is
 *   `terminalized`/`finalized` (never on `admission-rejected` — nothing was ever set). No
 *   `turn.started` event is separately published — this recipe deliberately treats the first
 *   `turn.attemptStarted` as sufficient proof "admission succeeded," a choice this file's own
 *   header has always documented rather than a silent omission.
 *
 *   THE ATTEMPT-HANDLE SLOT: `RunTurnDeps.onAttemptStarted` maps directly onto
 *   `context.turnRunner.setActiveAttempt` — the REAL handle `onAttemptStarted` hands over
 *   (never a separately hand-wrapped copy — see `run-turn.ts`'s own doc comment for exactly
 *   why that matters for `attempt.ts`'s internal `cancelRequested` coordination), closing
 *   Gap 2's remaining producer side: `turn.cancel`'s own `handle.requestCancel()` (below)
 *   now reaches the SAME `attempt.ts`-coordinated cancel path `startTurnAttempt` returns.
 *
 *   THE TERMINAL EVENT: once `runTurn` resolves, the ONE terminal batch event this operation
 *   returns is built from `RunTurnResultV1`:
 *   - `"finalized"` + `result.kind === "committed"` -> `turn.completed` with `outcome:
 *     "completed"`, the changed-page hashes and Gate warnings captured (by side channel)
 *     during the LAST `buildFinalizeInput` call, and `failure: null`.
 *   - `"finalized"` + `result.kind` is `"failed"`/`"illegal"`, or `"terminalized"` (cancelled,
 *     Gate-exhausted, deadline-exceeded, backend failure, ...): `RunTurnResultV1`'s own
 *     `TerminalizeTurnResultV1`/`FinalizeTurnResultV1` variants do NOT echo back which
 *     `TurnTerminalOutcome` (`cancelled`/`failed`/`stale`/`interrupted`) the composition
 *     originally requested — a genuine, separate gap this task's own scope does not cover
 *     (closing it would mean widening a landed `core/turns` return type, not extending
 *     `core/ports`). Rather than fabricate a precise-looking distinction this composition
 *     cannot honestly make, every one of these branches publishes `turn.failed` with
 *     `outcome: "failed"` and a generic `PERSISTENCE_FAILED` `failure` DTO carrying whatever
 *     detail IS available — logged with the real branch name for traceability. This is
 *     flagged, not silently smoothed over: a future task closing it should widen
 *     `TerminalizeTurnResultV1`/`FinalizeTurnResultV1` to echo the requested outcome, then
 *     replace this fallback with the precise mapping.
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
 * No `core/ports` surface sources the compiled system-prompt text (see this file's header)
 * — retained as an explicit, documented placeholder, mirroring `kernel.ts`'s own
 * `PLACEHOLDER_GIT_STATUS`, never silently invented as if it were real.
 */
const TURN_START_SYSTEM_PROMPT_PLACEHOLDER =
  "You are termcraft's page-authoring agent. Edit only files under the given workspace.";

/** The real staging store's own page-file convention, transcribed from `core/turns/model/candidate.ts`'s identical constant (that file's own header cites `store/sandbox/model/staging-store.ts`'s `stageAllFiles`). */
function pageFileRelPath(pageSlug: PageSlug): string {
  return `pages/${pageSlug}.tsx`;
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
 * Spreads `base`'s other three methods unchanged (`createTurnWorkspace`/`retireWorkspace`/
 * `readCandidateFile`) — safe because every `StagingService` in this ring (today's fakes,
 * and any adapter following the same closure-factory convention every other port
 * fake/adapter in this codebase uses) is plain closures over its own factory-local state,
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
 * The whole `turn.start` composition, run inside `launchOperation`'s own async closure (see
 * this file's header for the full recipe). Every port call is `await wrap(...)`-ed — code
 * after each await calls `context.publishOperationEvent`/`context.setActiveTurnId`, both of
 * which touch Reatom-adjacent state built inside `kernel.ts`'s own `context.start(...)` frame.
 */
async function runTurnStart(
  payload: CommandPayloadByKindV1["turn.start"],
  context: HandlerContext,
): Promise<readonly PublishableEventV1[]> {
  // Captured synchronously, before any await — kernel-command-contract §12.2's "captures
  // the authoritative selection" at the moment admission begins.
  const selection = toAdmissionSelection(context.selection());

  const workspaceState = await wrap(context.deps.projectStore.readWorkspaceState());
  if ("code" in workspaceState) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — could not read workspace state: ${workspaceState.safeMessage}`,
    );
    return [];
  }
  const { activeChatId, backend, model, effort, activePageSlug } = workspaceState.state;
  if (activeChatId === null || backend === null || model === null || effort === null) {
    console.warn(
      "core/kernel/handlers/turn: turn.start refused — no active chat or agent selection yet",
    );
    return [];
  }

  const resolvedAgent = resolveAgentSelection(context, backend, model, effort);
  if (resolvedAgent === null) return [];

  const chatAppendBase = await wrap(context.deps.chatReader.readAppendBase(activeChatId));
  if ("code" in chatAppendBase) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — could not read the active chat's append base: ${chatAppendBase.safeMessage}`,
    );
    return [];
  }
  const manifestSnapshot = await wrap(context.deps.projectStore.readManifestSnapshot());
  if ("code" in manifestSnapshot) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — could not read project.toml's snapshot: ${manifestSnapshot.safeMessage}`,
    );
    return [];
  }

  const pageSlugs = await wrap(context.deps.pageReader.listSlugs());
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
      sourcePath: `${context.deps.projectStore.root}/${pageFileRelPath(pageSlug)}`,
    });
    canonicalPages.push({
      pageSlug,
      snapshot: { sha256: source.sourceHash, size: source.bytes.byteLength },
    });
  }

  const manifestSlice = new TextEncoder().encode(
    JSON.stringify({ pages: pageSlugs, active: activePageSlug }),
  );

  const seedResult = await wrap(context.deps.sessionCheckpoint.selectSeed(activeChatId));
  if ("code" in seedResult) {
    console.warn(
      `core/kernel/handlers/turn: turn.start could not select a fresh-session seed for chat "${activeChatId}" — ${seedResult.safeMessage}; starting with an empty seed`,
    );
  }
  const sessionPlan: SessionPlan = { kind: "fresh", seed: "code" in seedResult ? [] : seedResult };

  const admission: AdmissionInputV1 = {
    targetChatId: activeChatId,
    text: payload.text,
    ...(selection !== null ? { selection } : {}),
    candidatePins: [],
    workspace: {
      pages,
      manifestSlice,
      runtimeDocs: [],
      readSet: {
        manifest: manifestSnapshot,
        canonicalPages,
        chat: chatAppendBase,
        pins: [],
      },
    },
  };

  const baseTask: Omit<AgentTask, "fence"> = {
    workspacePath: "/unset", // always overridden by runTurn from the minted turn workspace
    systemPrompt: TURN_START_SYSTEM_PROMPT_PLACEHOLDER,
    userMessage: payload.text,
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
      source: decodeCachedUtf8(cachingStaging, candidate.root, pageFileRelPath(pageSlug)),
    })),
  });

  let finalizeSummary: FinalizeSummaryV1 | null = null;

  const buildFinalizeInput: RunTurnInputV1["buildFinalizeInput"] = ({
    turnId,
    attempt,
    candidate,
    validation,
  }): RunTurnFinalizeMaterialV1 => {
    const changedPages: ChangedPageOpV1[] = [];
    for (const change of candidate.changes) {
      if (change.change === "removed") {
        changedPages.push({ pageSlug: change.pageSlug, change: "delete" });
        continue;
      }
      const bytes = cachingStaging.readCandidateBytes(
        candidate.root,
        pageFileRelPath(change.pageSlug),
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

  let capturedTurnId: UUIDv7 | null = null;
  function publish(
    event:
      | PublishableEventV1<"turn.attemptStarted">
      | PublishableEventV1<"turn.progress">
      | PublishableEventV1<"turn.gateRejected">,
  ): void {
    if (capturedTurnId === null && event.kind === "turn.attemptStarted") {
      capturedTurnId = event.payload.turnId;
      context.setActiveTurnId(capturedTurnId);
    }
    context.publishOperationEvent(event);
  }

  const runTurnDeps: RunTurnDeps = {
    machine: context.turnRunner.machine,
    clock: context.deps.clock,
    pinReader: context.deps.pinReader,
    turnTransactions: context.deps.turnTransactions,
    staging: cachingStaging.staging,
    agentBackend: resolvedAgent.agentBackend,
    gateRunner: context.deps.gateRunner,
    deadlines: createTurnDeadlines({ clock: context.deps.clock }),
    publish,
    foldGateDiagnosticsIntoPrompt,
    onAttemptStarted: (handle) => context.turnRunner.setActiveAttempt(handle),
  };

  const runTurnInput: RunTurnInputV1 = {
    admission,
    baseTask,
    buildValidationInput,
    buildFinalizeInput,
  };

  const result: RunTurnResultV1 = await wrap(runTurn(runTurnDeps, runTurnInput));

  if (result.kind === "admission-rejected") {
    console.warn(
      `core/kernel/handlers/turn: turn.start's admission was rejected (${result.outcome.kind})`,
    );
    return [];
  }

  // Clear the attempt-handle slot too — `onAttemptStarted(null)` already ran for the LAST
  // attempt once its own outcome settled, but this is the one place that is true for every
  // reachable path (finalize or terminalize), so it is repeated here defensively rather than
  // trusted implicitly.
  context.turnRunner.setActiveAttempt(null);

  if (capturedTurnId === null) {
    // Unreachable given `runTurn`'s own sequencing (an attempt always starts, and therefore
    // publishes `turn.attemptStarted`, before either `finalizeTurn` or `terminalizeTurn` can
    // ever run) — kept explicit per this project's "never silently assume success" rule.
    console.warn(
      "core/kernel/handlers/turn: turn.start reached a terminal RunTurnResultV1 without ever observing turn.attemptStarted",
    );
    return [];
  }
  context.setActiveTurnId(null);

  if (result.kind === "finalized" && result.result.kind === "committed") {
    const summary: FinalizeSummaryV1 = finalizeSummary ?? { changedPages: [], gateWarnings: [] };
    return [
      {
        kind: "turn.completed",
        payload: {
          turnId: capturedTurnId,
          outcome: "completed",
          changedPages: summary.changedPages,
          warnings: summary.gateWarnings.map((w) => ({ code: w.kind, safeMessage: w.message })),
          failure: null,
        },
        correlation: { turnId: capturedTurnId },
      },
    ];
  }

  // See this file's header, "THE TERMINAL EVENT": neither `FinalizeTurnResultV1` nor
  // `TerminalizeTurnResultV1` echoes back which `TurnTerminalOutcome` was originally
  // requested, so a precise cancelled/failed/stale/interrupted distinction is not honestly
  // constructible here — flagged, not fabricated.
  const branch =
    result.kind === "finalized"
      ? `finalized/${result.result.kind}`
      : `terminalized/${result.result.kind}`;
  console.warn(
    `core/kernel/handlers/turn: turn.start ended on ${branch} — publishing a generic turn.failed (see ./turn.ts's header, "THE TERMINAL EVENT")`,
  );
  return [
    {
      kind: "turn.failed",
      payload: {
        turnId: capturedTurnId,
        outcome: "failed",
        changedPages: [],
        warnings: [],
        failure: {
          code: "PERSISTENCE_FAILED",
          retryable: false,
          safeMessage: `the turn ended without committing (${branch})`,
          details: {},
        },
      },
      correlation: { turnId: capturedTurnId },
    },
  ];
}

function handleTurnStart(
  payload: CommandPayloadByKindV1["turn.start"],
  context: HandlerContext,
): CommandOutcomeV1 {
  context.launchOperation("kernel.turn.run", () => runTurnStart(payload, context));
  return startedOutcome([]);
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
