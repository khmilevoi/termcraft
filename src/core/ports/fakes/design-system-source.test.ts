import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";
import { parseDesignSystemRef } from "entities/design-system-ref";

import type { DesignSystemSummaryV1 } from "../index";
import { createFakeDesignSystemSource } from "./design-system-source";

const MIDNIGHT: DesignSystemSummaryV1 = {
  id: "midnight",
  name: "Midnight",
  version: "1.2.0",
  kitApiVersion: 1,
  defaultTheme: "dark",
  defaultThemeTokens: [
    { name: "background", value: "#0b0f14" },
    { name: "accent", value: "#4cc9f0" },
  ],
  componentNames: ["Button", "PageShell"],
};

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "library unreadable",
  details: {},
};

function refOf(text: string) {
  const ref = parseDesignSystemRef(text);
  if (ref instanceof Error) throw ref;
  return ref;
}

describe("createFakeDesignSystemSource", () => {
  test("declares its identity and publish capability", () => {
    const source = createFakeDesignSystemSource({ id: "local", label: "Local", canPublish: true });
    expect(source.id).toBe("local");
    expect(source.label).toBe("Local");
    expect(source.canPublish).toBe(true);
  });

  test("lists what it was seeded with, and records the call", async () => {
    const source = createFakeDesignSystemSource({ id: "local", label: "Local", canPublish: true });
    source.seed(MIDNIGHT, [{ relPath: "design-system.json", bytes: new Uint8Array([1, 2]) }]);
    expect(await source.list()).toEqual([MIDNIGHT]);
    expect(source.calls).toEqual([{ method: "list" }]);
  });

  test("fetches a seeded package by reference", async () => {
    const source = createFakeDesignSystemSource({ id: "local", label: "Local", canPublish: true });
    const files = [{ relPath: "design-system.json", bytes: new Uint8Array([1, 2]) }];
    source.seed(MIDNIGHT, files);
    const fetched = await source.fetch(refOf("local:midnight@1.2.0"));
    expect("code" in fetched).toBe(false);
    if ("code" in fetched) return;
    expect(fetched.files).toEqual(files);
    expect(fetched.summary).toEqual(MIDNIGHT);
    expect(fetched.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fetching an unseeded reference is a failure, not an empty package", async () => {
    const source = createFakeDesignSystemSource({ id: "local", label: "Local", canPublish: true });
    const fetched = await source.fetch(refOf("local:midnight@1.2.0"));
    expect("code" in fetched).toBe(true);
  });

  test("publish seeds the package and returns a receipt at its address", async () => {
    const source = createFakeDesignSystemSource({ id: "local", label: "Local", canPublish: true });
    const receipt = await source.publish({
      systemId: refOf("local:aurora@2.0.0").systemId,
      version: refOf("local:aurora@2.0.0").version,
      files: [{ relPath: "design-system.json", bytes: new Uint8Array([3]) }],
    });
    expect("code" in receipt).toBe(false);
    if ("code" in receipt) return;
    expect(receipt.ref).toEqual(refOf("local:aurora@2.0.0"));
    expect(receipt.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("a source that cannot publish refuses rather than silently succeeding", async () => {
    const source = createFakeDesignSystemSource({ id: "ro", label: "RO", canPublish: false });
    const receipt = await source.publish({
      systemId: refOf("ro:aurora@2.0.0").systemId,
      version: refOf("ro:aurora@2.0.0").version,
      files: [],
    });
    expect("code" in receipt).toBe(true);
  });

  test("failNext injects one failure per queued entry, then returns to normal", async () => {
    const source = createFakeDesignSystemSource({ id: "local", label: "Local", canPublish: true });
    source.seed(MIDNIGHT, []);
    source.failNext("list", FAILURE);
    expect(await source.list()).toEqual(FAILURE);
    expect(await source.list()).toEqual([MIDNIGHT]);
  });
});
