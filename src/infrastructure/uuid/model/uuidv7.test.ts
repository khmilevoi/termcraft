import { describe, expect, test } from "bun:test";

import { isCanonicalUuidv7, uuidv7 } from "./uuidv7";

const UUID_V7_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  test("produces canonical lowercase v7 ids", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(uuidv7()).toMatch(UUID_V7_SHAPE);
    }
  });

  test("ids generated in sequence sort in generation order", () => {
    const ids = Array.from({ length: 100 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
  });

  test("ids are unique", () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("isCanonicalUuidv7", () => {
  test("accepts freshly minted ids", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isCanonicalUuidv7(uuidv7())).toBe(true);
    }
  });

  test("rejects the wrong version, variant, case, and shape", () => {
    expect(isCanonicalUuidv7("0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10")).toBe(true);
    expect(isCanonicalUuidv7("0190fc4a-8b5c-4d3e-8a91-6f2e4c7b5d10")).toBe(false); // v4, not v7
    expect(isCanonicalUuidv7("0190fc4a-8b5c-7d3e-0a91-6f2e4c7b5d10")).toBe(false); // variant 0
    expect(isCanonicalUuidv7("0190FC4A-8B5C-7D3E-8A91-6F2E4C7B5D10")).toBe(false); // uppercase
    expect(isCanonicalUuidv7("0190fc4a8b5c7d3e8a916f2e4c7b5d10")).toBe(false); // no hyphens
    expect(isCanonicalUuidv7("")).toBe(false);
  });
});
