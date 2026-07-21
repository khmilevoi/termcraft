import type { FailureDtoV1 } from "core/protocol"
import type { SeedRecord } from "./agent-backend"

/**
 * `SessionCheckpointService` — the "session-checkpoint facade" this slice's plan (§2, 6D
 * scope) lists as upstream work `store` still owes: today's `workspace.local.toml` read/
 * write surface has no dedicated resume-decision method, only the raw
 * `SessionCheckpoint[]` array inside `WorkspaceStateV1` (`project-store.ts`). This port is
 * the narrow decision surface storage-identity §6.2 describes, so the resume/fresh/advance
 * policy has exactly one caller-facing shape instead of every turn-orchestration call site
 * re-deriving it from the raw checkpoint array.
 *
 * §6.2, verbatim on the mismatch rule this service enforces: "Before resume, the chat must
 * have at least `recordCount` valid records and the same hash for that exact prefix...
 * A shorter file, a changed prefix, a chat/header identity mismatch, a different scope, a
 * corrupt log, or an SDK resume rejection is a mismatch. On mismatch termcraft does not
 * call resume again with that checkpoint: it starts a fresh backend session and seeds it
 * with the newest complete chat records before the current user record... up to 32 records
 * and 64 KiB of UTF-8 text."
 */

/**
 * §6.2's resume verdict, already folded into `agent-backend.ts`'s `SessionPlan` shape so a
 * caller never re-derives one from the other: a `"resume"` verdict carries the exact
 * `sessionId`/`promptDelta` `SessionPlan`'s `resume` variant needs; `"fresh"` signals the
 * caller must build the seed via {@link SessionCheckpointService.selectSeed}.
 */
export type ResumeVerdictV1 = { readonly kind: "resume"; readonly sessionId: string; readonly promptDelta: string | null } | { readonly kind: "fresh" }

export interface SessionCheckpointService {
  /**
   * Compare the stored `(chatId, sessionScopeId)` checkpoint (if any) against the chat's
   * current valid-prefix state and decide resume vs. fresh (§6.2). A missing checkpoint, a
   * scope change, a shorter chat, a changed prefix hash, or a corrupt log all resolve to
   * `"fresh"` — never a thrown mismatch.
   */
  evaluateResume(input: { readonly chatId: string; readonly sessionScopeId: string }): Promise<FailureDtoV1 | ResumeVerdictV1>
  /** §6.2's bounded fresh-session seed: newest complete records before the current user record, chronological order, ≤32 records and ≤64 KiB UTF-8 (oldest dropped first to meet the byte bound). */
  selectSeed(chatId: string): Promise<FailureDtoV1 | readonly SeedRecord[]>
  /** §6.2: after the terminal agent outcome is durably appended, atomically advance the checkpoint to the prefix the backend session now reflects. Checkpoint-advance failure never changes chat history. */
  advanceCheckpoint(input: { readonly chatId: string; readonly sessionScopeId: string; readonly sessionId: string }): Promise<FailureDtoV1 | undefined>
}
