import { describe, expect, test } from "bun:test";

import packageJson from "../../../../package.json" with { type: "json" };

import { TERMCRAFT_VERSION } from "./version";

describe("TERMCRAFT_VERSION", () => {
  test("equals package.json's own version, so the two cannot drift", () => {
    expect(TERMCRAFT_VERSION).toBe(packageJson.version);
  });
});
