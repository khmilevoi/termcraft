import type { EventPayloadByKindV1, UUIDv7 } from "core/protocol"

import type { ChatSummaryV1 } from "../types"

/**
 * Assembles the `chat.changed` payload (kernel-command-contract §9, KCC:825): "complete
 * active chat identity plus the exact added/updated chat summaries and removed chat ids."
 * Both `chat.create` and `chat.switch` publish this same payload shape with different
 * contents — `create` adds exactly one summary, `switch` adds/updates/removes nothing.
 */

type ChatChangedPayloadV1 = EventPayloadByKindV1["chat.changed"]

export interface BuildChatChangedPayloadInputV1 {
  readonly activeChatId: UUIDv7
  readonly added?: readonly ChatSummaryV1[]
  readonly updated?: readonly ChatSummaryV1[]
  readonly removedChatIds?: readonly UUIDv7[]
}

export function buildChatChangedPayload(input: BuildChatChangedPayloadInputV1): ChatChangedPayloadV1 {
  return {
    activeChatId: input.activeChatId,
    added: input.added ?? [],
    updated: input.updated ?? [],
    removedChatIds: input.removedChatIds ?? [],
  }
}
