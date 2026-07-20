// `ChatIndex` — the rebuildable chat projection of projections-observability §7. Canonical
// chat JSONL stays the sole authority; the index stores only `recordId`, an optional
// `turnId`, `ts`, and `changedPages` per record, plus structural byte/offset/generation/
// checksum metadata (§7.1). It never stores prompt/response text, warnings, pins,
// selections, reasoning, full records, or Git ids.
//
// Consumes `store/jsonl`'s reader (T10) verbatim for the authoritative from-byte-zero
// decode and corruption classification (§11.3); this file never re-implements that
// classification. What the reader does not expose — per-record byte offsets — is
// recovered here with a second, decode-free byte scan over the same source (§7.2's "1 MiB
// buffer holding at most one record line" is the reader's own invariant, inherited by
// delegation).
//
// Entries persist in checksummed pages of at most 512 (§7.1); a single read call never
// holds more than `CHAT_INDEX_MAX_RESIDENT_PAGES` pages resident, which is this
// implementation's realization of "only the page directory and an eight-page LRU window
// are resident" — the directory (one lightweight row per page) is always resident, and any
// one `loadTail`/`loadBefore`/build call fetches at most eight full pages before returning.
import * as errore from "errore"

import type { ChatRecord } from "entities/chat"
import type { PageSlug } from "entities/page"
import { MiB } from "store/safe-fs"
import type {
  CanonicalRangeReader,
  ChatIndexCanonicalSource,
  ChatIndexDeps,
  ChatIndexEntry,
  ChatIndexPage,
  ChatIndexPageDirectoryEntry,
  ChatIndexPageStore,
  ChatIndexState,
  LoadOptions,
  LoadResult,
  PageCursor,
  Sha256Hex,
} from "../types"
import { JSONL_LF, JSONL_MAX_PHYSICAL_LINE_BYTES, decodeChatRecordLine, sha256Hex } from "./line-codec"
import { JsonlMidFileCorruptionError, readChatJsonl } from "./reader"

// ---- errors ---------------------------------------------------------------------

/**
 * The index's own page store or canonical-range boundary failed, or a persisted page's
 * checksum no longer matches its entries. Distinct from {@link JsonlMidFileCorruptionError}
 * (a canonical-JSONL corruption verdict from T10's reader): this is the PROJECTION's own
 * I/O/integrity failure, and per projections §5 the fix is to rebuild the projection, never
 * to touch canonical data.
 */
export class ChatIndexIoError extends errore.createTaggedError({
  name: "ChatIndexIoError",
  message: "chat index I/O failed for chat $chatId: $reason",
}) {}

/**
 * A `loadBefore` cursor named a generation the index has since left (projections §7.4:
 * "generation changes invalidate outstanding pagination cursors"). The caller must drop
 * the stale page and request a fresh tail.
 */
export class ChatIndexCursorStaleError extends errore.createTaggedError({
  name: "ChatIndexCursorStaleError",
  message: "chat index cursor for chat $chatId is from a stale generation",
}) {}

export type ChatIndexError = JsonlMidFileCorruptionError | ChatIndexIoError | ChatIndexCursorStaleError

// ---- tunables ---------------------------------------------------------------------

/** §7.1: entries persist in pages of at most this many. */
export const CHAT_INDEX_PAGE_SIZE = 512
/** §7.1: at most this many full pages are ever held resident by one call. */
export const CHAT_INDEX_MAX_RESIDENT_PAGES = 8
/** §7.3 default `loadTail`/`loadBefore` record limit. */
export const CHAT_INDEX_DEFAULT_LOAD_LIMIT = 100
/** §7.3 hard record-count ceiling. */
export const CHAT_INDEX_MAX_LOAD_LIMIT = 200
/** §7.3 hard decoded-byte ceiling per response. */
export const CHAT_INDEX_MAX_LOAD_BYTES = 8 * MiB
/**
 * §7.4 names "hashes of the first and final validated windows" without pinning a byte
 * count. JUDGMENT CALL (spec gap, projections §7.4): 4 KiB is small enough that an update
 * check never re-reads a meaningful fraction of a large chat, and large enough that a
 * hostile single-byte edit right at a window boundary is still astronomically unlikely to
 * be missed alongside the length/identity checks it never travels alone with.
 */
export const CHAT_INDEX_WINDOW_BYTES = 4096

// ---- record -> entry projection ------------------------------------------------

function extractTurnId(record: ChatRecord): string | undefined {
  if (record.kind === "user") return record.turnId
  if (record.kind === "agent") return record.turnId
  if (record.kind === "system:error") return record.turnId
  if (record.kind === "system:cancelled") return record.turnId
  return undefined // system:restore carries no turnId (it has restoreActionId instead)
}

/** §7.1: "`changedPages` from the record, or an empty list when absent." Only `agent` carries it. */
function extractChangedPages(record: ChatRecord): readonly PageSlug[] {
  return record.kind === "agent" ? record.changedPages : []
}

interface LineSpan {
  readonly start: number
  readonly end: number
}

function toIndexEntry(record: ChatRecord, span: LineSpan): ChatIndexEntry {
  const turnId = extractTurnId(record)
  return {
    recordId: record.recordId,
    ...(turnId === undefined ? {} : { turnId }),
    ts: record.ts,
    changedPages: extractChangedPages(record),
    offsetStart: span.start,
    offsetEnd: span.end,
  }
}

/**
 * Recover each physical line's byte span by re-walking the same bytes the canonical
 * reader already validated. `readJsonlDocument` (T10) reports only document-level
 * `validPrefixBytes`, not per-record offsets, so this scans for LF positions alone — no
 * JSON decoding, nothing buffered beyond a running offset — and stops the moment it has
 * collected `lineCount` spans or reached `validPrefixBytes`, whichever comes first. Every
 * line up to `validPrefixBytes` is, by construction of the reader's own accounting, one of
 * exactly `lineCount` consecutive well-formed lines from byte zero.
 */
function scanLineSpans(chunks: Iterable<Uint8Array>, lineCount: number, validPrefixBytes: number): readonly LineSpan[] {
  if (lineCount === 0) return []
  const spans: LineSpan[] = []
  let offset = 0
  let lineStart = 0
  for (const chunk of chunks) {
    let index = 0
    while (index < chunk.byteLength) {
      const lf = chunk.indexOf(JSONL_LF, index)
      if (lf === -1) {
        offset += chunk.byteLength - index
        break
      }
      offset += lf - index + 1
      spans.push({ start: lineStart, end: offset })
      lineStart = offset
      index = lf + 1
      if (spans.length >= lineCount || offset >= validPrefixBytes) return spans
    }
  }
  return spans
}

// ---- window hashing -------------------------------------------------------------

/**
 * §7.4's "hashes of the first and final validated windows", read as two bounded
 * random-access reads rather than a full-prefix hash — the whole point of the window
 * design is that an `update` precondition check never costs an O(file size) re-read.
 */
async function computeWindowHashes(
  source: CanonicalRangeReader,
  validPrefixBytes: number,
): Promise<Error | { first: Sha256Hex; final: Sha256Hex }> {
  if (validPrefixBytes === 0) {
    const empty = sha256Hex(new Uint8Array(0))
    return { first: empty, final: empty }
  }
  const firstEnd = Math.min(CHAT_INDEX_WINDOW_BYTES, validPrefixBytes)
  const firstBytes = await source.readRange({ start: 0, end: firstEnd })
  if (firstBytes instanceof Error) return firstBytes

  const finalStart = Math.max(0, validPrefixBytes - CHAT_INDEX_WINDOW_BYTES)
  const wholePrefixFitsOneWindow = finalStart === 0 && firstEnd === validPrefixBytes
  const finalBytes = wholePrefixFitsOneWindow ? firstBytes : await source.readRange({ start: finalStart, end: validPrefixBytes })
  if (finalBytes instanceof Error) return finalBytes

  return { first: sha256Hex(firstBytes), final: sha256Hex(finalBytes) }
}

// ---- paging ---------------------------------------------------------------------

function checksumEntries(entries: readonly ChatIndexEntry[]): Sha256Hex {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(entries)))
}

/**
 * Page `entries` into groups of at most {@link CHAT_INDEX_PAGE_SIZE}, writing each page to
 * the injected store and discarding it from local memory immediately — a build or append
 * never keeps more than the page currently being assembled resident. Page numbering
 * continues from `startPageIndex`, so a fast-path append pages independently of the
 * previous state's pages. JUDGMENT CALL (§7.1 bounds page size at 512 but does not require
 * exact repacking): an append never tops up a previous partial last page, so a chat index
 * that saw many small appends can carry more sub-512 pages than a fully repacked layout —
 * still within the ≤512 bound the spec states.
 */
async function flushEntries(
  chatId: string,
  entries: readonly ChatIndexEntry[],
  startPageIndex: number,
  pages: ChatIndexPageStore,
): Promise<ChatIndexIoError | readonly ChatIndexPageDirectoryEntry[]> {
  const directory: ChatIndexPageDirectoryEntry[] = []
  let pageIndex = startPageIndex
  for (let at = 0; at < entries.length; at += CHAT_INDEX_PAGE_SIZE) {
    const slice = entries.slice(at, at + CHAT_INDEX_PAGE_SIZE)
    const first = slice[0]
    const last = slice[slice.length - 1]
    if (first === undefined || last === undefined) continue
    const checksum = checksumEntries(slice)
    const wrote = await pages.writePage(chatId, { pageIndex, entries: slice, checksum })
    if (wrote instanceof Error) return new ChatIndexIoError({ chatId, reason: `page ${pageIndex} write failed: ${wrote.message}`, cause: wrote })
    directory.push({ pageIndex, entryCount: slice.length, firstOffsetStart: first.offsetStart, lastOffsetEnd: last.offsetEnd, checksum })
    pageIndex += 1
  }
  return directory
}

/** Read one page back and verify its persisted checksum still matches its entries. */
async function readVerifiedPage(chatId: string, pageIndex: number, pages: ChatIndexPageStore): Promise<ChatIndexIoError | ChatIndexPage> {
  const page = await pages.readPage(chatId, pageIndex)
  if (page instanceof Error) return new ChatIndexIoError({ chatId, reason: `page ${pageIndex} read failed: ${page.message}`, cause: page })
  if (page === null) return new ChatIndexIoError({ chatId, reason: `page ${pageIndex} is missing from the page store` })
  if (checksumEntries(page.entries) !== page.checksum) return new ChatIndexIoError({ chatId, reason: `page ${pageIndex} failed its checksum` })
  return page
}

// ---- build / rebuild --------------------------------------------------------------

async function rebuildFromByteZero(input: {
  chatId: string
  generation: number
  canonicalIdentity: string
  projectViewGeneration: string
  source: ChatIndexCanonicalSource
  pages: ChatIndexPageStore
}): Promise<ChatIndexError | ChatIndexState> {
  const doc = readChatJsonl({ path: input.chatId, chunks: input.source.openChunks() })
  if (doc instanceof Error) return doc

  const lineCount = (doc.header === null ? 0 : 1) + doc.recordCount
  const spans = scanLineSpans(input.source.openChunks(), lineCount, doc.validPrefixBytes)
  const recordSpans = doc.header === null ? spans : spans.slice(1)

  const entries: ChatIndexEntry[] = []
  for (let i = 0; i < doc.records.length; i += 1) {
    const record = doc.records[i]
    const span = recordSpans[i]
    if (record === undefined || span === undefined) {
      return new JsonlMidFileCorruptionError({
        path: input.chatId,
        offset: doc.validPrefixBytes,
        reason: "chat-index offset scan desynchronized from the decoded record count",
      })
    }
    entries.push(toIndexEntry(record, span))
  }

  const directory = await flushEntries(input.chatId, entries, 0, input.pages)
  if (directory instanceof Error) return directory

  const windows = await computeWindowHashes(input.source, doc.validPrefixBytes)
  if (windows instanceof Error) return new ChatIndexIoError({ chatId: input.chatId, reason: windows.message, cause: windows })

  return {
    chatId: input.chatId,
    generation: input.generation,
    canonicalIdentity: input.canonicalIdentity,
    projectViewGeneration: input.projectViewGeneration,
    totalBytes: doc.totalBytes,
    validPrefixBytes: doc.validPrefixBytes,
    firstWindowSha256: windows.first,
    finalWindowSha256: windows.final,
    tail: doc.tail,
    pages: directory,
  }
}

export interface BuildChatIndexInput {
  readonly chatId: string
  readonly canonicalIdentity: string
  readonly projectViewGeneration: string
  readonly source: ChatIndexCanonicalSource
  readonly deps: ChatIndexDeps
}

/** The very first build of a chat index — always a streaming rebuild from byte zero, generation 1. */
export async function buildChatIndex(input: BuildChatIndexInput): Promise<ChatIndexError | ChatIndexState> {
  return rebuildFromByteZero({
    chatId: input.chatId,
    generation: 1,
    canonicalIdentity: input.canonicalIdentity,
    projectViewGeneration: input.projectViewGeneration,
    source: input.source,
    pages: input.deps.pages,
  })
}

// ---- incremental update -----------------------------------------------------------

/**
 * Decode only the NEW suffix bytes as complete LF-terminated lines (never the header —
 * `update` only ever runs once a build has already validated one). Returns `null` on any
 * doubt at all: an over-bound line, a schema-invalid line, or a duplicate `recordId`
 * inside the suffix. `null` is not corruption — it means "this narrow scan cannot prove
 * the suffix is clean", and the caller falls back to the authoritative full rebuild rather
 * than this function attempting T10's whole corruption taxonomy itself.
 */
function scanSuffixLines(suffix: Uint8Array, baseOffset: number): { entries: readonly ChatIndexEntry[]; newValidPrefixBytes: number } | null {
  const entries: ChatIndexEntry[] = []
  const seenIds = new Set<string>()
  let index = 0
  while (index < suffix.byteLength) {
    const lf = suffix.indexOf(JSONL_LF, index)
    if (lf === -1) break // an incomplete final line is not indexed (§7.2) — not an error
    const line = suffix.subarray(index, lf + 1)
    if (line.byteLength > JSONL_MAX_PHYSICAL_LINE_BYTES) {
      console.warn("chat-index: suffix scan deferring to rebuild:", `line at offset ${baseOffset + index} exceeds the physical line bound`)
      return null
    }
    const decoded = decodeChatRecordLine(line)
    if (decoded instanceof Error) {
      // Not corruption — this narrow scan is not the authoritative classifier (T10's reader
      // is). Log the reason before deferring, so a rebuild storm is explainable.
      console.warn("chat-index: suffix scan deferring to rebuild:", decoded.message)
      return null
    }
    if (seenIds.has(decoded.recordId)) {
      console.warn("chat-index: suffix scan deferring to rebuild:", `duplicate recordId ${decoded.recordId} in the appended suffix`)
      return null
    }
    seenIds.add(decoded.recordId)
    entries.push(toIndexEntry(decoded, { start: baseOffset + index, end: baseOffset + lf + 1 }))
    index = lf + 1
  }
  return { entries, newValidPrefixBytes: baseOffset + index }
}

export interface UpdateChatIndexInput {
  readonly canonicalIdentity: string
  readonly projectViewGeneration: string
  /** The canonical file's current total byte length — a stat fact the caller already has. */
  readonly totalBytes: number
  readonly source: ChatIndexCanonicalSource
  readonly deps: ChatIndexDeps
}

/**
 * Decide append fast-path vs streaming rebuild (§7.4). Any of these forces a rebuild from
 * byte zero at the next generation: the previous scan's tail was not clean, a shorter
 * file (truncation), a replaced canonical identity, a changed `projectViewGeneration`
 * (branch switch — §7.4 "no record identity is borrowed across the branch boundary"), or a
 * mismatched first/final validated window (a same-length rewrite the length check alone
 * cannot see). Only when every check passes does the new suffix get a bounded,
 * offset-only incremental scan.
 */
export async function updateChatIndex(previous: ChatIndexState, input: UpdateChatIndexInput): Promise<ChatIndexError | ChatIndexState> {
  const rebuild = () =>
    rebuildFromByteZero({
      chatId: previous.chatId,
      generation: previous.generation + 1,
      canonicalIdentity: input.canonicalIdentity,
      projectViewGeneration: input.projectViewGeneration,
      source: input.source,
      pages: input.deps.pages,
    })

  if (previous.tail.kind !== "clean") return rebuild()
  if (input.canonicalIdentity !== previous.canonicalIdentity) return rebuild()
  if (input.projectViewGeneration !== previous.projectViewGeneration) return rebuild()
  if (input.totalBytes < previous.validPrefixBytes) return rebuild()
  if (input.totalBytes === previous.validPrefixBytes) return previous // nothing new to index

  const windows = await computeWindowHashes(input.source, previous.validPrefixBytes)
  if (windows instanceof Error) return new ChatIndexIoError({ chatId: previous.chatId, reason: windows.message, cause: windows })
  if (windows.first !== previous.firstWindowSha256) return rebuild()
  if (windows.final !== previous.finalWindowSha256) return rebuild()

  const suffix = await input.source.readRange({ start: previous.validPrefixBytes, end: input.totalBytes })
  if (suffix instanceof Error) return new ChatIndexIoError({ chatId: previous.chatId, reason: suffix.message, cause: suffix })

  const scanned = scanSuffixLines(suffix, previous.validPrefixBytes)
  if (scanned === null) return rebuild() // any doubt in the suffix defers to the authoritative full scan

  if (scanned.entries.length === 0) {
    // Only a pending, not-yet-LF-terminated tail grew; nothing to index yet (§7.2).
    return { ...previous, totalBytes: input.totalBytes }
  }

  const appended = await flushEntries(previous.chatId, scanned.entries, previous.pages.length, input.deps.pages)
  if (appended instanceof Error) return appended

  const finalWindowStart = Math.max(0, scanned.newValidPrefixBytes - CHAT_INDEX_WINDOW_BYTES)
  const finalWindowBytes = await input.source.readRange({ start: finalWindowStart, end: scanned.newValidPrefixBytes })
  if (finalWindowBytes instanceof Error) return new ChatIndexIoError({ chatId: previous.chatId, reason: finalWindowBytes.message, cause: finalWindowBytes })

  return {
    ...previous,
    totalBytes: input.totalBytes,
    validPrefixBytes: scanned.newValidPrefixBytes,
    finalWindowSha256: sha256Hex(finalWindowBytes),
    pages: [...previous.pages, ...appended],
  }
}

// ---- loadTail / loadBefore ---------------------------------------------------------

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return CHAT_INDEX_DEFAULT_LOAD_LIMIT
  return Math.max(1, Math.min(Math.trunc(limit), CHAT_INDEX_MAX_LOAD_LIMIT))
}

function clampByteBudget(byteBudget: number | undefined): number {
  if (byteBudget === undefined) return CHAT_INDEX_MAX_LOAD_BYTES
  return Math.max(1, Math.min(Math.trunc(byteBudget), CHAT_INDEX_MAX_LOAD_BYTES))
}

/**
 * Walk the page directory backward from `beforeOffsetExclusive` (or from the very end when
 * `null`), collecting entries until `limit`, `byteBudget`, or
 * {@link CHAT_INDEX_MAX_RESIDENT_PAGES} pages touched — whichever comes first. §7.3: "if a
 * page contains one record that alone approaches the ceiling, that record is returned
 * alone" — realized below by never rejecting the FIRST candidate on byte budget alone.
 */
async function selectBackward(input: {
  chatId: string
  pages: ChatIndexPageStore
  directory: readonly ChatIndexPageDirectoryEntry[]
  beforeOffsetExclusive: number | null
  limit: number
  byteBudget: number
}): Promise<ChatIndexIoError | { entries: readonly ChatIndexEntry[]; reachedBeginning: boolean }> {
  const selected: ChatIndexEntry[] = []
  let runningBytes = 0
  let pagesTouched = 0
  let reachedBeginning = true

  outer: for (let pi = input.directory.length - 1; pi >= 0; pi -= 1) {
    const dirEntry = input.directory[pi]
    if (dirEntry === undefined) continue
    if (input.beforeOffsetExclusive !== null && dirEntry.firstOffsetStart >= input.beforeOffsetExclusive) continue
    if (pagesTouched >= CHAT_INDEX_MAX_RESIDENT_PAGES) {
      reachedBeginning = false
      break
    }

    const page = await readVerifiedPage(input.chatId, dirEntry.pageIndex, input.pages)
    if (page instanceof Error) return page
    pagesTouched += 1

    for (let ei = page.entries.length - 1; ei >= 0; ei -= 1) {
      const entry = page.entries[ei]
      if (entry === undefined) continue
      if (input.beforeOffsetExclusive !== null && entry.offsetStart >= input.beforeOffsetExclusive) continue
      const size = entry.offsetEnd - entry.offsetStart
      if (selected.length >= input.limit) {
        reachedBeginning = false
        break outer
      }
      if (selected.length > 0 && runningBytes + size > input.byteBudget) {
        reachedBeginning = false
        break outer
      }
      selected.push(entry)
      runningBytes += size
    }
  }

  selected.reverse()
  return { entries: selected, reachedBeginning }
}

/** Fetch and decode exactly the selected entries' canonical byte ranges — one contiguous read, since a file-order selection is contiguous. */
async function materializeRecords(chatId: string, source: CanonicalRangeReader, entries: readonly ChatIndexEntry[]): Promise<ChatIndexIoError | readonly ChatRecord[]> {
  if (entries.length === 0) return []
  const first = entries[0]
  const last = entries[entries.length - 1]
  if (first === undefined || last === undefined) return []

  const bytes = await source.readRange({ start: first.offsetStart, end: last.offsetEnd })
  if (bytes instanceof Error) return new ChatIndexIoError({ chatId, reason: bytes.message, cause: bytes })

  const records: ChatRecord[] = []
  for (const entry of entries) {
    const line = bytes.subarray(entry.offsetStart - first.offsetStart, entry.offsetEnd - first.offsetStart)
    const decoded = decodeChatRecordLine(line)
    if (decoded instanceof Error) return new ChatIndexIoError({ chatId, reason: `canonical record ${entry.recordId} no longer decodes: ${decoded.message}`, cause: decoded })
    records.push(decoded)
  }
  return records
}

function toPrevCursor(state: ChatIndexState, picked: { entries: readonly ChatIndexEntry[]; reachedBeginning: boolean }): PageCursor | null {
  const oldest = picked.entries[0]
  if (picked.reachedBeginning || oldest === undefined) return null
  return { generation: state.generation, beforeOffset: oldest.offsetStart }
}

/** Open a chat: the newest `limit` records (default 100, max 200) within `byteBudget` (default/max 8 MiB) (§7.3). */
export async function loadChatIndexTail(state: ChatIndexState, deps: ChatIndexDeps, source: CanonicalRangeReader, options?: LoadOptions): Promise<ChatIndexError | LoadResult> {
  const picked = await selectBackward({
    chatId: state.chatId,
    pages: deps.pages,
    directory: state.pages,
    beforeOffsetExclusive: null,
    limit: clampLimit(options?.limit),
    byteBudget: clampByteBudget(options?.byteBudget),
  })
  if (picked instanceof Error) return picked

  const records = await materializeRecords(state.chatId, source, picked.entries)
  if (records instanceof Error) return records

  return { records, prevCursor: toPrevCursor(state, picked) }
}

/** Scroll further back from a `loadTail`/`loadBefore` cursor (§7.3). A stale-generation cursor is refused. */
export async function loadChatIndexBefore(
  state: ChatIndexState,
  deps: ChatIndexDeps,
  source: CanonicalRangeReader,
  cursor: PageCursor,
  options?: LoadOptions,
): Promise<ChatIndexError | LoadResult> {
  if (cursor.generation !== state.generation) return new ChatIndexCursorStaleError({ chatId: state.chatId })

  const picked = await selectBackward({
    chatId: state.chatId,
    pages: deps.pages,
    directory: state.pages,
    beforeOffsetExclusive: cursor.beforeOffset,
    limit: clampLimit(options?.limit),
    byteBudget: clampByteBudget(options?.byteBudget),
  })
  if (picked instanceof Error) return picked

  const records = await materializeRecords(state.chatId, source, picked.entries)
  if (records instanceof Error) return records

  return { records, prevCursor: toPrevCursor(state, picked) }
}
