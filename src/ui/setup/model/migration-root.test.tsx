import { describe, expect, test } from "bun:test";

import { migrationChoiceForKey } from "./migration-root";

const key = (over: { name?: string; ctrl?: boolean }) => ({
  name: over.name ?? "",
  ctrl: over.ctrl ?? false,
});

describe("migrationChoiceForKey (design §12.1's `⏎ migrate` / `esc later`)", () => {
  test("enter confirms", () => {
    expect(migrationChoiceForKey(key({ name: "return" }))).toBe("migrate");
  });

  test("escape declines", () => {
    expect(migrationChoiceForKey(key({ name: "escape" }))).toBe("later");
  });

  test("ctrl-c declines rather than confirming", () => {
    expect(migrationChoiceForKey(key({ name: "c", ctrl: true }))).toBe("later");
  });

  test("a bare c is not ctrl-c", () => {
    expect(migrationChoiceForKey(key({ name: "c" }))).toBeNull();
  });

  test("every other key is ignored", () => {
    for (const name of ["a", "space", "up", "tab", "y", "n"])
      expect(migrationChoiceForKey(key({ name }))).toBeNull();
  });
});
