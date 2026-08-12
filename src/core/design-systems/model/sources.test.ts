import { describe, expect, test } from "bun:test";

import * as errore from "errore";

import type { DesignSystemSummaryV1 } from "core/ports";
import { createFakeDesignSystemSource } from "core/ports/fakes/design-system-source";
import type { FailureDtoV1 } from "core/protocol";
import type { DesignSystemRef } from "entities/design-system-ref";
import { parseDesignSystemRef } from "entities/design-system-ref";

import type { SourceListingV1 } from "../types";
import {
  DesignSystemSourceTimeoutError,
  detectDesignSystemUpdate,
  listGrantedSources,
  sourceKindOf,
} from "./sources";

/**
 * `listGrantedSources` (decisions D9, D10) and `detectDesignSystemUpdate` (§8.5): the
 * grant-gated bounded-timeout multi-source list, and the update check over its output.
 */

const MIDNIGHT_SUMMARY: DesignSystemSummaryV1 = {
  id: "midnight",
  name: "Midnight",
  version: "1.2.0",
  kitApiVersion: 1,
  defaultTheme: "dark",
  defaultThemeTokens: [],
  componentNames: [],
};

function refOf(raw: string): DesignSystemRef {
  const parsed = parseDesignSystemRef(raw);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

function listing(sourceId: string, systems: readonly DesignSystemSummaryV1[]): SourceListingV1 {
  return { sourceId, label: sourceId, canPublish: true, state: "listed", systems, reason: null };
}

/**
 * Wraps `core/ports/fakes/design-system-source.ts`'s real fake with a `listCalls` counter — the
 * property `§8.4: an UNGRANTED source is never queried` observes directly, and that the fake's
 * own `calls` log records without needing a second bookkeeping mechanism.
 */
function createRecordingSource(options: {
  readonly id: string;
  readonly systems?: readonly DesignSystemSummaryV1[];
  readonly delayMs?: number;
  readonly failure?: FailureDtoV1;
}) {
  const fake = createFakeDesignSystemSource({
    id: options.id,
    label: options.id,
    canPublish: true,
    listDelayMs: options.delayMs,
  });
  for (const summary of options.systems ?? []) fake.seed(summary, []);
  if (options.failure !== undefined) fake.failNext("list", options.failure);
  return {
    ...fake,
    get listCalls() {
      return fake.calls.filter((call) => call.method === "list").length;
    },
  };
}

describe("listGrantedSources", () => {
  test("§8.4: an UNGRANTED source is never queried", async () => {
    const source = createRecordingSource({ id: "github:acme/ds" });
    const listings = await listGrantedSources({ sources: [source], isGranted: async () => false });
    expect(source.listCalls).toBe(0); // the property that matters, not the label
    expect(listings[0]?.state).toBe("ungranted");
    expect(listings[0]?.systems).toEqual([]);
  });

  test("a granted source lists", async () => {
    const source = createRecordingSource({ id: "local", systems: [MIDNIGHT_SUMMARY] });
    const listings = await listGrantedSources({ sources: [source], isGranted: async () => true });
    expect(listings[0]?.state).toBe("listed");
    expect(listings[0]?.systems).toEqual([MIDNIGHT_SUMMARY]);
  });

  test("§8.4: an unreachable source degrades under the bound — the others still list", async () => {
    const slow = createRecordingSource({ id: "github:acme/ds", delayMs: 10_000 });
    const local = createRecordingSource({ id: "local", systems: [MIDNIGHT_SUMMARY] });
    const listings = await listGrantedSources({
      sources: [slow, local],
      isGranted: async () => true,
      timeoutMs: 20,
    });
    const bySource = new Map(listings.map((entry) => [entry.sourceId, entry]));
    expect(bySource.get("github:acme/ds")?.state).toBe("unavailable");
    expect(bySource.get("github:acme/ds")?.reason).toContain("did not answer");
    expect(bySource.get("local")?.state).toBe("listed");
  });

  test("a source that FAILS is unavailable with its safeMessage, never a thrown error", async () => {
    const failing = createRecordingSource({
      id: "local",
      failure: {
        code: "PERSISTENCE_FAILED",
        retryable: true,
        safeMessage: "library unreadable",
        details: {},
      },
    });
    const listings = await listGrantedSources({ sources: [failing], isGranted: async () => true });
    expect(listings[0]?.state).toBe("unavailable");
    expect(listings[0]?.reason).toBe("library unreadable");
  });

  test("listings keep the configured source order, so the picker is stable across runs", async () => {
    const listings = await listGrantedSources({
      sources: [
        createRecordingSource({ id: "local" }),
        createRecordingSource({ id: "github:acme/ds" }),
      ],
      isGranted: async () => true,
    });
    expect(listings.map((entry) => entry.sourceId)).toEqual(["local", "github:acme/ds"]);
  });
});

test("the timeout error is an errore AbortError, findable through a cause chain", () => {
  const error = new DesignSystemSourceTimeoutError({ sourceId: "x", timeoutMs: 1 });
  expect(errore.isAbortError(error)).toBe(true);
  expect(errore.isAbortError(new Error("wrapped", { cause: error }))).toBe(true);
});

test("sourceKindOf splits the adapter family off the id", () => {
  expect(sourceKindOf("local")).toBe("local");
  expect(sourceKindOf("github:acme/design-systems")).toBe("github");
});

describe("detectDesignSystemUpdate", () => {
  test("§8.5: a different version at the recorded address is an available update", () => {
    const update = detectDesignSystemUpdate({
      installedRef: refOf("local:midnight@1.2.0"),
      listings: [listing("local", [{ ...MIDNIGHT_SUMMARY, version: "1.3.0" }])],
    });
    expect(update?.reason).toBe("different-version");
    expect(update?.available.version).toBe("1.3.0");
  });

  test("the same version is not an update", () => {
    expect(
      detectDesignSystemUpdate({
        installedRef: refOf("local:midnight@1.2.0"),
        listings: [listing("local", [MIDNIGHT_SUMMARY])],
      }),
    ).toBeNull();
  });

  test("no provenance means no update check, never a false offer", () => {
    expect(
      detectDesignSystemUpdate({
        installedRef: null,
        listings: [listing("local", [MIDNIGHT_SUMMARY])],
      }),
    ).toBeNull();
  });

  test("an update is only offered from the SOURCE the project recorded", () => {
    expect(
      detectDesignSystemUpdate({
        installedRef: refOf("local:midnight@1.2.0"),
        listings: [listing("github:acme/ds", [{ ...MIDNIGHT_SUMMARY, version: "9.9.9" }])],
      }),
    ).toBeNull();
  });

  test("an unavailable source never produces an update", () => {
    expect(
      detectDesignSystemUpdate({
        installedRef: refOf("local:midnight@1.2.0"),
        listings: [
          {
            sourceId: "local",
            label: "Local library",
            canPublish: true,
            state: "unavailable",
            systems: [],
            reason: "timed out",
          },
        ],
      }),
    ).toBeNull();
  });

  test("a same-version REPUBLISH is not detectable from a summary — documented, not silently missed", () => {
    // `DesignSystemSummaryV1` carries no content hash: a summary is ONE `design-system.json`, and
    // the hash is over the whole file set (§8.2). So a republish at the same version is caught at
    // the next `fetch`, whose `contentHash` the install compares against the provenance record —
    // not here. Recorded as a decision rather than left as an oversight. WIDENING THE PORT'S
    // SUMMARY TO CARRY A HASH IS NOT AN OPTION: the port must not change (§10).
    expect(
      detectDesignSystemUpdate({
        installedRef: refOf("local:midnight@1.2.0"),
        listings: [listing("local", [MIDNIGHT_SUMMARY])],
      }),
    ).toBeNull();
  });
});
