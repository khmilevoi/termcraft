import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createFakePinStore } from "core/ports/fakes";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import type { PinCreatedEvent, PinEvent } from "entities/pin";
import { uuidv7 } from "infrastructure/uuid";
import { encodeCommentsHeaderLine, encodePinEventLine } from "store/jsonl";
import { pageCommentsPath } from "store/transaction";

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

function concatBytes(pieces: readonly Uint8Array[]): Uint8Array {
  const total = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.byteLength;
  }
  return out;
}

/** Writes raw bytes directly to a page's comments log, bypassing `SafeProjectFs`'s own transaction machinery — the only way this test can seed a genuinely corrupt file on disk. */
function writeRawComments(
  open: { readonly safeFs: { readonly root: { readonly realPath: string } } },
  pageSlug: PageSlug,
  bytes: Uint8Array,
): void {
  const absPath = path.join(open.safeFs.root.realPath, ...pageCommentsPath(pageSlug).split("/"));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, bytes);
}

/**
 * A comments log whose two `pin:created` lines share one `recordId` — an identity violation
 * inside the valid prefix (storage-identity §11.1/§4.4 item 5), so `readPinsJsonl` returns
 * `JsonlMidFileCorruptionError` directly rather than a document with an "unproven" tail. This
 * is the one raw-bytes shape that turns into a genuine `FailureDtoV1` from `readAppendBase`,
 * as opposed to the honest "no comments log yet" empty base a merely-missing file produces.
 */
function corruptedCommentsBytes(pageSlug: PageSlug): Uint8Array {
  const header = encodeCommentsHeaderLine({
    kind: "pins",
    formatVersion: 1,
    projectId: uuidv7(),
    pageSlug,
  });
  if (header instanceof Error) throw new Error(`fixture bug: ${header.message}`);
  const duplicateRecordId = uuidv7();
  const event1: PinEvent = { ...createdEvent(uuidv7()), recordId: duplicateRecordId };
  const event2: PinEvent = { ...createdEvent(uuidv7()), recordId: duplicateRecordId };
  const line1 = encodePinEventLine(event1);
  if (line1 instanceof Error) throw new Error(`fixture bug: ${line1.message}`);
  const line2 = encodePinEventLine(event2);
  if (line2 instanceof Error) throw new Error(`fixture bug: ${line2.message}`);
  return concatBytes([header, line1, line2]);
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

  // phase-8 WP-6 (docs/superpowers/specs/2026-07-25-mvp-phase-8-design.md §WP-6): the
  // pin-log analogue of `chat-store.test.ts`'s own `readAppendBase()` describe block. See
  // `pin-store.ts`'s own doc comment on `readAppendBase` for the full CAS-check citation.
  describe("readAppendBase()", () => {
    test("on a page with no comments log yet returns the honest empty base — the exact value `emptyBefore()` produces for a missing file, never a failure", async () => {
      const { open, deps } = await createRealProjectFixture();
      try {
        const adapter = createPinStoreAdapter(deps);
        const base = await adapter.readAppendBase(HOME_SLUG);
        if ("code" in base) throw new Error("fixture bug: readAppendBase failed");
        expect(base.length).toBe(0);
        // sha256("") — the well-known digest of zero bytes, matching
        // `store/transaction/model/wrappers.ts`'s own `emptyBefore()` exactly.
        expect(base.prefixSha256).toBe(
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
      } finally {
        await open.close();
      }
    });

    test("changes once a pin event is appended — never a fabricated, unchanging baseline", async () => {
      const { open, deps } = await createRealProjectFixture();
      try {
        const adapter = createPinStoreAdapter(deps);
        const before = await adapter.readAppendBase(HOME_SLUG);
        if ("code" in before) throw new Error("fixture bug: readAppendBase failed");

        const appended = await adapter.appendStandaloneEvent(HOME_SLUG, createdEvent(uuidv7()));
        expect(appended).toBeUndefined();

        const after = await adapter.readAppendBase(HOME_SLUG);
        if ("code" in after) throw new Error("fixture bug: readAppendBase failed");

        expect(after.length).toBeGreaterThan(before.length);
        expect(after.prefixSha256).not.toBe(before.prefixSha256);
      } finally {
        await open.close();
      }
    });

    test("reading twice with nothing appended in between yields the SAME length/hash", async () => {
      const { open, deps } = await createRealProjectFixture();
      try {
        const adapter = createPinStoreAdapter(deps);
        await adapter.appendStandaloneEvent(HOME_SLUG, createdEvent(uuidv7()));

        const first = await adapter.readAppendBase(HOME_SLUG);
        const second = await adapter.readAppendBase(HOME_SLUG);
        if ("code" in first) throw new Error("fixture bug: readAppendBase failed");
        if ("code" in second) throw new Error("fixture bug: readAppendBase failed");
        expect(first).toEqual(second);
      } finally {
        await open.close();
      }
    });

    test("a genuine mid-file corruption (duplicate recordId) surfaces as a FailureDtoV1, never a throw", async () => {
      const { open, deps } = await createRealProjectFixture();
      try {
        const adapter = createPinStoreAdapter(deps);
        writeRawComments(open, HOME_SLUG, corruptedCommentsBytes(HOME_SLUG));

        const result = await adapter.readAppendBase(HOME_SLUG);

        expect("code" in result).toBe(true);
      } finally {
        await open.close();
      }
    });
  });
});
