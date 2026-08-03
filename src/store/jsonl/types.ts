import type { ChatRecord } from "entities/chat";
import type { PageSlug } from "entities/page";

/**
 * A lowercase-hex SHA-256 digest. Declared locally so `store/jsonl` stays self-contained;
 * `store/types.ts` lifts the same alias into the shared store vocabulary.
 */
export type Sha256Hex = string;

/**
 * The prepared-append descriptor of turn-durability §4.4 / §3.3 — the durable record of an
 * intended JSONL append, written into `plan.json` before any target changes. It is what
 * lets recovery decide, from the target's bytes alone, whether the append never started,
 * completed, or was interrupted part-way (storage-identity §11.3 case 1).
 */
export interface PreparedAppend {
  /** Byte length of the validated prefix the append was prepared against. */
  readonly beforeLength: number;
  /** SHA-256 of exactly the first `beforeLength` bytes of the target. */
  readonly beforePrefixSha256: Sha256Hex;
  /** UUIDv7 of the journal payload file holding the prepared bytes. */
  readonly appendedPayloadId: string;
  readonly appendedSha256: Sha256Hex;
  readonly appendedLength: number;
  /** The `recordId` of every record in the prepared bytes, in file order. */
  readonly recordIds: readonly string[];
  /**
   * The domain identity the append belongs to (a `turnId`, `actionId`, or
   * `restoreActionId`), when the wrapper has one. §4.4 uses it to reject a duplicate
   * acknowledgement of the same domain event; the codec only carries it.
   */
  readonly domainIdentity?: string;
}

/** A {@link PreparedAppend} together with the payload bytes it describes. */
export interface PreparedAppendPayload {
  readonly descriptor: PreparedAppend;
  readonly bytes: Uint8Array;
}

/** The impure seam the append builder needs: minting the journal payload's UUIDv7. */
export interface AppendBuilderDeps {
  readonly newPayloadId: () => string;
}

/**
 * Which of the three §4.4 append states the target's trailing bytes are in. `empty` means
 * the append did not start, `complete` that it succeeded before acknowledgement, and
 * `leading-prefix` that it was interrupted part-way — the sole automatic truncation case.
 */
export type AppendInterruptionState = "empty" | "complete" | "leading-prefix";

export interface AppendInterruption {
  readonly state: AppendInterruptionState;
  readonly beforeLength: number;
  readonly appendedLength: number;
  /** Bytes actually present after `beforeLength`. */
  readonly observedSuffixBytes: number;
  /**
   * The offset recovery must truncate to before writing the complete prepared bytes —
   * non-null ONLY for `leading-prefix`. This is storage-identity §11.3's only automatic
   * truncation path, and it is reachable only under a matching prepared plan.
   */
  readonly truncateTo: number | null;
  readonly recordIds: readonly string[];
}

/**
 * What storage-identity §11.3 case 2 requires the UI to report for an unproven corrupt
 * suffix. Nothing is discarded automatically: the suffix hash is what the explicit
 * `termcraft repair jsonl --truncate` command must be given back to act.
 */
export interface CorruptSuffixReport {
  readonly path: string;
  readonly lastValidOffset: number;
  /** `null` when not one record was valid (an empty or header-only valid prefix). */
  readonly lastValidRecordId: string | null;
  readonly suffixByteLength: number;
  readonly suffixSha256: Sha256Hex;
}

/**
 * The tail classification of storage-identity §11.3. Exactly three outcomes are
 * representable here; the third case (mid-file corruption) is NOT a classification but a
 * hard error, because it must never produce a partially opened store.
 */
export type TailClassification =
  | { readonly kind: "clean" }
  | { readonly kind: "transaction-proven-append-interruption"; readonly append: AppendInterruption }
  | { readonly kind: "unproven-corrupt-suffix"; readonly report: CorruptSuffixReport };

/** Every JSONL record carries a canonical UUIDv7 `recordId` (storage-identity §11.1). */
export interface JsonlRecordIdentity {
  readonly recordId: string;
}

/**
 * The result of streaming one JSONL file from byte zero. Only complete LF-terminated valid
 * records are exposed; `validPrefixBytes`, `recordCount`, and `prefixSha256` describe
 * exactly the bytes those records occupy, and are what the next prepared append is built
 * against.
 */
export interface JsonlDocument<H, R> {
  readonly path: string;
  /** `null` for an empty file, or when the header line itself is missing/invalid. */
  readonly header: H | null;
  readonly records: readonly R[];
  readonly recordCount: number;
  /** Offset just past the last valid record's LF (the header line counts toward it). */
  readonly validPrefixBytes: number;
  /** SHA-256 of the first `validPrefixBytes` bytes — the next append's `beforePrefixSha256`. */
  readonly prefixSha256: Sha256Hex;
  readonly totalBytes: number;
  readonly tail: TailClassification;
  /**
   * §11.3 case 2: the valid prefix may be displayed but the store accepts no mutation
   * until the suffix is resolved by explicit recovery.
   */
  readonly mutationLocked: boolean;
}

// ---- ChatIndex (projections §7) ------------------------------------------------
//
// The rebuildable chat projection: only `recordId`, an optional `turnId`, `ts`, and
// `changedPages` per record, plus structural byte/offset/generation/checksum metadata
// (§7.1) — never bodies, pins, warnings, selections, reasoning, or Git ids. Types shared
// across `model/chat-index.ts` and its future consumers (`store/types.ts` T19) live here;
// `model/chat-index.ts` keeps only its own private helper shapes.

/** A random-access read of exactly `[start, end)` canonical bytes — the index never opens a file itself. */
export interface CanonicalRangeReader {
  readRange(input: { readonly start: number; readonly end: number }): Promise<Error | Uint8Array>;
}

/** Everything a build/rebuild needs to stream the canonical file from byte zero, twice. */
export interface ChatIndexCanonicalSource extends CanonicalRangeReader {
  /**
   * Byte chunks from byte zero, in arbitrary chunking (matches `store/jsonl`'s reader
   * contract). Called more than once per build — once for the authoritative decode, once
   * for this file's own offset recovery — so it must be safe to iterate repeatedly (a
   * plain in-memory array is; a single-use generator is not).
   */
  openChunks(): Iterable<Uint8Array>;
}

/** One projections §7.1 index entry — structural + the four indexed domain fields only. */
export interface ChatIndexEntry {
  readonly recordId: string;
  readonly turnId?: string;
  readonly ts: string;
  readonly changedPages: readonly PageSlug[];
  /** Canonical-file byte offset where this record's physical line starts. */
  readonly offsetStart: number;
  /** Canonical-file byte offset just past this record's terminating LF. */
  readonly offsetEnd: number;
}

/** A checksummed, at-most-512-entry page, in offset order (§7.1). */
export interface ChatIndexPage {
  readonly pageIndex: number;
  readonly entries: readonly ChatIndexEntry[];
  readonly checksum: Sha256Hex;
}

/** The always-resident directory row for one page — its entries live only in the page store. */
export interface ChatIndexPageDirectoryEntry {
  readonly pageIndex: number;
  readonly entryCount: number;
  readonly firstOffsetStart: number;
  readonly lastOffsetEnd: number;
  readonly checksum: Sha256Hex;
}

/** The chat index's own persisted pages (§7.1) — injected, so tests use an in-memory fake. */
export interface ChatIndexPageStore {
  writePage(chatId: string, page: ChatIndexPage): Promise<Error | void>;
  readPage(chatId: string, pageIndex: number): Promise<Error | ChatIndexPage | null>;
}

export interface ChatIndexDeps {
  readonly pages: ChatIndexPageStore;
}

/**
 * The chat index's structural state (§7.1/§7.4). Never record bodies — only what a
 * `loadTail`/`loadBefore`/`update` call needs to decide fast-path append vs rebuild, plus
 * the lightweight page directory.
 */
export interface ChatIndexState {
  readonly chatId: string;
  /** Bumped on every rebuild-from-byte-zero; invalidates outstanding cursors (§7.4). */
  readonly generation: number;
  readonly canonicalIdentity: string;
  readonly projectViewGeneration: string;
  readonly totalBytes: number;
  readonly validPrefixBytes: number;
  readonly firstWindowSha256: Sha256Hex;
  readonly finalWindowSha256: Sha256Hex;
  readonly tail: TailClassification;
  readonly pages: readonly ChatIndexPageDirectoryEntry[];
}

/** The opaque backward-pagination cursor of §7.3. */
export interface PageCursor {
  readonly generation: number;
  readonly beforeOffset: number;
}

/** `loadTail`/`loadBefore`'s result: decoded records in display order + the cursor for the older page. */
export interface LoadResult {
  readonly records: readonly ChatRecord[];
  readonly prevCursor: PageCursor | null;
  /**
   * The chat's TOTAL record count — every record on disk, not just this page's. Summed from
   * the index's own page directory (`ChatIndexPageDirectoryEntry.entryCount`), which
   * `flushEntries` builds one entry per record, so this costs no extra read and no second
   * scan. The UI's `▲ N earlier messages` row subtracts what it has loaded from this
   * (chat-scroll spec §6.3), which is what lets that label stay truthful without ever
   * reading a scroll metric.
   */
  readonly totalRecordCount: number;
}

export interface LoadOptions {
  readonly limit?: number;
  readonly byteBudget?: number;
}
