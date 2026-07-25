import type { FailureDtoV1 } from "core/protocol";
import type { PageSlug } from "entities/page";
import { foldPins } from "entities/pin";
import type { Pin, PinEvent } from "entities/pin";

import type { AssertConforms } from "../index";
import type { PinMutations, PinReader } from "../pin-store";
import type { ReadSetAppendBaseV1 } from "../staging";

/**
 * In-memory {@link PinReader}/{@link PinMutations} fake (6D task brief). Reuses the REAL
 * `entities/pin` `foldPins` over an appended event log rather than reimplementing fold
 * semantics — the fake's fidelity to storage-identity §11.2 (last status wins, file order
 * authoritative) comes for free and cannot drift from the entity's own behavior.
 *
 * `readAppendBase` (phase-8 WP-6) mirrors `fakes/chat-store.ts`'s own `computeAppendBase` —
 * "an honest, deterministic append-base derived from the fake's OWN current in-memory
 * records" — over this fake's own `logs` map instead of chat records. A small local
 * `fakeSha256Hex` copy, not a shared import: `fakes/chat-store.ts`'s own header explains why
 * two independent, narrow fakes each get their own tiny copy rather than a new shared
 * fakes-utility module.
 */

const FOLD_FAILED = (pageSlug: PageSlug, reason: string): FailureDtoV1 => ({
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: `pin log fold failed for ${pageSlug}: ${reason}`,
  details: { pageSlug },
});

/**
 * A deterministic, valid-looking 64-hex-char digest derived from a seed — no real crypto, no
 * randomness. Mirrors `fakes/chat-store.ts`'s own identical `fakeSha256Hex` helper verbatim.
 */
function fakeSha256Hex(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  const base = (h >>> 0).toString(16).padStart(8, "0");
  return base.repeat(8).slice(0, 64);
}

/**
 * An honest, deterministic append-base derived from the fake's OWN current in-memory event
 * log for one page — never a fixed/fabricated placeholder. Serializing the whole event array
 * (not hashing incrementally) means the result changes whenever an event is genuinely
 * appended, and stays identical across repeated reads of unchanged state.
 */
function computeAppendBase(events: readonly PinEvent[]): ReadSetAppendBaseV1 {
  const serialized = JSON.stringify(events);
  return {
    length: new TextEncoder().encode(serialized).byteLength,
    prefixSha256: fakeSha256Hex(serialized),
  };
}

export type PinStoreFailableMethod =
  | "fold"
  | "appendStandaloneEvent"
  | "readEvents"
  | "findPageForPin"
  | "readAppendBase";

export type PinStoreCall =
  | { readonly method: "fold"; readonly pageSlug: PageSlug }
  | {
      readonly method: "appendStandaloneEvent";
      readonly pageSlug: PageSlug;
      readonly event: PinEvent;
    }
  | { readonly method: "readEvents"; readonly pageSlug: PageSlug }
  | { readonly method: "findPageForPin"; readonly pinId: string }
  | { readonly method: "readAppendBase"; readonly pageSlug: PageSlug };

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
    readEvents: [],
    findPageForPin: [],
    readAppendBase: [],
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

  async function readEvents(pageSlug: PageSlug): Promise<FailureDtoV1 | readonly PinEvent[]> {
    calls.push({ method: "readEvents", pageSlug });
    const queued = queues.readEvents.shift();
    if (queued !== undefined) return queued;
    return logs.get(pageSlug) ?? [];
  }

  async function findPageForPin(pinId: string): Promise<FailureDtoV1 | PageSlug | null> {
    calls.push({ method: "findPageForPin", pinId });
    const queued = queues.findPageForPin.shift();
    if (queued !== undefined) return queued;
    for (const [pageSlug, events] of logs) {
      if (events.some((event) => event.kind === "pin:created" && event.pinId === pinId)) {
        return pageSlug;
      }
    }
    return null;
  }

  async function readAppendBase(pageSlug: PageSlug): Promise<FailureDtoV1 | ReadSetAppendBaseV1> {
    calls.push({ method: "readAppendBase", pageSlug });
    const queued = queues.readAppendBase.shift();
    if (queued !== undefined) return queued;
    const events = logs.get(pageSlug) ?? [];
    return computeAppendBase(events);
  }

  return {
    fold,
    appendStandaloneEvent,
    readEvents,
    findPageForPin,
    readAppendBase,
    calls,
    failNext,
  };
}

type _ReaderConforms = AssertConforms<PinReader, FakePinStore>;
type _MutationsConforms = AssertConforms<PinMutations, FakePinStore>;
