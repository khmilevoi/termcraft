import type {
  StagedTurnReadSetV1,
  StagingPageSourceV1,
  StagingRuntimeDocV1,
  TurnCommitV1,
  TurnReadSetV1,
  TurnWorkspaceV1,
} from "core/ports";
import type { CommandRejectionCode, FailureDtoV1, UUIDv7 } from "core/protocol";
import type { ChatSelection, ChatUserRecord } from "entities/chat";
import type { PageSlug } from "entities/page";

import type { TurnFence, TurnFenceError } from "./model/fence";
import type { ReadSetTranslationError } from "./model/read-set";

/**
 * `core/turns`'s shared vocabulary (CLAUDE.md "Code style": `types.ts` holds a module's
 * shared types). Each file's own dependency shape (its `*Deps` interface) stays local to
 * that file, matching `core/project/types.ts`'s precedent — only the request/outcome
 * shapes more than one turn-lifecycle file will pattern-match on live here.
 */

/**
 * One pin the caller currently shows as open and wants re-resolved live at admission
 * (kernel-command-contract §12.2 item 1: "only currently open, resolvable pins" — the UI
 * "neither selects persisted pin ids nor writes chat/pin storage", so this is a candidate
 * to re-check, never a pre-decided inclusion).
 */
export interface AdmissionCandidatePinV1 {
  readonly pageSlug: PageSlug;
  readonly pinId: string;
}

/**
 * The raw material `StagingService.createTurnWorkspace` needs verbatim, minus the
 * `turnId`/`targetChatId` admission itself mints/captures.
 *
 * `readSet.chat` is deliberately EXCLUDED from what the caller supplies (`Omit<...,
 * "chat">`, not the full `StagedTurnReadSetV1`): the honest chat append-base is a fact
 * about the chat's state IMMEDIATELY AFTER this turn's own user record commits during
 * admission (turn-durability §7.2 step 3 precedes step 4's read-set capture) —  no caller
 * outside `runAdmission` itself can observe that moment, since it happens strictly between
 * `turnTransactions.admit(...)` and `staging.createTurnWorkspace(...)`, both internal to
 * that one function. A caller-supplied `chat` value here would necessarily be captured
 * either too early (before its own turn's user record exists) or fabricated — `admission.ts`
 * re-reads it itself, at the only honest moment, via its own `chatReader` dependency.
 */
export interface AdmissionWorkspaceMaterialV1 {
  readonly pages: readonly StagingPageSourceV1[];
  readonly manifestSlice: Uint8Array;
  readonly runtimeDocs: readonly StagingRuntimeDocV1[];
  readonly readSet: Omit<StagedTurnReadSetV1, "chat">;
}

/**
 * Everything `runAdmission` needs beyond its injected ports: the message text, the
 * Kernel's own already-resolved target chat and selection (never accepted from the UI at
 * `turn.start` — kernel-command-contract §12.2 item 1), the candidate open pins to
 * re-resolve live, and the workspace-assembly material.
 */
export interface AdmissionInputV1 {
  /**
   * Minted by the CALLER, in the same synchronous step that applied `beginAdmission` and
   * recorded the id as the Kernel's active turn (fix-bundle spec §1.2). It is not minted here
   * any more: an id born inside this function could not reach `activeTurnIdAtom` until the first
   * `turn.attemptStarted` published, which a rejected admission never does — so every non-idle
   * phase reached through a failed admission carried a `null` active turn id and could not be
   * cancelled. See `core/kernel/model/handlers/turn.ts`'s `beginTurn` for the trio.
   */
  readonly turnId: UUIDv7;
  readonly targetChatId: string;
  readonly text: string;
  readonly selection?: ChatSelection;
  readonly candidatePins: readonly AdmissionCandidatePinV1[];
  readonly workspace: AdmissionWorkspaceMaterialV1;
}

/**
 * Which of `finishAdmission`'s three §7.2 preconditions (committed user record, verified
 * workspace, complete read-set hashes) a run stopped at, plus the fence mint that follows
 * them. `"chat-append-base"` sits between `"admit"` and `"workspace"`: the honest
 * post-admission chat append-base read (this file's own header) that the "complete
 * read-set hashes" precondition depends on, but that can genuinely fail independently of
 * both `admit` and `workspace` (a `ChatReader` failure, not a `TurnTransactionService` or
 * `StagingService` one).
 */
export type AdmissionBlockedPhaseV1 =
  | "admit"
  | "chat-append-base"
  | "workspace"
  | "read-set"
  | "fence";

/**
 * The fully captured turn identity `workspace-ready` carries forward to the attempt/
 * finalize slices this same 6F effort lands elsewhere: the minted `turnId`, the captured
 * chat/selection/pins (folded into `userRecord`), the committed admission receipt, the
 * verified unique workspace, the finalize-shaped read-set baseline, and the minted (but
 * not yet begun) attempt fence.
 */
export interface TurnContextV1 {
  readonly turnId: UUIDv7;
  readonly targetChatId: string;
  readonly userRecord: ChatUserRecord;
  readonly admissionCommit: TurnCommitV1;
  readonly workspace: TurnWorkspaceV1;
  readonly readSet: TurnReadSetV1;
  readonly fence: TurnFence;
}

export type AdmissionOutcomeV1 =
  /**
   * `finishAdmission` was refused because the machine had already left `admitting` — in practice
   * always a `turn.cancel` that raced the admission's own multi-step async work
   * (`turn-machine.ts` lists `{from:"admitting", to:"terminalizing"}` for `requestCancel`).
   *
   * `userRecordCommitted` says whether the user's message ALREADY landed durably before that
   * happened, which it usually has: `runAdmission` commits it well before the transition it then
   * fails on. Without this flag the caller reported "the turn could not be admitted" and wrote it
   * into the chat directly beneath the user's own visible message — a status contradicted by the
   * line above it (defect fix, 2026-07-26).
   */
  | {
      readonly kind: "illegal";
      readonly code: CommandRejectionCode;
      readonly userRecordCommitted: boolean;
    }
  | {
      readonly kind: "blocked";
      readonly phase: "admit" | "chat-append-base" | "workspace";
      readonly failure: FailureDtoV1;
    }
  | {
      readonly kind: "blocked";
      readonly phase: "read-set";
      readonly error: ReadSetTranslationError;
    }
  | { readonly kind: "blocked"; readonly phase: "fence"; readonly error: TurnFenceError }
  | { readonly kind: "workspace-ready"; readonly context: TurnContextV1 };
