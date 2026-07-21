import type { FailureDtoV1 } from "core/protocol"
import type { ChatRecord } from "entities/chat"

/**
 * The chat read/write surface `core` consumes. Split into a reader (open a chat, page its
 * records) and a mutations facet (`chat.create`/`chat.switch`, kernel-command-contract
 * §8.2) rather than one wide interface — `ChatMutations`'s two members are Kernel-command
 * targets with their own capability guard and transition-table row, while `ChatReader` is
 * plain data access the turn/render paths use continuously; folding them together would
 * blur which methods the capability system governs.
 *
 * `entities/chat`'s `ChatRecord` union is reused verbatim (entities are core's shared
 * vocabulary, item 3 of code-structure.md) rather than redrawn — unlike the store-internal
 * types elsewhere in this ring, `ChatRecord` carries no store submodule dependency.
 *
 * `ChatMutations`'s two members are two of the six commands blocker B3 names: "`store`'s
 * public surface cannot express six MVP commands... this blocks `chat.create`,
 * `page.renameTitle`, `page.reorder`, `page.removeConfirm`, `pin.setStatus`,
 * `model.select`". B3's resolution — "grow `TransactionEngine` with NAMED domain methods
 * inside `store/`" — is upstream work a sibling agent owns in this same slice; this port
 * declares the two shapes `core` needs from that growth without depending on how `store`
 * gets there.
 */

/** A chat's first line, minus the store's internal `formatVersion`/`kind` framing tags. */
export interface ChatHeaderV1 {
  readonly chatId: string
  readonly createdAt: string
}

/** Mirrors `store/jsonl`'s `PageCursor` (a generation + byte offset), redrawn per C1. */
export interface ChatPageCursorV1 {
  readonly generation: number
  readonly beforeOffset: number
}

export interface ChatLoadResultV1 {
  readonly records: readonly ChatRecord[]
  readonly prevCursor: ChatPageCursorV1 | null
}

export interface ChatHandleV1 {
  readonly header: ChatHeaderV1
  loadTail(limit?: number, byteBudget?: number): Promise<FailureDtoV1 | ChatLoadResultV1>
  loadBefore(cursor: ChatPageCursorV1, limit?: number, byteBudget?: number): Promise<FailureDtoV1 | ChatLoadResultV1>
}

export interface ChatReader {
  open(chatId: string): Promise<FailureDtoV1 | ChatHandleV1>
}

export interface ChatMutations {
  /** `chat.create` (§8.2): "Create and select a fresh chat through a Kernel transaction." */
  create(): Promise<FailureDtoV1 | ChatHeaderV1>
  /** `chat.switch` (§8.2): "Select an existing chat without changing shared pages, preview, selection, or pins." */
  switchActive(chatId: string): Promise<FailureDtoV1 | undefined>
}
