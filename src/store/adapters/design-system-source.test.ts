import { describe, expect, test } from "bun:test";

import { parseDesignSystemRef } from "entities/design-system-ref";
import type { DesignSystemSource as StoreDesignSystemSource } from "store/design-systems";
import {
  DesignSystemPackageInvalidError,
  DesignSystemPackageTooLargeError,
} from "store/design-systems";

import { createDesignSystemSourceAdapter } from "./design-system-source";

const SUMMARY = {
  id: "midnight",
  name: "Midnight",
  version: "1.2.0",
  kitApiVersion: 1,
  defaultTheme: "dark",
  defaultThemeTokens: [{ name: "accent", value: "#4cc9f0" }],
  componentNames: ["Button"],
};

function refOf(text: string) {
  const ref = parseDesignSystemRef(text);
  if (ref instanceof Error) throw ref;
  return ref;
}

function stubSource(overrides: Partial<StoreDesignSystemSource>): StoreDesignSystemSource {
  return {
    id: "local" as never,
    label: "Local library",
    canPublish: true,
    list: async () => [SUMMARY],
    fetch: async (ref) => ({
      ref,
      contentHash: "a".repeat(64),
      files: [],
      summary: SUMMARY,
    }),
    publish: async () => ({
      ref: refOf("local:midnight@1.2.0"),
      contentHash: "a".repeat(64),
      publishedAt: "2026-08-11T10:00:00.000Z",
    }),
    ...overrides,
  };
}

describe("createDesignSystemSourceAdapter", () => {
  test("passes identity, label and publish capability straight through", () => {
    const adapted = createDesignSystemSourceAdapter(stubSource({}));
    expect(adapted.id).toBe("local");
    expect(adapted.label).toBe("Local library");
    expect(adapted.canPublish).toBe(true);
  });

  test("passes successful results through unchanged", async () => {
    const adapted = createDesignSystemSourceAdapter(stubSource({}));
    expect(await adapted.list()).toEqual([SUMMARY]);
    const fetched = await adapted.fetch(refOf("local:midnight@1.2.0"));
    expect("code" in fetched).toBe(false);
  });

  test("maps an admission refusal to RESOURCE_LIMIT_EXCEEDED", async () => {
    const adapted = createDesignSystemSourceAdapter(
      stubSource({
        fetch: async () =>
          new DesignSystemPackageTooLargeError({ path: "a.tsx", detail: "too big" }),
      }),
    );
    const fetched = await adapted.fetch(refOf("local:midnight@1.2.0"));
    expect("code" in fetched).toBe(true);
    if (!("code" in fetched)) return;
    expect(fetched.code).toBe("RESOURCE_LIMIT_EXCEEDED");
  });

  test("maps every other source failure to PERSISTENCE_FAILED", async () => {
    const adapted = createDesignSystemSourceAdapter(
      stubSource({
        list: async () => new DesignSystemPackageInvalidError({ path: "m", reason: "bad" }),
      }),
    );
    const listed = await adapted.list();
    expect("code" in listed).toBe(true);
    if (!("code" in listed)) return;
    expect(listed.code).toBe("PERSISTENCE_FAILED");
    expect(listed.retryable).toBe(false);
    expect(listed.safeMessage.length).toBeGreaterThan(0);
  });
});
