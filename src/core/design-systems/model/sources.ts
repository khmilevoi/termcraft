import * as errore from "errore";

import type { DesignSystemSource } from "core/ports";
import type { DesignSystemRef } from "entities/design-system-ref";
import { log } from "infrastructure/debug-log";

import type { DesignSystemUpdateV1, SourceListingV1 } from "../types";

/**
 * `core/design-systems`'s trust gate, bounded multi-source list, and update check
 * (project-design-systems design §8.4, §8.5; decisions D9, D10).
 *
 * TRUST (D9). `listGrantedSources` never calls `list()` on a source `deps.isGranted` refuses —
 * not "calls it and discards the answer". §8.4: "an unrecorded remote source is never queried."
 * The grant check itself (`TrustGate.buildSourceSubject`/`isSourceGranted`, `local`'s no-prompt
 * grant) is the CALLER'S concern (a later task wires the closure); this module only enforces that
 * the callback gates the call.
 *
 * BOUND (D10). The port has no `signal`, so the bound is a `Promise.race` against a timer
 * resolved in a `finally`, with the loser abandoned — a local `list` is bounded by the
 * filesystem anyway, and a network adapter that ignores its own bound is a bug in that adapter no
 * race here can repair. `DesignSystemSourceTimeoutError` extends `errore.AbortError` so
 * `errore.isAbortError` finds it through a `cause` chain even after `.catch()` wraps it.
 *
 * SOURCES LIST CONCURRENTLY: one `listOne` per source under `Promise.all`, so one slow source
 * never serializes behind another — each source gets its own independent bound.
 */

export const DESIGN_SYSTEM_LIST_TIMEOUT_MS = 3000;

export class DesignSystemSourceTimeoutError extends errore.createTaggedError({
  name: "DesignSystemSourceTimeoutError",
  message: "source $sourceId did not answer within $timeoutMs ms",
  extends: errore.AbortError,
}) {}

/** The adapter family off a `DesignSystemSource.id`: the part before the first `:`, or the whole id. */
export function sourceKindOf(sourceId: string): string {
  const colonAt = sourceId.indexOf(":");
  return colonAt < 0 ? sourceId : sourceId.slice(0, colonAt);
}

function listingHead(source: DesignSystemSource) {
  return { sourceId: source.id, label: source.label, canPublish: source.canPublish } as const;
}

/** One source's bounded, grant-gated listing. Never throws — every outcome is a `SourceListingV1`. */
async function listOne(
  source: DesignSystemSource,
  isGranted: (source: DesignSystemSource) => Promise<boolean>,
  timeoutMs: number,
): Promise<SourceListingV1> {
  const head = listingHead(source);

  const granted = await isGranted(source);
  // §8.4: "an unrecorded remote source is NEVER QUERIED" — the call is not made at all, not made
  // and then ignored. That distinction is the whole point of the grant.
  if (!granted)
    return { ...head, state: "ungranted", systems: [], reason: "this source has not been granted" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DesignSystemSourceTimeoutError>((resolve) => {
    timer = setTimeout(
      () => resolve(new DesignSystemSourceTimeoutError({ sourceId: source.id, timeoutMs })),
      timeoutMs,
    );
  });
  // THE PORT HAS NO `signal`, so the loser of this race is ABANDONED rather than cancelled — see
  // the header. Adding a `signal` would be a port change, and the port must not change (§10).
  const raced = await Promise.race([source.list(), timeout]).finally(() => clearTimeout(timer));

  if (raced instanceof Error) {
    log.warn("design-systems: source unavailable:", source.id, raced.message);
    return { ...head, state: "unavailable", systems: [], reason: raced.message };
  }
  // This ring narrows a `FailureDtoV1` with `"code" in result`, never `instanceof Error` — the DTO
  // is a plain object (`core/project/model/trust.ts`'s identical idiom).
  if ("code" in raced) {
    log.warn("design-systems: source failed:", source.id, raced.safeMessage);
    return { ...head, state: "unavailable", systems: [], reason: raced.safeMessage };
  }
  return { ...head, state: "listed", systems: raced, reason: null };
}

/**
 * Lists every source `deps.isGranted` grants, bounded per source (D10), and reports every other
 * source as `ungranted`/`unavailable` — never queried, never thrown. Listing order mirrors
 * `deps.sources`'s configured order, so the picker is stable across runs regardless of which
 * source answers first.
 */
export async function listGrantedSources(deps: {
  readonly sources: readonly DesignSystemSource[];
  readonly isGranted: (source: DesignSystemSource) => Promise<boolean>;
  readonly timeoutMs?: number;
}): Promise<readonly SourceListingV1[]> {
  const timeoutMs = deps.timeoutMs ?? DESIGN_SYSTEM_LIST_TIMEOUT_MS;
  return Promise.all(deps.sources.map((source) => listOne(source, deps.isGranted, timeoutMs)));
}

/**
 * §8.5's update check: is there a DIFFERENT version of the installed system at the SOURCE the
 * project recorded? `installedRef === null` (no provenance record — P4's scaffold and migration
 * write none) means the question does not apply, never a false offer.
 */
export function detectDesignSystemUpdate(input: {
  readonly installedRef: DesignSystemRef | null;
  readonly listings: readonly SourceListingV1[];
}): DesignSystemUpdateV1 | null {
  const installedRef = input.installedRef;
  if (installedRef === null) return null;

  const listing = input.listings.find(
    (candidate) => candidate.sourceId === installedRef.sourceId && candidate.state === "listed",
  );
  if (listing === undefined) return null;

  const available = listing.systems.find((system) => system.id === installedRef.systemId);
  if (available === undefined) return null;

  // A reference's version is OPAQUE (`source:system@version`, §8.1). Inventing a semver ordering
  // here would make `1.10.0` older than `1.9.0` for any system that does not use semver, so the
  // answer is "the source offers a DIFFERENT version", not "a newer one" — and the shell's copy
  // says exactly that. A same-version REPUBLISH is not detectable here at all: `DesignSystemSummaryV1`
  // carries no content hash (a summary is one `design-system.json`; the hash is over the whole file
  // set, §8.2), so that case is caught at the next `fetch`, not by this comparison — see the test
  // named for it. Widening the port's summary to carry a hash is not an option (§10).
  if (available.version === installedRef.version) return null;

  return { installedRef, available, reason: "different-version" };
}
