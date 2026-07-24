import type { FailureDtoV1 } from "core/protocol";
import type { ChatRecord } from "entities/chat";

import type { ReadSetAppendBaseV1 } from "./staging";

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
 *
 * `ReadSetAppendBaseV1` is reused verbatim from `./staging` (the identical cross-port-file
 * import `export-publish.ts` already does for `FileImageV1`/`./turn-transactions` —
 * decision C1's "narrow, core-owned redraw" is a property of each DOMAIN concept, not of
 * every file that touches it) rather than a second, structurally-identical
 * `{length, prefixSha256}` type declared here.
 */

/** A chat's first line, minus the store's internal `formatVersion`/`kind` framing tags. */
export interface ChatHeaderV1 {
  readonly chatId: string;
  readonly createdAt: string;
}

/** Mirrors `store/jsonl`'s `PageCursor` (a generation + byte offset), redrawn per C1. */
export interface ChatPageCursorV1 {
  readonly generation: number;
  readonly beforeOffset: number;
}

export interface ChatLoadResultV1 {
  readonly records: readonly ChatRecord[];
  readonly prevCursor: ChatPageCursorV1 | null;
}

export interface ChatHandleV1 {
  readonly header: ChatHeaderV1;
  loadTail(limit?: number, byteBudget?: number): Promise<FailureDtoV1 | ChatLoadResultV1>;
  loadBefore(
    cursor: ChatPageCursorV1,
    limit?: number,
    byteBudget?: number,
  ): Promise<FailureDtoV1 | ChatLoadResultV1>;
}

export interface ChatReader {
  open(chatId: string): Promise<FailureDtoV1 | ChatHandleV1>;
  /**
   * The chat's send-time append-base — `{length, prefixSha256}` ({@link
   * ReadSetAppendBaseV1}), turn-durability §7.5's own CAS baseline `turn.start` durably
   * captures at admission and `finalizeTurn` re-checks before ever committing a write.
   * Closes "Gap 4" (`core/kernel/model/handlers/turn.ts`'s own header, kernel-assembly
   * Task 9): `open()`/`ChatHandleV1` decode RECORDS only — `loadTail`/`loadBefore` never
   * expose the underlying JSONL file's raw byte length or prefix hash, and nothing else on
   * this port (or `ChatMutations`) does either. `AdmissionWorkspaceMaterialV1.readSet.chat`
   * is NOT nullable (unlike the manifest snapshot below) — there is no honest "absent"
   * value for an active chat's own append-base, so a chat that cannot be read this way
   * must block admission rather than substitute a placeholder (see that type's own
   * header for why fabricating one would defeat the CAS check's whole purpose).
   *
   * Mirrors `store/jsonl`'s own `JsonlDocument.validPrefixBytes`/`prefixSha256`
   * (`store/jsonl/types.ts`) — the exact fact the real reader already computes on every
   * from-byte-zero decode. `store/jsonl/model/chat-index.ts`'s own `ChatIndexState`
   * projection (the incrementally-updated index `loadTail`/`loadBefore` actually read from)
   * does NOT currently retain a full-prefix hash after an incremental append — only bounded
   * `firstWindowSha256`/`finalWindowSha256` (§7.4's own window design, sized for a cheap
   * update check, not a full-prefix CAS fact) — so WP-2's real adapter is free to derive
   * this value however it likes (e.g. re-deriving it from the canonical reader's own
   * `JsonlDocument.prefixSha256` at read time), as long as the two fields describe exactly
   * the same valid prefix `open()` would decode; extending `ChatIndexState` itself to cache
   * a full-prefix hash, if that turns out cheaper, is that adapter's own implementation
   * choice, not this port's concern. Port + fake only here — the real adapter is WP-2's
   * job, mirroring `StagingService.readCandidateFile`'s identical division
   * (`core/ports/staging.ts`).
   */
  readAppendBase(chatId: string): Promise<FailureDtoV1 | ReadSetAppendBaseV1>;
}

export interface ChatMutations {
  /** `chat.create` (§8.2): "Create and select a fresh chat through a Kernel transaction." */
  create(): Promise<FailureDtoV1 | ChatHeaderV1>;
  /** `chat.switch` (§8.2): "Select an existing chat without changing shared pages, preview, selection, or pins." */
  switchActive(chatId: string): Promise<FailureDtoV1 | undefined>;
}
