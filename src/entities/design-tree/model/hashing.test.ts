import { describe, expect, test } from "bun:test";

import { computeSourceHash } from "./hashing";

describe("computeSourceHash", () => {
  test("digests the empty input to the canonical lowercase hex value", () => {
    expect(computeSourceHash(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("digests a known vector to its published SHA-256", () => {
    expect(computeSourceHash(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("is a pure function of the bytes: identical content hashes identically, different content does not", () => {
    const a = computeSourceHash(new TextEncoder().encode("same"));
    const b = computeSourceHash(new TextEncoder().encode("same"));
    const c = computeSourceHash(new TextEncoder().encode("different"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
