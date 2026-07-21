import { wrap } from "@reatom/core";

import type { StateMachine, TurnAction, TurnState } from "core/machines";
import type {
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
import { uuidv7 } from "infrastructure/uuid";

import type { AdmissionCandidatePinV1, AdmissionInputV1, AdmissionOutcomeV1 } from "../types";
import { createTurnFence } from "./fence";
import { toFinalizeReadSet } from "./read-set";

/**
 * `turn.start` -> admission: `idle -> admitting -> workspace-ready`
 * (kernel-command-contract §7.2, §12.2 item 1; turn-durability §7.2).
 *
 * §7.2's `beginAdmission` row is one bundled rule: "Mints `turnId`; captures target chat,
 * valid selection, and resolvable open pins." That bundle is exactly what runs right after
 * the `idle -> admitting` transition succeeds below — the transition is checked FIRST so a
 * rejected admission (already active) never wastes a `turnId` or touches a port.
 *
 * `finishAdmission`'s row requires three separately provable preconditions before
 * `admitting -> workspace-ready` is legal: "committed user-record admission plus a
 * verified unique per-turn workspace and complete read-set hashes." This function proves
 * each one in order and refuses to call `finishAdmission` unless all three hold:
 *
 * 1. `turnTransactions.admit(...)` commits the user record BEFORE anything else — a
 *    workspace for a turn whose user record never committed is an orphan (turn-durability
 *    §7.7 is the cleanup path for exactly that), so this call is always first.
 * 2. `staging.createTurnWorkspace(...)` returns the verified unique per-turn workspace —
 *    called only after step 1 committed.
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
  const begin = deps.machine.apply("beginAdmission");
  if (begin.kind === "illegal") return { kind: "illegal", code: begin.code };

  const turnId = uuidv7();
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
  if ("code" in admissionCommit)
    return { kind: "blocked", phase: "admit", failure: admissionCommit };

  const workspaceInput: CreateTurnWorkspaceInputV1 = {
    turnId,
    targetChatId: input.targetChatId,
    pages: input.workspace.pages,
    manifestSlice: input.workspace.manifestSlice,
    runtimeDocs: input.workspace.runtimeDocs,
    readSet: input.workspace.readSet,
  };
  const workspace = await wrap(deps.staging.createTurnWorkspace(workspaceInput));
  if ("code" in workspace) return { kind: "blocked", phase: "workspace", failure: workspace };

  const readSet = toFinalizeReadSet(workspace.readSet);
  if (readSet instanceof Error) return { kind: "blocked", phase: "read-set", error: readSet };

  const fence = createTurnFence(turnId);
  if (fence instanceof Error) return { kind: "blocked", phase: "fence", error: fence };

  const finish = deps.machine.apply("finishAdmission");
  if (finish.kind === "illegal") return { kind: "illegal", code: finish.code };

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
