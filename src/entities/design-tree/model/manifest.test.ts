import { describe, expect, test } from "bun:test";

import type { PageSlug } from "entities/page";

import { decodePagesManifest, encodePagesManifest } from "./manifest";

const VALID = JSON.stringify({
  schemaVersion: 1,
  pages: [
    { slug: "dashboard", entry: "pages/dashboard.tsx" },
    { slug: "calendar", entry: "screens/calendar/index.tsx" },
  ],
  requestedActivePage: "dashboard",
});

describe("decodePagesManifest", () => {
  test("accepts the design §4 example and preserves page order", () => {
    const manifest = decodePagesManifest(VALID);
    if (manifest instanceof Error) throw manifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.pages.map((page) => page.slug)).toEqual([
      "dashboard",
      "calendar",
    ] as PageSlug[]);
    expect(manifest.pages[1]?.entry).toBe("screens/calendar/index.tsx");
    expect(manifest.requestedActivePage).toBe("dashboard" as PageSlug);
  });

  test("requestedActivePage is null when absent", () => {
    const manifest = decodePagesManifest(
      JSON.stringify({ schemaVersion: 1, pages: [{ slug: "a", entry: "a.tsx" }] }),
    );
    if (manifest instanceof Error) throw manifest;
    expect(manifest.requestedActivePage).toBeNull();
  });

  test("rejects a duplicate slug", () => {
    const result = decodePagesManifest(
      JSON.stringify({
        schemaVersion: 1,
        pages: [
          { slug: "a", entry: "a.tsx" },
          { slug: "a", entry: "b.tsx" },
        ],
      }),
    );
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("duplicate");
  });

  test("rejects a requestedActivePage that is not listed", () => {
    const result = decodePagesManifest(
      JSON.stringify({
        schemaVersion: 1,
        pages: [{ slug: "a", entry: "a.tsx" }],
        requestedActivePage: "b",
      }),
    );
    expect(result).toBeInstanceOf(Error);
  });

  test("rejects an invalid slug, an absolute entry, a backslash entry and a `..` entry", () => {
    const bad = [
      { slug: "Dashboard", entry: "a.tsx" },
      { slug: "a", entry: "/etc/passwd" },
      { slug: "a", entry: "pages\\dashboard.tsx" },
      { slug: "a", entry: "../outside.tsx" },
      { slug: "a", entry: "" },
    ];
    for (const page of bad) {
      const result = decodePagesManifest(JSON.stringify({ schemaVersion: 1, pages: [page] }));
      expect(result).toBeInstanceOf(Error);
    }
  });

  test("rejects a non-object, invalid JSON, and an unknown top-level field", () => {
    expect(decodePagesManifest("[]")).toBeInstanceOf(Error);
    expect(decodePagesManifest("{")).toBeInstanceOf(Error);
    expect(
      decodePagesManifest(JSON.stringify({ schemaVersion: 1, pages: [], extra: 1 })),
    ).toBeInstanceOf(Error);
  });

  test("encode → decode round-trips and ends with a newline", () => {
    const manifest = decodePagesManifest(VALID);
    if (manifest instanceof Error) throw manifest;
    const text = encodePagesManifest(manifest);
    expect(text.endsWith("\n")).toBe(true);
    expect(decodePagesManifest(text)).toEqual(manifest);
  });
});
