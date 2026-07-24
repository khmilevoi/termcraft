import type {
  AssertConforms,
  ResumeVerdictV1,
  SeedRecord,
  SessionCheckpointService,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import type { ChatRecord } from "entities/chat";
import { evaluateSessionResume, readChatJsonl, selectSeedRecords } from "store/jsonl";
import { FsAccessError, isNotFound } from "store/safe-fs";
import { chatJsonlPath } from "store/transaction";

import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";
import { nowIso } from "./types";

// `createSessionCheckpointAdapter` — the `SessionCheckpointService` port composing
// `evaluateSessionResume`/`selectSeedRecords` (`store/jsonl/model/checkpoint.ts`, re-exported
// `store/index.ts`) with `OpenProject.workspaceState`/`safeFs`/`transactions` (plan Task 3).
//
// FLAGGED, NOT GUESSED — `evaluateResume`'s "resume" verdict needs `promptDelta: string|null`
// (`core/ports/agent-backend.ts`'s `SessionPlan.resume`), but `evaluateSessionResume`'s own
// "resume" delta is `readonly ChatRecord[]` — a rendering decision no already-landed `core/`
// caller makes yet (nothing constructs a `SessionPlan` from a real `ResumeVerdictV1` in this
// codebase today). `renderPromptDelta` below is a PROVISIONAL, clearly-labeled transcript
// rendering (`"User: <text>"` / `"Agent: <text>"` / `"System: <text>"`, joined by blank
// lines; `null` for an empty delta) — mirroring `core/kernel/model/handlers/turn.ts`'s own
// `PLACEHOLDER_GIT_STATUS` precedent for "a real value would need a decision that does not
// exist yet." FLAG FOR THE MAINTAINER: confirm the intended prompt-delta rendering before
// this path carries a real resumed session.
//
// FLAGGED, NOT GUESSED — `advanceCheckpoint`'s port input carries no `recordCount`, but
// store's `AdvanceSessionCheckpointInput` requires one. Resolved via honest composition: the
// port's own doc says this runs "after the terminal agent outcome is durably appended" — by
// call time the chat's CURRENT full record count already IS the prefix the backend session
// reflects, so this adapter reads it fresh off disk rather than inventing a value.

function recordDisplayText(record: ChatRecord): string {
  return record.kind === "system:restore" ? "" : record.text;
}

function roleLabelOf(record: ChatRecord): string {
  if (record.kind === "user") return "User";
  if (record.kind === "agent") return "Agent";
  return "System";
}

/** See this file's header — a provisional, flagged transcript rendering, not a settled convention. */
function renderPromptDelta(delta: readonly ChatRecord[]): string | null {
  if (delta.length === 0) return null;
  return delta.map((record) => `${roleLabelOf(record)}: ${recordDisplayText(record)}`).join("\n\n");
}

export function createSessionCheckpointAdapter(deps: StoreAdapterDeps): SessionCheckpointService {
  const { open } = deps;

  async function evaluateResume(input: {
    readonly chatId: string;
    readonly sessionScopeId: string;
  }): Promise<FailureDtoV1 | ResumeVerdictV1> {
    const workspace = await open.workspaceState.read();
    if (workspace instanceof Error) return toFailureDto(workspace);

    const checkpoint = workspace.state.sessionCheckpoints.find(
      (entry) => entry.chatId === input.chatId && entry.sessionScopeId === input.sessionScopeId,
    );
    if (checkpoint === undefined) return { kind: "fresh" };

    const chatPath = chatJsonlPath(input.chatId);
    const bytes = open.safeFs.readFile(chatPath);
    if (bytes instanceof Error) return toFailureDto(bytes);

    const decision = evaluateSessionResume({
      checkpoint,
      sessionScopeId: input.sessionScopeId,
      chatId: input.chatId,
      chunks: [bytes],
      currentUserRecordId: null,
    });
    if (decision.kind === "fresh") return { kind: "fresh" };
    return {
      kind: "resume",
      sessionId: decision.sessionId,
      promptDelta: renderPromptDelta(decision.delta),
    };
  }

  async function selectSeed(chatId: string): Promise<FailureDtoV1 | readonly SeedRecord[]> {
    const chatPath = chatJsonlPath(chatId);
    const bytes = open.safeFs.readFile(chatPath);
    if (bytes instanceof Error) {
      if (bytes instanceof FsAccessError && isNotFound(bytes)) return [];
      return toFailureDto(bytes);
    }
    const doc = readChatJsonl({ path: chatPath, chunks: [bytes] });
    if (doc instanceof Error) return toFailureDto(doc);

    const seed = selectSeedRecords(doc.records);
    const records: SeedRecord[] = [];
    for (const record of seed.records) {
      if (record.kind === "user") records.push({ role: "user", text: record.text });
      else if (record.kind === "agent") records.push({ role: "agent", text: record.text });
      // system:error/system:cancelled/system:restore are not conversational turns — excluded
      // from the seed, matching `SeedRecord`'s own closed `role: "user" | "agent"`.
    }
    return records;
  }

  async function advanceCheckpoint(input: {
    readonly chatId: string;
    readonly sessionScopeId: string;
    readonly sessionId: string;
  }): Promise<FailureDtoV1 | undefined> {
    const chatPath = chatJsonlPath(input.chatId);
    const bytes = open.safeFs.readFile(chatPath);
    if (bytes instanceof Error) return toFailureDto(bytes);
    const doc = readChatJsonl({ path: chatPath, chunks: [bytes] });
    if (doc instanceof Error) return toFailureDto(doc);

    const result = await open.transactions.advanceSessionCheckpoint({
      transactionId: deps.uuidv7(),
      actionId: deps.uuidv7(),
      chatId: input.chatId,
      sessionScopeId: input.sessionScopeId,
      sessionId: input.sessionId,
      recordCount: doc.recordCount,
      createdAt: nowIso(deps.clock),
    });
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  return { evaluateResume, selectSeed, advanceCheckpoint };
}

type _Conforms = AssertConforms<
  SessionCheckpointService,
  ReturnType<typeof createSessionCheckpointAdapter>
>;
