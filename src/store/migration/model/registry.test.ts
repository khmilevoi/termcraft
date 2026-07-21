import { describe, expect, test } from "bun:test";

import type { MigrationStep } from "../types";
import {
  DataFormatTooNewError,
  MIGRATION_CHAIN,
  NoMigrationPathError,
  checkFormatCounter,
  createMigrationRegistry,
  findMigrationSteps,
  migrationRegistry,
  readFormatCounter,
} from "./registry";

describe("MIGRATION_CHAIN (storage-identity §12: no shipped migration exists)", () => {
  test("the shipped chain is empty", () => {
    expect(MIGRATION_CHAIN).toEqual([]);
  });

  test("the live default registry wires the same empty chain", () => {
    expect(migrationRegistry.chain).toEqual([]);
  });
});

describe("readFormatCounter", () => {
  test("reads each of the three §12 counter fields", () => {
    expect(readFormatCounter("format_version", { format_version: 1 })).toBe(1);
    expect(readFormatCounter("formatVersion", { formatVersion: 2 })).toBe(2);
    expect(readFormatCounter("schemaVersion", { schemaVersion: 3 })).toBe(3);
  });

  test("returns null for a missing or non-integer counter", () => {
    expect(readFormatCounter("format_version", {})).toBeNull();
    expect(readFormatCounter("format_version", { format_version: "1" })).toBeNull();
    expect(readFormatCounter("format_version", { format_version: 1.5 })).toBeNull();
  });

  test("returns null for a non-object value", () => {
    expect(readFormatCounter("format_version", null)).toBeNull();
    expect(readFormatCounter("format_version", [1])).toBeNull();
    expect(readFormatCounter("format_version", "nope")).toBeNull();
  });
});

describe("checkFormatCounter", () => {
  test("found <= supported passes", () => {
    expect(
      checkFormatCounter({ file: "project.toml", field: "format_version", found: 1, supported: 1 }),
    ).toBeNull();
    expect(
      checkFormatCounter({ file: "project.toml", field: "format_version", found: 0, supported: 1 }),
    ).toBeNull();
  });

  test("found > supported is a hard error naming the file", () => {
    const result = checkFormatCounter({
      file: "project.toml",
      field: "format_version",
      found: 2,
      supported: 1,
    });
    expect(result).toBeInstanceOf(DataFormatTooNewError);
    if (!(result instanceof DataFormatTooNewError))
      throw new Error("expected DataFormatTooNewError");
    expect(result.file).toBe("project.toml");
    expect(result.field).toBe("format_version");
    expect(result.found).toBe(2);
    expect(result.supported).toBe(1);
    expect(result.message).toContain("project.toml");
  });
});

describe("findMigrationSteps", () => {
  test("fromVersion === toVersion is always the empty no-op path, even against an empty chain", () => {
    const result = findMigrationSteps({ kind: "project.toml", fromVersion: 1, toVersion: 1 });
    expect(result).toEqual([]);
  });

  test("any other request against the shipped empty chain has no path", () => {
    const result = findMigrationSteps({ kind: "project.toml", fromVersion: 1, toVersion: 2 });
    expect(result).toBeInstanceOf(NoMigrationPathError);
  });

  test("walks a synthetic multi-step chain in order, without ever touching the shipped MIGRATION_CHAIN", () => {
    const chain: readonly MigrationStep[] = [
      { kind: "widget", fromVersion: 1, toVersion: 2 },
      { kind: "widget", fromVersion: 2, toVersion: 3 },
      { kind: "other-kind", fromVersion: 1, toVersion: 2 }, // a different kind must never be picked up
    ];
    const result = findMigrationSteps({ kind: "widget", fromVersion: 1, toVersion: 3, chain });
    expect(result).toEqual([
      { kind: "widget", fromVersion: 1, toVersion: 2 },
      { kind: "widget", fromVersion: 2, toVersion: 3 },
    ]);
    expect(MIGRATION_CHAIN).toEqual([]); // the shipped constant is untouched by the synthetic chain
  });

  test("a broken synthetic chain (missing intermediate step) has no path", () => {
    const chain: readonly MigrationStep[] = [{ kind: "widget", fromVersion: 1, toVersion: 2 }];
    const result = findMigrationSteps({ kind: "widget", fromVersion: 1, toVersion: 3, chain });
    expect(result).toBeInstanceOf(NoMigrationPathError);
  });
});

describe("createMigrationRegistry", () => {
  test("defaults to the shipped empty chain", () => {
    const registry = createMigrationRegistry();
    expect(registry.chain).toEqual([]);
    expect(registry.findSteps({ kind: "project.toml", fromVersion: 1, toVersion: 1 })).toEqual([]);
  });

  test("wires findSteps and checkNotTooNew over an injected chain", () => {
    const chain: readonly MigrationStep[] = [{ kind: "widget", fromVersion: 1, toVersion: 2 }];
    const registry = createMigrationRegistry(chain);
    expect(registry.findSteps({ kind: "widget", fromVersion: 1, toVersion: 2 })).toEqual(chain);
    expect(
      registry.checkNotTooNew({
        file: "widget.json",
        field: "schemaVersion",
        found: 3,
        supported: 2,
      }),
    ).toBeInstanceOf(DataFormatTooNewError);
    expect(
      registry.checkNotTooNew({
        file: "widget.json",
        field: "schemaVersion",
        found: 2,
        supported: 2,
      }),
    ).toBeNull();
  });
});
