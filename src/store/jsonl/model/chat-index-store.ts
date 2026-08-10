// The real, disk-backed `ChatIndexPageStore` + `ChatIndexState` persistence for the chat
// index (projections §7.1, §16.1, §16.3). Before this file existed, the ONLY
// `ChatIndexPageStore` implementation anywhere in the codebase was an in-memory `Map`
// constructed fresh inside every `ChatStore.open()` call (`store/model/factory.ts`), so
// `buildChatIndex`'s generation-1 full rebuild ran on every open and every restart — the
// on-disk index projections §7.1 requires ("resident index memory does not grow with record
// count; the on-disk index does") never actually existed (blocker finding #3).
//
// Mirrors `store/projections`'s already-landed local-cache pattern (`page-meta-cache.ts`,
// `diagnostics-store.ts`, `render-cache.ts`): temp-write -> verify -> rename via the injected
// `durableWrite`, corrupt/missing local cache is a MISS (never an open-blocking error) so a
// damaged cache directory costs a rebuild, not a broken Workspace. Declared here rather than
// in `store/projections` because it is the real binding for a `store/jsonl`-OWNED interface
// (`ChatIndexPageStore`) — the same "each submodule provides its own real binding for its own
// interface" shape as `store/safe-fs`'s `nodeSafeFsDeps` or `store/trust`'s `nodeTrustFsDeps` —
// and `store/jsonl` is not itself a dependency `store/projections` was ever wired to take
// (plan Wave E: T18 depends on T4/T6 only).
import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";
import { z } from "zod";

import { log } from "infrastructure/debug-log";
import type { DurabilityError } from "infrastructure/durability";

import type { ChatIndexPage, ChatIndexPageStore, ChatIndexState } from "../types";

// ---- errors -----------------------------------------------------------------------

/** The persisted chat-index cache's own local I/O failed — distinct from a plain miss (missing/corrupt entries are misses, never errors). */
export class ChatIndexStoreIoError extends errore.createTaggedError({
  name: "ChatIndexStoreIoError",
  message: "chat-index cache $operation failed for $path: $detail",
}) {}

// ---- schema (loose — this cache never needs to reject a shape the code itself wrote) ------

const pageDirectoryEntrySchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(),
  firstOffsetStart: z.number().int().nonnegative(),
  lastOffsetEnd: z.number().int().nonnegative(),
  checksum: z.string(),
});

const tailClassificationSchema = z.union([
  z.object({ kind: z.literal("clean") }),
  z.object({ kind: z.literal("transaction-proven-append-interruption"), append: z.unknown() }),
  z.object({ kind: z.literal("unproven-corrupt-suffix"), report: z.unknown() }),
]);

const chatIndexStateSchema = z.object({
  chatId: z.string(),
  generation: z.number().int().nonnegative(),
  canonicalIdentity: z.string(),
  projectViewGeneration: z.string(),
  totalBytes: z.number().int().nonnegative(),
  validPrefixBytes: z.number().int().nonnegative(),
  firstWindowSha256: z.string(),
  finalWindowSha256: z.string(),
  tail: tailClassificationSchema,
  pages: z.array(pageDirectoryEntrySchema),
});

const chatIndexEntrySchema = z.object({
  recordId: z.string(),
  turnId: z.string().optional(),
  ts: z.string(),
  changedPages: z.array(z.string()),
  offsetStart: z.number().int().nonnegative(),
  offsetEnd: z.number().int().nonnegative(),
});

const chatIndexPageSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  entries: z.array(chatIndexEntrySchema),
  checksum: z.string(),
});

// ---- production filesystem wiring --------------------------------------------------

/** `ENOENT` is the ordinary "not present yet" case, not a fault. */
function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
  );
}

export interface ChatIndexCacheFsDeps {
  readonly readFile: (absPath: string) => Uint8Array | null | ChatIndexStoreIoError;
  readonly durableWrite: (absPath: string, bytes: Uint8Array) => DurabilityError | undefined;
  readonly ensureDir: (absDir: string) => ChatIndexStoreIoError | undefined;
}

/** The real Node bindings. `infrastructure/durability`'s `durableFileWrite` is the injected `durableWrite` — the only write path, matching every other local-cache store in this codebase. */
export function nodeChatIndexCacheFsDeps(
  durableWrite: (absPath: string, bytes: Uint8Array) => DurabilityError | undefined,
): ChatIndexCacheFsDeps {
  return {
    readFile(absPath) {
      const bytes = errore.try({
        try: () => new Uint8Array(fs.readFileSync(absPath)),
        catch: (cause) =>
          new ChatIndexStoreIoError({
            operation: "read",
            path: absPath,
            detail: String(cause),
            cause,
          }),
      });
      if (bytes instanceof Error) return isMissingFile(bytes.cause) ? null : bytes;
      return bytes;
    },
    durableWrite,
    ensureDir(absDir) {
      return errore.try({
        try: () => {
          fs.mkdirSync(absDir, { recursive: true });
          return undefined;
        },
        catch: (cause) =>
          new ChatIndexStoreIoError({
            operation: "mkdir",
            path: absDir,
            detail: String(cause),
            cause,
          }),
      });
    },
  };
}

// ---- paths --------------------------------------------------------------------------

function chatCacheDir(root: string, chatId: string): string {
  return path.join(root, chatId);
}
function stateJsonPath(root: string, chatId: string): string {
  return path.join(chatCacheDir(root, chatId), "state.json");
}
function pageJsonPath(root: string, chatId: string, pageIndex: number): string {
  return path.join(chatCacheDir(root, chatId), `page-${pageIndex}.json`);
}

// ---- the persisted page store (`ChatIndexPageStore`) ---------------------------------

/**
 * The disk-backed `ChatIndexPageStore`: one JSON file per page, under `<root>/<chatId>/`.
 * `readPage` returning `null` covers BOTH "never written" and "unparseable" — a damaged page
 * file is a rebuildable-projection MISS, not a hard error (the caller's checksum re-verify in
 * `chat-index.ts`'s `readVerifiedPage` is the integrity check that matters; this store adds
 * corruption tolerance underneath it).
 */
export function createNodeChatIndexPageStore(
  root: string,
  fs: ChatIndexCacheFsDeps,
): ChatIndexPageStore {
  return {
    async writePage(chatId, page) {
      const created = fs.ensureDir(chatCacheDir(root, chatId));
      if (created instanceof Error) return created;
      const target = pageJsonPath(root, chatId, page.pageIndex);
      const wrote = fs.durableWrite(target, new TextEncoder().encode(JSON.stringify(page)));
      if (wrote instanceof Error)
        return new ChatIndexStoreIoError({
          operation: "write",
          path: target,
          detail: wrote.message,
          cause: wrote,
        });
      return undefined;
    },

    async readPage(chatId, pageIndex) {
      const target = pageJsonPath(root, chatId, pageIndex);
      const bytes = fs.readFile(target);
      if (bytes instanceof Error) return bytes;
      if (bytes === null) return null;

      const parsed = errore.try({
        try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        catch: (cause) => new Error("not valid JSON", { cause }),
      });
      if (parsed instanceof Error) {
        log.warn("chat-index cache: page ignored (miss):", target, parsed.message);
        return null;
      }
      const decoded = chatIndexPageSchema.safeParse(parsed);
      if (!decoded.success) {
        log.warn(
          "chat-index cache: page ignored (miss):",
          target,
          "does not match the page schema",
        );
        return null;
      }
      // `changedPages` is branded `PageSlug[]` in `ChatIndexPage` (`entities/page`) — this
      // cache re-persists exactly what `chat-index.ts` already wrote and verifies it via the
      // entry's own checksum on every read, so re-asserting the brand here (rather than
      // importing `entities/page`'s parser into this domain-free cache reader) is safe.
      return decoded.data as unknown as ChatIndexPage;
    },
  };
}

// ---- the persisted index state (the chatId -> ChatIndexState side of §7.1) ----------

export interface ChatIndexStateStore {
  /** `null` for both "never built" and "unreadable" — either way `ChatStore.open` falls back to a full rebuild, never a hard failure. */
  read(chatId: string): Promise<ChatIndexState | null>;
  write(chatId: string, state: ChatIndexState): Promise<ChatIndexStoreIoError | undefined>;
}

export function createNodeChatIndexStateStore(
  root: string,
  fs: ChatIndexCacheFsDeps,
): ChatIndexStateStore {
  return {
    async read(chatId) {
      const target = stateJsonPath(root, chatId);
      const bytes = fs.readFile(target);
      if (bytes instanceof Error) {
        log.warn("chat-index cache: state ignored (miss):", target, bytes.message);
        return null;
      }
      if (bytes === null) return null;

      const parsed = errore.try({
        try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        catch: (cause) => new Error("not valid JSON", { cause }),
      });
      if (parsed instanceof Error) {
        log.warn("chat-index cache: state ignored (miss):", target, parsed.message);
        return null;
      }
      const decoded = chatIndexStateSchema.safeParse(parsed);
      if (!decoded.success) {
        log.warn(
          "chat-index cache: state ignored (miss):",
          target,
          "does not match the state schema",
        );
        return null;
      }
      return decoded.data as ChatIndexState;
    },

    async write(chatId, state) {
      const created = fs.ensureDir(chatCacheDir(root, chatId));
      if (created instanceof Error) return created;
      const target = stateJsonPath(root, chatId);
      const wrote = fs.durableWrite(target, new TextEncoder().encode(JSON.stringify(state)));
      if (wrote instanceof Error)
        return new ChatIndexStoreIoError({
          operation: "write",
          path: target,
          detail: wrote.message,
          cause: wrote,
        });
      return undefined;
    },
  };
}
