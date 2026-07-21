import type { ChatMutations, ProjectStore } from "core/ports"
import type { EventPayloadByKindV1, FailureDtoV1 } from "core/protocol"

import { buildChatChangedPayload } from "./chat-changed"

type ChatChangedPayloadV1 = EventPayloadByKindV1["chat.changed"]

/**
 * `chat.switch` (kernel-command-contract §8.2): "Select an existing chat without changing
 * shared pages, preview, selection, or pins." This function touches exactly two ports —
 * `ChatMutations.switchActive` (validates the chat exists) and `ProjectStore.
 * writeWorkspaceState({activeChatId})` (selects it) — and nothing else, which IS the "no
 * shared-state change" guarantee: there is no dependency here through which a page,
 * preview, selection, or pin port could be reached. No `wrap(...)` is needed — this module
 * has no Reatom atom of its own to touch after an await (unlike `create.ts`'s
 * `ChatDirectory.upsert`).
 */
export interface SwitchChatDeps {
  readonly chats: ChatMutations
  readonly projectStore: ProjectStore
}

export async function switchChat(deps: SwitchChatDeps, chatId: string): Promise<FailureDtoV1 | ChatChangedPayloadV1> {
  const switched = await deps.chats.switchActive(chatId)
  if (switched !== undefined) return switched

  const written = await deps.projectStore.writeWorkspaceState({ activeChatId: chatId })
  if (written !== undefined) return written

  return buildChatChangedPayload({ activeChatId: chatId })
}
