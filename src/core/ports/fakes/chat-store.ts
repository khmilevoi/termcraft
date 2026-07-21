import type { Clock } from "infrastructure/clock"
import type { FailureDtoV1 } from "core/protocol"
import type { ChatRecord } from "entities/chat"
import type { AssertConforms } from "../index"
import type { ChatHandleV1, ChatHeaderV1, ChatLoadResultV1, ChatMutations, ChatPageCursorV1, ChatReader } from "../chat-store"

/**
 * In-memory {@link ChatReader}/{@link ChatMutations} fake (6D task brief), combined on one
 * object because a real adapter shares one underlying chat log between the two facets —
 * `open()` must see what `create()` just wrote. `create()` is the one method here that
 * mints a fresh identity/timestamp, so it is the one method in this whole ring that takes
 * an injected {@link Clock}; every other fake in this ring has no call-time timestamp to
 * mint (callers supply `createdAt` themselves elsewhere in the ports ring).
 *
 * `loadTail`/`loadBefore` implement real, if simplified, pagination over the in-memory
 * array (`generation` stays fixed at 0 — this fake never compacts) rather than always
 * returning everything, so a test can exercise cursor behavior without a real store.
 * `byteBudget` is accepted for signature compatibility but not enforced — this fake has no
 * byte-size model for `ChatRecord`, which is a documented divergence, not silently ignored.
 */

const NOT_FOUND = (chatId: string): FailureDtoV1 => ({
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: `no chat found for chatId ${chatId}`,
  details: { chatId },
})

export type ChatStoreFailableMethod = "open" | "create" | "switchActive" | "loadTail" | "loadBefore"

export type ChatStoreCall =
  | { readonly method: "open"; readonly chatId: string }
  | { readonly method: "create" }
  | { readonly method: "switchActive"; readonly chatId: string }
  | { readonly method: "loadTail"; readonly chatId: string; readonly limit: number | undefined }
  | { readonly method: "loadBefore"; readonly chatId: string; readonly cursor: ChatPageCursorV1; readonly limit: number | undefined }

export interface FakeChatStore extends ChatReader, ChatMutations {
  readonly calls: readonly ChatStoreCall[]
  /** Test-only seeding — a real adapter would have these arrive via `finalize`'s agent-record append. */
  seedRecords(chatId: string, records: readonly ChatRecord[]): void
  failNext(method: ChatStoreFailableMethod, failure: FailureDtoV1): void
}

export function createFakeChatStore(options?: { readonly clock?: Clock }): FakeChatStore {
  const clock = options?.clock ?? { now: () => new Date("2024-01-01T00:00:00.000Z") }
  const chats = new Map<string, { header: ChatHeaderV1; records: ChatRecord[] }>()
  const calls: ChatStoreCall[] = []
  let nextId = 0

  const queues: Record<ChatStoreFailableMethod, FailureDtoV1[]> = {
    open: [],
    create: [],
    switchActive: [],
    loadTail: [],
    loadBefore: [],
  }

  function failNext(method: ChatStoreFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure)
  }

  function seedRecords(chatId: string, records: readonly ChatRecord[]): void {
    const chat = chats.get(chatId)
    if (chat === undefined) {
      console.warn(`fakes/chat-store: seedRecords called for unknown chatId ${chatId}, ignored`)
      return
    }
    chat.records.push(...records)
  }

  function sliceResult(records: readonly ChatRecord[], endExclusive: number, limit: number | undefined): ChatLoadResultV1 {
    const start = limit === undefined ? 0 : Math.max(0, endExclusive - limit)
    const slice = records.slice(start, endExclusive)
    const prevCursor: ChatPageCursorV1 | null = start > 0 ? { generation: 0, beforeOffset: start } : null
    return { records: slice, prevCursor }
  }

  function makeHandle(chatId: string, header: ChatHeaderV1): ChatHandleV1 {
    return {
      header,
      async loadTail(limit?: number): Promise<FailureDtoV1 | ChatLoadResultV1> {
        calls.push({ method: "loadTail", chatId, limit })
        const queued = queues.loadTail.shift()
        if (queued !== undefined) return queued
        const chat = chats.get(chatId)
        if (chat === undefined) return NOT_FOUND(chatId)
        return sliceResult(chat.records, chat.records.length, limit)
      },
      async loadBefore(cursor: ChatPageCursorV1, limit?: number): Promise<FailureDtoV1 | ChatLoadResultV1> {
        calls.push({ method: "loadBefore", chatId, cursor, limit })
        const queued = queues.loadBefore.shift()
        if (queued !== undefined) return queued
        const chat = chats.get(chatId)
        if (chat === undefined) return NOT_FOUND(chatId)
        return sliceResult(chat.records, cursor.beforeOffset, limit)
      },
    }
  }

  async function open(chatId: string): Promise<FailureDtoV1 | ChatHandleV1> {
    calls.push({ method: "open", chatId })
    const queued = queues.open.shift()
    if (queued !== undefined) return queued
    const chat = chats.get(chatId)
    if (chat === undefined) return NOT_FOUND(chatId)
    return makeHandle(chatId, chat.header)
  }

  async function create(): Promise<FailureDtoV1 | ChatHeaderV1> {
    calls.push({ method: "create" })
    const queued = queues.create.shift()
    if (queued !== undefined) return queued
    nextId += 1
    const header: ChatHeaderV1 = { chatId: `fake-chat-${nextId}`, createdAt: clock.now().toISOString() }
    chats.set(header.chatId, { header, records: [] })
    return header
  }

  async function switchActive(chatId: string): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "switchActive", chatId })
    const queued = queues.switchActive.shift()
    if (queued !== undefined) return queued
    if (!chats.has(chatId)) return NOT_FOUND(chatId)
    return undefined
  }

  return { open, create, switchActive, calls, seedRecords, failNext }
}

type _ReaderConforms = AssertConforms<ChatReader, FakeChatStore>
type _MutationsConforms = AssertConforms<ChatMutations, FakeChatStore>
