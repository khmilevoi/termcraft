import type { FailureDtoV1 } from "core/protocol";
import type { PageSlug } from "entities/page";
import { foldPins } from "entities/pin";
import type { Pin, PinEvent } from "entities/pin";

import type { AssertConforms } from "../index";
import type { PinMutations, PinReader } from "../pin-store";

/**
 * In-memory {@link PinReader}/{@link PinMutations} fake (6D task brief). Reuses the REAL
 * `entities/pin` `foldPins` over an appended event log rather than reimplementing fold
 * semantics — the fake's fidelity to storage-identity §11.2 (last status wins, file order
 * authoritative) comes for free and cannot drift from the entity's own behavior.
 */

const FOLD_FAILED = (pageSlug: PageSlug, reason: string): FailureDtoV1 => ({
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: `pin log fold failed for ${pageSlug}: ${reason}`,
  details: { pageSlug },
});

export type PinStoreFailableMethod = "fold" | "appendStandaloneEvent";

export type PinStoreCall =
  | { readonly method: "fold"; readonly pageSlug: PageSlug }
  | {
      readonly method: "appendStandaloneEvent";
      readonly pageSlug: PageSlug;
      readonly event: PinEvent;
    };

export interface FakePinStore extends PinReader, PinMutations {
  readonly calls: readonly PinStoreCall[];
  failNext(method: PinStoreFailableMethod, failure: FailureDtoV1): void;
}

export function createFakePinStore(): FakePinStore {
  const logs = new Map<PageSlug, PinEvent[]>();
  const calls: PinStoreCall[] = [];

  const queues: Record<PinStoreFailableMethod, FailureDtoV1[]> = {
    fold: [],
    appendStandaloneEvent: [],
  };

  function failNext(method: PinStoreFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  async function fold(pageSlug: PageSlug): Promise<FailureDtoV1 | readonly Pin[]> {
    calls.push({ method: "fold", pageSlug });
    const queued = queues.fold.shift();
    if (queued !== undefined) return queued;
    const events = logs.get(pageSlug) ?? [];
    const result = foldPins(events);
    if (result instanceof Error) return FOLD_FAILED(pageSlug, result.message);
    return result;
  }

  async function appendStandaloneEvent(
    pageSlug: PageSlug,
    event: PinEvent,
  ): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "appendStandaloneEvent", pageSlug, event });
    const queued = queues.appendStandaloneEvent.shift();
    if (queued !== undefined) return queued;
    const log = logs.get(pageSlug);
    if (log === undefined) logs.set(pageSlug, [event]);
    else log.push(event);
    return undefined;
  }

  return { fold, appendStandaloneEvent, calls, failNext };
}

type _ReaderConforms = AssertConforms<PinReader, FakePinStore>;
type _MutationsConforms = AssertConforms<PinMutations, FakePinStore>;
