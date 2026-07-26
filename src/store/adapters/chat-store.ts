import type {
  AssertConforms,
  ChatHandleV1,
  ChatHeaderV1,
  ChatListingEntryV1,
  ChatLoadResultV1,
  ChatMutations,
  ChatPageCursorV1,
  ChatReader,
  ReadSetAppendBaseV1,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import type { PageCursor } from "store/jsonl";
import { readChatJsonl } from "store/jsonl";
import { chatJsonlPath } from "store/transaction";

import type { ChatHandle } from "../types";
import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";
import { nowIso } from "./types";

// `createChatStoreAdapter` — the `ChatReader & ChatMutations` port over `OpenProject.chats`/
// `OpenProject.transactions` (plan Task 1). `readAppendBase` needs no new store-internal
// accessor: `OpenProject.safeFs` already reaches the chat's raw bytes, and `store/jsonl`'s
// already-public `readChatJsonl` already decodes `validPrefixBytes`/`prefixSha256` from them
// — exactly the same valid-prefix fact `open.chats.open()` itself decodes.

function toCursorV1(cursor: PageCursor): ChatPageCursorV1 {
  return { generation: cursor.generation, beforeOffset: cursor.beforeOffset };
}

function toStoreCursor(cursor: ChatPageCursorV1): PageCursor {
  return { generation: cursor.generation, beforeOffset: cursor.beforeOffset };
}

function toHandleV1(chatId: string, handle: ChatHandle): ChatHandleV1 {
  return {
    header: { chatId, createdAt: handle.header.createdAt },
    async loadTail(limit, byteBudget): Promise<FailureDtoV1 | ChatLoadResultV1> {
      const result = await handle.loadTail(limit, byteBudget);
      if (result instanceof Error) return toFailureDto(result);
      return {
        records: result.records,
        prevCursor: result.prevCursor === null ? null : toCursorV1(result.prevCursor),
      };
    },
    async loadBefore(cursor, limit, byteBudget): Promise<FailureDtoV1 | ChatLoadResultV1> {
      const result = await handle.loadBefore(toStoreCursor(cursor), limit, byteBudget);
      if (result instanceof Error) return toFailureDto(result);
      return {
        records: result.records,
        prevCursor: result.prevCursor === null ? null : toCursorV1(result.prevCursor),
      };
    },
  };
}

export function createChatStoreAdapter(deps: StoreAdapterDeps): ChatReader & ChatMutations {
  const { open } = deps;

  async function open_(chatId: string): Promise<FailureDtoV1 | ChatHandleV1> {
    const handle = await open.chats.open(chatId);
    if (handle instanceof Error) return toFailureDto(handle);
    return toHandleV1(chatId, handle);
  }

  async function readAppendBase(chatId: string): Promise<FailureDtoV1 | ReadSetAppendBaseV1> {
    const relPath = chatJsonlPath(chatId);
    const bytes = open.safeFs.readFile(relPath);
    if (bytes instanceof Error) return toFailureDto(bytes);
    const doc = readChatJsonl({ path: relPath, chunks: [bytes] });
    if (doc instanceof Error) return toFailureDto(doc);
    return { length: doc.validPrefixBytes, prefixSha256: doc.prefixSha256 };
  }

  async function create(): Promise<FailureDtoV1 | ChatHeaderV1> {
    const chatId = deps.uuidv7();
    const createdAt = nowIso(deps.clock);
    const manifest = await open.manifest.read();
    if (manifest instanceof Error) return toFailureDto(manifest);
    const result = await open.transactions.createChat({
      transactionId: deps.uuidv7(),
      actionId: deps.uuidv7(),
      chatId,
      projectId: manifest.projectId,
      createdAt,
    });
    if (result instanceof Error) return toFailureDto(result);
    return { chatId, createdAt };
  }

  async function switchActive(chatId: string): Promise<FailureDtoV1 | undefined> {
    const result = await open.transactions.setActiveChat({
      transactionId: deps.uuidv7(),
      actionId: deps.uuidv7(),
      activeChatId: chatId,
      createdAt: nowIso(deps.clock),
    });
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  async function list(): Promise<FailureDtoV1 | readonly ChatListingEntryV1[]> {
    const result = await open.chats.list();
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

  return { open: open_, readAppendBase, create, switchActive, list };
}

type _Conforms = AssertConforms<
  ChatReader & ChatMutations,
  ReturnType<typeof createChatStoreAdapter>
>;
