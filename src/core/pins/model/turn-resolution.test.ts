import { describe, expect, test } from "bun:test";

import { isUuidv7 } from "core/protocol";
import type { PageSlug } from "entities/page";

import { type SentPinV1, resolveSentPinAppends } from "./turn-resolution";

const slug = (value: string): PageSlug => value as PageSlug;
const TURN_ID = "0192f6f0-0000-7000-8000-00000000aaaa";
const CREATED_AT = "2024-06-01T12:00:00.000Z";

function sentPin(pinId: string, pageSlug: PageSlug): SentPinV1 {
  return { pinId, pageSlug };
}

describe("resolveSentPinAppends", () => {
  test("resolves only sent pins whose page is in the non-empty changedPages set", () => {
    // §7.4 item 5 / §12.2 item 8: only a SENT pin on a CHANGED page resolves. Page "about"
    // is changed but has no sent pin (must not fabricate an entry), and pageC's sent pin
    // is on an UNCHANGED page (must not resolve).
    const pageA = slug("home");
    const pageB = slug("about");
    const pageC = slug("pricing");

    const result = resolveSentPinAppends({
      turnId: TURN_ID,
      sentPins: [sentPin("pin-a", pageA), sentPin("pin-c", pageC)],
      changedPages: [pageA, pageB],
      createdAt: CREATED_AT,
    });

    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry?.pageSlug).toBe(pageA);
    expect(entry?.event.kind).toBe("pin:status");
    if (entry?.event.kind !== "pin:status") throw new Error("expected pin:status");
    expect(entry.event.pinId).toBe("pin-a");
    expect(entry.event.status).toBe("resolved");
    expect(entry.event.turnId).toBe(TURN_ID);
    expect(entry.event.actionId).toBeUndefined();
    expect(entry.event.ts).toBe(CREATED_AT);
    expect(isUuidv7(entry.event.recordId)).toBe(true);
  });

  test("an empty design diff resolves none, even with sent pins present", () => {
    // §7.4 item 5 verbatim: "An empty design diff resolves no pin."
    const result = resolveSentPinAppends({
      turnId: TURN_ID,
      sentPins: [sentPin("pin-a", slug("home")), sentPin("pin-b", slug("about"))],
      changedPages: [],
      createdAt: CREATED_AT,
    });

    expect(result).toEqual([]);
  });

  test("mints a distinct recordId per resolved pin", () => {
    const pageA = slug("home");
    const result = resolveSentPinAppends({
      turnId: TURN_ID,
      sentPins: [sentPin("pin-a", pageA), sentPin("pin-b", pageA)],
      changedPages: [pageA],
      createdAt: CREATED_AT,
    });

    expect(result).toHaveLength(2);
    const recordIds = result.map((entry) =>
      entry.event.kind === "pin:status" ? entry.event.recordId : null,
    );
    expect(new Set(recordIds).size).toBe(2);
  });

  test("does not resolve more entries than there are matching sent pins", () => {
    // A buggy implementation could zip sentPins against changedPages positionally, or emit
    // one entry per changed page regardless of whether a sent pin exists for it. Three
    // changed pages, only one with a sent pin, must yield exactly one resolution.
    const pageA = slug("home");
    const result = resolveSentPinAppends({
      turnId: TURN_ID,
      sentPins: [sentPin("pin-a", pageA)],
      changedPages: [pageA, slug("about"), slug("pricing")],
      createdAt: CREATED_AT,
    });

    expect(result).toHaveLength(1);
  });
});
