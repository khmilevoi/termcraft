import { wrap } from "@reatom/core"

import type { ChatMutations, ProjectStore } from "core/ports"
import type { EventPayloadByKindV1, FailureDtoV1 } from "core/protocol"

import type { ChatDirectory } from "./chat-directory"
import { buildChatChangedPayload } from "./chat-changed"

type ChatChangedPayloadV1 = EventPayloadByKindV1["chat.changed"]

/**
 * `chat.create` (kernel-command-contract §8.2): "Create and select a fresh chat through a
 * Kernel transaction." Two port calls make up that one transaction — `ChatMutations.create()`
 * mints the chat, `ProjectStore.writeWorkspaceState({activeChatId})` selects it — always in
 * that order, so a failed selection never leaves a HALF-created, unselectable chat dangling
 * (the reverse order would risk selecting an activeChatId that creation then failed to back).
 *
 * Every port call is `await wrap(...)`-ed (Reatom rule RTM-A04: a plain `await` loses the
 * active `context.start(...)` frame the moment control returns to the event loop, and the
 * `directory.upsert(...)` call below needs that frame back — see `core/mailbox/model/
 * dispatch.ts`'s identical rule, and this module's own test file header for the isolation
 * hazard `wrap` avoids).
 */

export interface CreateChatDeps {
  readonly chats: ChatMutations
  readonly projectStore: ProjectStore
  readonly directory: ChatDirectory
}

export async function createChat(deps: CreateChatDeps): Promise<FailureDtoV1 | ChatChangedPayloadV1> {
  const header = await wrap(deps.chats.create())
  if ("code" in header) return header

  const written = await wrap(deps.projectStore.writeWorkspaceState({ activeChatId: header.chatId }))
  if (written !== undefined) return written

  const summary = { chatId: header.chatId, createdAt: header.createdAt }
  deps.directory.upsert(summary)

  return buildChatChangedPayload({ activeChatId: header.chatId, added: [summary] })
}
