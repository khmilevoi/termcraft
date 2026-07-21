import { action, atom, type Atom } from "@reatom/core"

import type { ChatSummaryV1 } from "../types"

/**
 * The Kernel's own newest-first chat directory (this slice's task brief: "newest-first
 * enumeration"). No port here lists every chat (`core/ports/chat-store.ts`'s `ChatReader`
 * exposes only `open(chatId)` — it presumes the caller already knows which chat to open),
 * so this is the Kernel-side accumulation of `ChatSummaryV1` entries as they become known
 * (from `chat.create`'s own header, from `chat.changed`'s `added`/`updated` arrays, or from
 * whatever discovers a project's existing chats at open time) — a keyed model cache, per
 * the Reatom atomization rule RTM-S07 ("derive editable collections with `computed` plus a
 * model cache keyed by id"), not a re-fetch on every read.
 */

/** Pure sort: newest `createdAt` first. Compares real elapsed time (via `Date.parse`), not
 * string length or lexical order — RFC 3339's optional fractional seconds make two valid
 * timestamps different lengths at the same wall-clock second. Stable: two chats created at
 * the exact same instant keep their original relative order. */
export function sortChatsNewestFirst(chats: readonly ChatSummaryV1[]): readonly ChatSummaryV1[] {
  return [...chats].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export interface ChatDirectory {
  readonly entriesAtom: Atom<ReadonlyMap<string, ChatSummaryV1>>
  /** Adds a chat, or replaces the existing entry for the same `chatId` — never duplicates. */
  upsert(summary: ChatSummaryV1): void
  newestFirst(): readonly ChatSummaryV1[]
}

/** A factory, not module-level atoms — two kernels (or two tests) must never share one directory. */
export function createChatDirectory(): ChatDirectory {
  const entriesAtom = atom<ReadonlyMap<string, ChatSummaryV1>>(new Map(), "kernel.chats.directory")

  const upsert = action((summary: ChatSummaryV1) => {
    const next = new Map(entriesAtom())
    next.set(summary.chatId, summary)
    entriesAtom.set(next)
  }, "kernel.chats.directory.upsert")

  return {
    entriesAtom,
    upsert,
    newestFirst: () => sortChatsNewestFirst([...entriesAtom().values()]),
  }
}
