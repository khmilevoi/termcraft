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

/** The raw material `StagingService.createTurnWorkspace` needs verbatim, minus the `turnId`/`targetChatId` admission itself mints/captures. */
export interface AdmissionWorkspaceMaterialV1 {
  readonly pages: readonly StagingPageSourceV1[];
  readonly manifestSlice: Uint8Array;
  readonly runtimeDocs: readonly StagingRuntimeDocV1[];
  readonly readSet: StagedTurnReadSetV1;
}

/**
 * Everything `runAdmission` needs beyond its injected ports: the message text, the
 * Kernel's own already-resolved target chat and selection (never accepted from the UI at
 * `turn.start` — kernel-command-contract §12.2 item 1), the candidate open pins to
 * re-resolve live, and the workspace-assembly material.
 */
export interface AdmissionInputV1 {
  readonly targetChatId: string;
  readonly text: string;
  readonly selection?: ChatSelection;
  readonly candidatePins: readonly AdmissionCandidatePinV1[];
  readonly workspace: AdmissionWorkspaceMaterialV1;
}

/** Which of `finishAdmission`'s three §7.2 preconditions (committed user record, verified workspace, complete read-set hashes) a run stopped at, plus the fence mint that follows them. */
export type AdmissionBlockedPhaseV1 = "admit" | "workspace" | "read-set" | "fence";

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
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode }
  | {
      readonly kind: "blocked";
      readonly phase: "admit" | "workspace";
      readonly failure: FailureDtoV1;
    }
  | {
      readonly kind: "blocked";
      readonly phase: "read-set";
      readonly error: ReadSetTranslationError;
    }
  | { readonly kind: "blocked"; readonly phase: "fence"; readonly error: TurnFenceError }
  | { readonly kind: "workspace-ready"; readonly context: TurnContextV1 };
