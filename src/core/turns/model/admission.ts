import { wrap } from "@reatom/core";

import type { StateMachine, TurnAction, TurnState } from "core/machines";
import type {
  ChatReader,
  CreateTurnWorkspaceInputV1,
  PinReader,
  StagingService,
  TurnAdmissionInputV1,
  TurnTransactionService,
} from "core/ports";
import type { ChatUserRecord } from "entities/chat";
import type { PageSlug } from "entities/page";
import type { Pin } from "entities/pin";
import type { Clock } from "infrastructure/clock";
import { trace } from "infrastructure/debug-log";
import { uuidv7 } from "infrastructure/uuid";

import type { AdmissionCandidatePinV1, AdmissionInputV1, AdmissionOutcomeV1 } from "../types";
import { createTurnFence } from "./fence";
import { toFinalizeReadSet } from "./read-set";

/**
 * `turn.start` -> admission: `idle -> admitting -> workspace-ready`
 * (kernel-command-contract §7.2, §12.2 item 1; turn-durability §7.2).
 *
 * §7.2's `beginAdmission` row is one bundled rule: "Mints `turnId`; captures target chat,
 * valid selection, and resolvable open pins." The MINT half moved to the caller (fix-bundle
 * spec §1.2 — see the body); the capture half is still exactly what runs below. The caller has
 * already proven `beginAdmission` was legal before this function is ever entered, so a turn
 * that is already active never reaches here at all.
 *
 * `finishAdmission`'s row requires three separately provable preconditions before
 * `admitting -> workspace-ready` is legal: "committed user-record admission plus a
 * verified unique per-turn workspace and complete read-set hashes." This function proves
 * each one in order and refuses to call `finishAdmission` unless all three hold:
 *
 * 1. `turnTransactions.admit(...)` commits the user record BEFORE anything else — a
 *    workspace for a turn whose user record never committed is an orphan (turn-durability
 *    §7.7 is the cleanup path for exactly that), so this call is always first.
 * 1b. `chatReader.readAppendBase(input.targetChatId)` — read IMMEDIATELY after step 1
 *    commits, never before. This IS the "complete read-set hashes" precondition's chat
 *    fact (part of item 3 below, called out as its own numbered step because it is the
 *    fix for a real production bug: reading this append base BEFORE `admit()` — as an
 *    earlier version of this composition did, one level up in `core/kernel/model/
 *    handlers/turn.ts` — captures the chat's state one record too early. `finalizeTurn`'s
 *    own CAS precondition (`store/transaction/model/wrappers.ts`'s
 *    `buildFinalizeCasPrecondition`) re-observes the chat's CURRENT state at finalize
 *    time, which by then already includes this exact turn's own just-admitted user
 *    record — so a baseline captured before `admit()` is stale by construction on EVERY
 *    turn, not a corner case, and `finalize()` always fails `APPLY_STALE`/`chat`. Reading
 *    it here, right after `admit()` durably lands, is the only point in this whole
 *    composition where the "send-time" chat fact turn-durability §7.5 re-checks can be
 *    captured honestly. A failure here blocks phase `"chat-append-base"` — the workspace
 *    is never created for a turn whose read-set cannot be completed.
 * 2. `staging.createTurnWorkspace(...)` returns the verified unique per-turn workspace —
 *    called only after steps 1 and 1b succeeded, with the freshly-read `chat` append base
 *    folded into its `readSet` (never the caller's own `input.workspace.readSet`, which
 *    carries no `chat` field at all per `AdmissionWorkspaceMaterialV1`'s own header).
 * 3. `toFinalizeReadSet(workspace.readSet)` (already landed in this slice) translates the
 *    staged read set into the finalize-time shape without loss — a `ReadSetTranslationError`
 *    here means the read-set hashes are not "complete" and finalization must not proceed.
 *
 * The attempt fence is minted (`createTurnFence(turnId)`) once all three preconditions
 * hold, but `beginAttempt` is NEVER called here — §7.2: "The first per-attempt lease nonce
 * is minted only when attempt 1 starts," which belongs to the attempt slice, not admission.
 *
 * REATOM NOTE: every port call below is `await wrap(...)`-ed, matching `open-sequence.ts`'s
 * and `page-mutations.ts`'s identical rule — code after each await calls `deps.machine.apply`
 * (a Reatom write), and a plain unwrapped `await` would resume outside the caller's
 * `context.start(...)` frame, landing that write on the wrong instance rather than throwing.
 */

export interface AdmissionDeps {
  readonly machine: StateMachine<TurnState, TurnAction>;
  readonly clock: Clock;
  readonly pinReader: PinReader;
  readonly turnTransactions: TurnTransactionService;
  readonly staging: StagingService;
  /** Only `readAppendBase` is needed — see this file's header, step 1b, for why this must be read here, after `admit()`, never earlier. */
  readonly chatReader: Pick<ChatReader, "readAppendBase">;
}

/**
 * Re-resolves each candidate pin LIVE against the current fold — never trusting a
 * caller-supplied status. Distinct page slugs are folded exactly once, in first-occurrence
 * order, regardless of how many candidates reference that page.
 *
 * A candidate that cannot be resolved (its page's fold failed, or the pinId is absent, or
 * it is no longer `open`) is simply DROPPED — never captured, and never causing the whole
 * admission to fail. A fold FAILURE is still swallowed here (kernel-command-contract §12.2
 * item 1 never makes a stale pin reference fatal to sending a new message), but per the
 * errore rule against silently swallowing errors, it is logged before being dropped.
 */
async function resolveOpenPins(
  pinReader: PinReader,
  candidates: readonly AdmissionCandidatePinV1[],
): Promise<string[]> {
  const pageSlugs: PageSlug[] = [];
  for (const candidate of candidates) {
    if (!pageSlugs.includes(candidate.pageSlug)) pageSlugs.push(candidate.pageSlug);
  }

  const foldedByPage = new Map<PageSlug, readonly Pin[]>();
  for (const pageSlug of pageSlugs) {
    const pins = await wrap(pinReader.fold(pageSlug));
    if ("code" in pins) {
      console.warn(
        `admission: dropping candidate pins on page "${pageSlug}" — fold failed: ${pins.safeMessage}`,
      );
      continue;
    }
    foldedByPage.set(pageSlug, pins);
  }

  const resolved: string[] = [];
  for (const candidate of candidates) {
    if (resolved.includes(candidate.pinId)) continue;
    const pins = foldedByPage.get(candidate.pageSlug);
    if (pins === undefined) continue;
    const match = pins.find((pin) => pin.pinId === candidate.pinId);
    if (match === undefined) continue;
    if (match.status !== "open") continue;
    resolved.push(candidate.pinId);
  }
  return resolved;
}

export async function runAdmission(
  deps: AdmissionDeps,
  input: AdmissionInputV1,
): Promise<AdmissionOutcomeV1> {
  // ENTERED ALREADY `admitting` (fix-bundle spec §1.2). The `idle -> admitting` transition and
  // `setActiveTurnId(input.turnId)` are applied together, synchronously, by
  // `core/kernel/model/handlers/turn.ts`'s `beginTurn` — with no `await` between them, which is
  // what the "non-idle phase implies a non-null activeTurnId" invariant actually rests on
  // (`core/capabilities/types.ts`). This function therefore neither applies `beginAdmission` nor
  // mints a turnId of its own; `finishAdmission` below is still its job.
  const turnId = input.turnId;
  const createdAt = deps.clock.now().toISOString();

  const resolvedPinIds = await wrap(resolveOpenPins(deps.pinReader, input.candidatePins));

  const userRecord: ChatUserRecord = {
    kind: "user",
    recordId: uuidv7(),
    turnId,
    text: input.text,
    ts: createdAt,
    ...(input.selection !== undefined ? { selection: input.selection } : {}),
    ...(resolvedPinIds.length > 0 ? { pins: resolvedPinIds } : {}),
  };

  const admissionInput: TurnAdmissionInputV1 = {
    turnId,
    targetChatId: input.targetChatId,
    userRecord,
    createdAt,
  };
  const admissionCommit = await wrap(deps.turnTransactions.admit(admissionInput));
  if ("code" in admissionCommit) {
    // DIAGNOSTIC (infrastructure/debug-log): the admission commit port call itself failed —
    // the earliest possible admission failure, before any workspace or read-set work started.
    trace("core.turns.admission.outcome", {
      turnId,
      kind: "blocked",
      phase: "admit",
      failure: admissionCommit,
    });
    return { kind: "blocked", phase: "admit", failure: admissionCommit };
  }

  // Read the chat's append base ONLY NOW, right after the commit above lands — see this
  // file's header, step 1b, for why any earlier read is stale by construction.
  const chatAppendBase = await wrap(deps.chatReader.readAppendBase(input.targetChatId));
  if ("code" in chatAppendBase) {
    // DIAGNOSTIC (infrastructure/debug-log): the user record committed, but reading the chat
    // append base right after failed — the workspace is never created for this turn.
    trace("core.turns.admission.outcome", {
      turnId,
      kind: "blocked",
      phase: "chat-append-base",
      failure: chatAppendBase,
    });
    return { kind: "blocked", phase: "chat-append-base", failure: chatAppendBase };
  }

  const workspaceInput: CreateTurnWorkspaceInputV1 = {
    turnId,
    targetChatId: input.targetChatId,
    treeFiles: input.workspace.treeFiles,
    runtimeDocs: input.workspace.runtimeDocs,
    readSet: { ...input.workspace.readSet, chat: chatAppendBase },
  };
  const workspace = await wrap(deps.staging.createTurnWorkspace(workspaceInput));
  if ("code" in workspace) {
    // DIAGNOSTIC (infrastructure/debug-log): the turn workspace could not be created on disk.
    trace("core.turns.admission.outcome", {
      turnId,
      kind: "blocked",
      phase: "workspace",
      failure: workspace,
    });
    return { kind: "blocked", phase: "workspace", failure: workspace };
  }

  const readSet = toFinalizeReadSet(workspace.readSet);
  if (readSet instanceof Error) {
    // DIAGNOSTIC (infrastructure/debug-log): the staged read-set could not translate to the
    // finalize-time shape — an internal invariant violation.
    trace("core.turns.admission.outcome", {
      turnId,
      kind: "blocked",
      phase: "read-set",
      error: readSet.message,
    });
    return { kind: "blocked", phase: "read-set", error: readSet };
  }

  const fence = createTurnFence(turnId);
  if (fence instanceof Error) {
    // DIAGNOSTIC (infrastructure/debug-log): the attempt fence could not be minted for this turn.
    trace("core.turns.admission.outcome", {
      turnId,
      kind: "blocked",
      phase: "fence",
      error: fence.message,
    });
    return { kind: "blocked", phase: "fence", error: fence };
  }

  const finish = deps.machine.apply("finishAdmission");
  if (finish.kind === "illegal") {
    // A raced `turn.cancel` is the only thing that gets here (`turn-machine.ts`:
    // `requestCancel` is `{from:"admitting", to:"terminalizing"}`), and by now this function has
    // already committed the user's chat record AND created a real turn workspace on disk.
    //
    // RETIRE IT (defect fix, 2026-07-26). This branch used to return with `workspace` simply
    // dropped, and no caller retires it either — `retireWorkspace` had no production call site
    // at all — so every cancel landing in this window leaked a staged workspace directory that
    // nothing would ever clean up. A retire failure is logged, never propagated (errore rule
    // 21): the admission is already refused, and failing to tidy up must not change what the
    // caller reports.
    const retired = await wrap(deps.staging.retireWorkspace(workspace));
    if (retired !== undefined) {
      console.warn(
        `admission: could not retire the staged workspace for cancelled turn ${turnId}: ${retired.safeMessage}`,
      );
    }
    // DIAGNOSTIC (infrastructure/debug-log): a raced cancel landed during admission — the chat
    // record and workspace already exist on disk/durably, but admission itself is refused.
    trace("core.turns.admission.outcome", { turnId, kind: "illegal", code: finish.code });
    return { kind: "illegal", code: finish.code, userRecordCommitted: true };
  }

  // DIAGNOSTIC (infrastructure/debug-log): admission succeeded — the turn workspace is ready
  // and the first attempt is about to start.
  trace("core.turns.admission.outcome", { turnId, kind: "workspace-ready" });
  return {
    kind: "workspace-ready",
    context: {
      turnId,
      targetChatId: input.targetChatId,
      userRecord,
      admissionCommit,
      workspace,
      readSet,
      fence,
    },
  };
}
