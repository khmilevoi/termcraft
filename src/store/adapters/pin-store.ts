import type { AssertConforms, PinMutations, PinReader, ReadSetAppendBaseV1 } from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import type { PageSlug } from "entities/page";
import type { Pin, PinEvent } from "entities/pin";
import { readPinsJsonl, sha256Hex } from "store/jsonl";
import { FsAccessError, isNotFound } from "store/safe-fs";
import { pinsJsonlPath } from "store/transaction";

import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";
import { nowIso } from "./types";

// `createPinStoreAdapter` — the `PinReader & PinMutations` port over `OpenProject.pins`/
// `OpenProject.transactions` (plan Task 1). `readEvents`/`findPageForPin` need no new
// store-internal accessor: `OpenProject.safeFs` already reaches each page's raw comments
// JSONL, and `store/jsonl`'s already-public `readPinsJsonl` already decodes it into the
// same `PinEvent[]` `PinStore.fold`'s own projection is built from. `readAppendBase` (phase-8
// WP-6, the pin-log analogue of `store/adapters/chat-store.ts`'s `readAppendBase`) needs no
// new accessor either: the SAME `readPinsJsonl({path, chunks: [bytes]})` call `readRawEvents`
// below already makes also decodes `validPrefixBytes`/`prefixSha256` — the exact
// `{length, prefixSha256}` pair `store/transaction/model/wrappers.ts`'s own `readPinsBefore`
// computes from the identical file for `buildFinalizeCasPrecondition`'s `pins:<slug>` check.

/** The page's raw pin-event log, or `[]` for a page with no comments log yet (mirrors `fold()`'s own rule). */
async function readRawEvents(
  open: StoreAdapterDeps["open"],
  pageSlug: PageSlug,
): Promise<FailureDtoV1 | readonly PinEvent[]> {
  const relPath = pinsJsonlPath(pageSlug);
  const bytes = open.safeFs.readFile(relPath);
  if (bytes instanceof Error) {
    if (bytes instanceof FsAccessError && isNotFound(bytes)) return [];
    return toFailureDto(bytes);
  }
  const doc = readPinsJsonl({ path: relPath, chunks: [bytes] });
  if (doc instanceof Error) return toFailureDto(doc);
  return doc.records;
}

export function createPinStoreAdapter(deps: StoreAdapterDeps): PinReader & PinMutations {
  const { open } = deps;

  async function fold(pageSlug: PageSlug): Promise<FailureDtoV1 | readonly Pin[]> {
    const result = await open.pins.fold(pageSlug);
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

  async function readEvents(pageSlug: PageSlug): Promise<FailureDtoV1 | readonly PinEvent[]> {
    return readRawEvents(open, pageSlug);
  }

  /**
   * Mirrors `readRawEvents`'s own "no comments log yet" handling (honest, never a failure —
   * see `PinReader.readAppendBase`'s own doc comment for why this deliberately diverges from
   * `ChatReader.readAppendBase`), but returns the SAME zero-length/empty-hash value
   * `store/transaction/model/wrappers.ts`'s own `emptyBefore()` produces for a missing file,
   * rather than `readRawEvents`'s `[]` — `buildFinalizeCasPrecondition` compares against
   * `emptyBefore()` verbatim for a page with no comments log, so this must match it exactly,
   * not merely be "some" honest empty.
   */
  async function readAppendBase(pageSlug: PageSlug): Promise<FailureDtoV1 | ReadSetAppendBaseV1> {
    const relPath = pinsJsonlPath(pageSlug);
    const bytes = open.safeFs.readFile(relPath);
    if (bytes instanceof Error) {
      if (bytes instanceof FsAccessError && isNotFound(bytes)) {
        return { length: 0, prefixSha256: sha256Hex(new Uint8Array(0)) };
      }
      return toFailureDto(bytes);
    }
    const doc = readPinsJsonl({ path: relPath, chunks: [bytes] });
    if (doc instanceof Error) return toFailureDto(doc);
    return { length: doc.validPrefixBytes, prefixSha256: doc.prefixSha256 };
  }

  async function findPageForPin(pinId: string): Promise<FailureDtoV1 | PageSlug | null> {
    const slugs = await open.pages.listSlugs();
    if (slugs instanceof Error) return toFailureDto(slugs);

    for (const pageSlug of slugs) {
      const events = await readRawEvents(open, pageSlug);
      if ("code" in events) return events; // FailureDtoV1 — a real I/O fault, not a miss
      if (events.some((event) => event.kind === "pin:created" && event.pinId === pinId)) {
        return pageSlug;
      }
    }
    return null;
  }

  async function appendStandaloneEvent(
    pageSlug: PageSlug,
    event: PinEvent,
  ): Promise<FailureDtoV1 | undefined> {
    const manifest = await open.manifest.read();
    if (manifest instanceof Error) return toFailureDto(manifest);

    const result = await open.transactions.appendPinEvent({
      transactionId: deps.uuidv7(),
      actionId: deps.uuidv7(),
      pageSlug,
      projectId: manifest.projectId,
      event,
      createdAt: nowIso(deps.clock),
    });
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  return { fold, readEvents, findPageForPin, readAppendBase, appendStandaloneEvent };
}

type _Conforms = AssertConforms<PinReader & PinMutations, ReturnType<typeof createPinStoreAdapter>>;
