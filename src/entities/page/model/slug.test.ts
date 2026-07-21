import { describe, expect, test } from "bun:test";

import type { PageSlug } from "../types";
import { InvalidPageSlugError, parsePageSlug } from "./slug";

describe("parsePageSlug", () => {
  test.each(["dashboard", "a", "0", "page-2", "a".repeat(32), "console"])("accepts %j", (raw) => {
    // `.toBe` is typed to the actual's `InvalidPageSlugError | PageSlug`;
    // a plain string is not assignable to the branded PageSlug, so the
    // expected side is cast — at runtime the value IS the input string.
    expect(parsePageSlug(raw)).toBe(raw as PageSlug);
  });

  test.each([
    "",
    "-leading-dash",
    "Upper",
    "under_score",
    "a".repeat(33),
    "с-кириллицей",
    "dot.name",
  ])("rejects %j by mask", (raw) => {
    const result = parsePageSlug(raw);
    expect(result).toBeInstanceOf(InvalidPageSlugError);
    if (result instanceof InvalidPageSlugError) {
      expect(result.slug).toBe(raw);
      expect(result.reason).toContain("mask");
    }
  });

  test.each(["con", "nul", "aux", "prn", "com1", "com5", "com9", "lpt1", "lpt4", "lpt9"])(
    "rejects Windows device name %j",
    (raw) => {
      const result = parsePageSlug(raw);
      expect(result).toBeInstanceOf(InvalidPageSlugError);
      if (result instanceof InvalidPageSlugError) {
        expect(result.reason).toContain("Windows");
      }
    },
  );

  test("com0 and lpt0 are not reserved", () => {
    expect(parsePageSlug("com0")).toBe("com0" as PageSlug);
    expect(parsePageSlug("lpt0")).toBe("lpt0" as PageSlug);
  });
});
