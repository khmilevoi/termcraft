import { describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";

import {
  hostNonceSchema,
  isHostNonce,
  isSha256Hex,
  isUuidv7,
  sha256HexSchema,
  uuidv7Schema,
} from "./ids";

const VALID_SHA256 = "a".repeat(64);
const VALID_NONCE = "b".repeat(32);

describe("uuidv7", () => {
  test("accepts a freshly minted canonical UUIDv7", () => {
    expect(isUuidv7(uuidv7())).toBe(true);
  });

  test("rejects an uppercase or non-v7 uuid", () => {
    expect(isUuidv7(uuidv7().toUpperCase())).toBe(false);
    // version nibble 4, not 7
    expect(isUuidv7("017f22e2-79b0-4cc3-98c4-dc0c0c07398f")).toBe(false);
  });

  test("schema mirrors the guard", () => {
    expect(uuidv7Schema.safeParse(uuidv7()).success).toBe(true);
    expect(uuidv7Schema.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("sha256Hex", () => {
  test("accepts exactly 64 lowercase hex characters", () => {
    expect(isSha256Hex(VALID_SHA256)).toBe(true);
  });

  test("rejects wrong length, uppercase, or non-hex", () => {
    expect(isSha256Hex("a".repeat(63))).toBe(false);
    expect(isSha256Hex("a".repeat(65))).toBe(false);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(isSha256Hex("g".repeat(64))).toBe(false);
    expect(isSha256Hex("")).toBe(false);
  });

  test("schema mirrors the guard", () => {
    expect(sha256HexSchema.safeParse(VALID_SHA256).success).toBe(true);
    expect(sha256HexSchema.safeParse("A".repeat(64)).success).toBe(false);
  });
});

describe("hostNonce", () => {
  test("accepts exactly 32 lowercase hex characters", () => {
    expect(isHostNonce(VALID_NONCE)).toBe(true);
  });

  test("rejects a 64-character sha256 — the two id kinds are not interchangeable", () => {
    expect(isHostNonce(VALID_SHA256)).toBe(false);
  });

  test("rejects wrong length, uppercase, or non-hex", () => {
    expect(isHostNonce("b".repeat(31))).toBe(false);
    expect(isHostNonce("B".repeat(32))).toBe(false);
    expect(isHostNonce("z".repeat(32))).toBe(false);
  });

  test("schema mirrors the guard", () => {
    expect(hostNonceSchema.safeParse(VALID_NONCE).success).toBe(true);
    expect(hostNonceSchema.safeParse(VALID_SHA256).success).toBe(false);
  });
});
