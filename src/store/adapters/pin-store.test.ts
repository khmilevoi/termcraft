import { afterEach, describe, expect, test } from "bun:test";

import { createFakePinStore } from "core/ports/fakes";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import type { PinCreatedEvent } from "entities/pin";
import { uuidv7 } from "infrastructure/uuid";

import { createPinStoreAdapter } from "./pin-store";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";

afterEach(cleanupScratchRoots);

function mustParseSlug(raw: string): PageSlug {
  const slug = parsePageSlug(raw);
  if (slug instanceof Error) throw new Error(`fixture bug: ${slug.message}`);
  return slug;
}

const HOME_SLUG = mustParseSlug("home");
const ABOUT_SLUG = mustParseSlug("about");

function createdEvent(pinId: string): PinCreatedEvent {
  return {
    kind: "pin:created",
    recordId: uuidv7(),
    pinId,
    element: "#el",
    fx: 0.5,
    fy: 0.5,
    text: "a comment",
    ts: "2026-07-24T00:00:00.000Z",
  };
}

describe("createPinStoreAdapter — contract test (fake vs. real)", () => {
  test("fold()/readEvents() on a page with no comments log yet both return []", async () => {
    const fake = createFakePinStore();
    expect(await fake.fold(HOME_SLUG)).toEqual([]);
    expect(await fake.readEvents(HOME_SLUG)).toEqual([]);

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createPinStoreAdapter(deps);
      expect(await adapter.fold(HOME_SLUG)).toEqual([]);
      expect(await adapter.readEvents(HOME_SLUG)).toEqual([]);
    } finally {
      await open.close();
    }
  });

  test("appendStandaloneEvent() creates the page's comments log; fold()/readEvents() then see it", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createPinStoreAdapter(deps);
      const pinId = uuidv7();
      const appended = await adapter.appendStandaloneEvent(HOME_SLUG, createdEvent(pinId));
      expect(appended).toBeUndefined();

      const events = await adapter.readEvents(HOME_SLUG);
      if ("code" in events) throw new Error("fixture bug: readEvents failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("pin:created");

      const pins = await adapter.fold(HOME_SLUG);
      if ("code" in pins) throw new Error("fixture bug: fold failed");
      expect(pins).toHaveLength(1);
      expect(pins[0]?.pinId).toBe(pinId);
      expect(pins[0]?.status).toBe("open");
    } finally {
      await open.close();
    }
  });

  test("findPageForPin() finds the owning page across several pages, and returns null on a genuine miss", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createPinStoreAdapter(deps);

      // `findPageForPin` scans `open.pages.listSlugs()` — the manifest's own ordering
      // authority (storage-identity §5.1) — so the page must be LISTED before its comments
      // log is in scope, matching `listSlugs()`'s own "= the manifest's pages array" doc.
      const manifestBefore = await open.manifest.read();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);
      const listed = await open.transactions.reorderPages({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore,
        orderedSlugs: [HOME_SLUG, ABOUT_SLUG],
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      if (listed instanceof Error) throw new Error(`fixture bug: ${listed.message}`);

      const pinId = uuidv7();
      const appended = await adapter.appendStandaloneEvent(ABOUT_SLUG, createdEvent(pinId));
      expect(appended).toBeUndefined();

      const found = await adapter.findPageForPin(pinId);
      expect(found).toBe(ABOUT_SLUG);

      const missing = await adapter.findPageForPin(uuidv7());
      expect(missing).toBeNull();
    } finally {
      await open.close();
    }
  });
});
