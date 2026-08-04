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

describe("MIGRATION_CHAIN (design-tree §12.3: the first shipped migration)", () => {
  test("the shipped chain is exactly the project.toml 1 -> 2 step", () => {
    expect(MIGRATION_CHAIN).toEqual([
      { kind: "project.toml", fromVersion: 1, toVersion: 2 },
    ]);
  });

  test("the live default registry wires that same chain", () => {
    expect(migrationRegistry.chain).toEqual(MIGRATION_CHAIN);
  });

  test("the live registry resolves a real path from 1 to 2", () => {
    const steps = migrationRegistry.findSteps({
      kind: "project.toml",
      fromVersion: 1,
      toVersion: 2,
    });
    expect(steps).not.toBeInstanceOf(Error);
    expect(steps).toHaveLength(1);
  });

  test("the live registry still refuses a kind it has no step for", () => {
    expect(
      migrationRegistry.findSteps({ kind: "chat-jsonl", fromVersion: 1, toVersion: 2 }),
    ).toBeInstanceOf(NoMigrationPathError);
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

  test("any other request against the shipped chain has no path if not in the chain", () => {
    const result = findMigrationSteps({ kind: "unknown-kind", fromVersion: 1, toVersion: 2 });
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
    expect(MIGRATION_CHAIN).toEqual([
      { kind: "project.toml", fromVersion: 1, toVersion: 2 },
    ]); // the shipped constant is untouched by the synthetic chain
  });

  test("a broken synthetic chain (missing intermediate step) has no path", () => {
    const chain: readonly MigrationStep[] = [{ kind: "widget", fromVersion: 1, toVersion: 2 }];
    const result = findMigrationSteps({ kind: "widget", fromVersion: 1, toVersion: 3, chain });
    expect(result).toBeInstanceOf(NoMigrationPathError);
  });
});

describe("createMigrationRegistry", () => {
  test("defaults to the shipped chain", () => {
    const registry = createMigrationRegistry();
    expect(registry.chain).toEqual(MIGRATION_CHAIN);
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
