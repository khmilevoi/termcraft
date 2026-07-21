import type { EventPayloadByKindV1 } from "core/protocol";

/**
 * `core/chats`'s shared vocabulary (CLAUDE.md "Code style": `types.ts` holds a module's
 * shared types). Each model file's own request/dependency shape (`CreateChatDeps`,
 * `SwitchChatDeps`, `SelectModelDeps`) stays local to that file — only the shapes more
 * than one file reaches for live here, matching `core/mailbox`'s own precedent
 * (`dispatch.ts`'s `DispatchDeps` is not in `mailbox/types.ts`).
 */

/**
 * One chat summary as `chat.changed` carries it (§9, KCC:825). `core/protocol`'s own
 * index only re-exports `EventPayloadByKindV1` (the per-kind payload map), not the
 * individual named payload types `event-payload.ts` declares internally — indexing the
 * map's `chat.changed` payload down to its `added` element type is the same type
 * without a second, un-re-exported import path (see `descriptors.ts`'s identical note).
 */
export type ChatSummaryV1 = EventPayloadByKindV1["chat.changed"]["added"][number];

/**
 * `model.select`'s validated triple (kernel-command-contract §8.2: "backend, model,
 * effort"). Plain strings at the protocol boundary (§10.1 confirms all three are
 * "plain validated strings, not a closed enum" — the concrete catalog is
 * capability-driven).
 */
export interface ModelSelectionV1 {
  readonly backend: string;
  readonly model: string;
  readonly effort: string;
}

/**
 * `model.select`'s one reachable rejection (`model-select.ts`'s header explains why a
 * single fallback code is correct here): no §11.1 code names "unknown backend/model/
 * effort" specifically, so this is the same `CAPABILITY_UNAVAILABLE` fallback
 * `core/capabilities/model/guards.ts` already uses for other guard reasons with no more
 * specific public code.
 */
export interface ModelSelectionRejectionV1 {
  readonly code: "CAPABILITY_UNAVAILABLE";
}
