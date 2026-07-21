import * as errore from "errore";

import type { FormatCounterField, MigrationRegistry, MigrationStep } from "../types";

// storage-identity §12's migration-safety gate, in two independent pieces:
//
// 1. The format-counter "too new" check every durable-file kind shares. `project.toml`
//    and `workspace.local.toml` use `format_version`; JSONL uses its typed header's
//    `formatVersion`; every other JSON uses `schemaVersion` — three field names, one
//    rule: "A newer-than-supported data format is a hard error naming the file, and
//    data-format downgrades are unsupported." `store/toml` and `store/transaction`
//    already apply this rule locally to their own one file kind (`ManifestTooNewError`,
//    `JournalTooNewError`); this module is the generic, reusable form a future migration
//    caller (or a not-yet-landed durable-JSON kind) can share instead of re-deriving it.
//
// 2. The migration chain itself. §12: "This repository is pre-code. ... The first
//    implementation adopts this document directly as format version 1. No migration or
//    compatibility reader for an abandoned version is created." `MIGRATION_CHAIN` is
//    therefore EMPTY — but it is still LIVE infrastructure: `findMigrationSteps` is the
//    real lookup a future migration caller (phase 6) would walk, wired against this
//    exact array. Landing a migration means appending an entry here, never inventing a
//    second lookup mechanism. `registry.test.ts` asserts the shipped chain stays empty —
//    that assertion IS this phase's proof that no production migration exists
//    (turn-durability §14.8).

/**
 * A durable file declares a format counter newer than this binary supports
 * (storage-identity §12: "A newer-than-supported data format is a hard error naming the
 * file, and data-format downgrades are unsupported."). `file` always names the artifact,
 * per §12's requirement that the hard error name the file.
 */
export class DataFormatTooNewError extends errore.createTaggedError({
  name: "DataFormatTooNewError",
  message: "$file declares $field $found, newer than the supported version $supported",
}) {}

/**
 * Read `field` off an already-parsed value WITHOUT validating the rest of its shape —
 * mirrors `store/toml`'s `readFormatVersion` and `store/transaction`'s
 * `readJournalVersion`, generalized across the three counter field names §12 names.
 * Returns `null` for a missing or non-integer counter, which the caller treats as its
 * own shape error, never as "version 0" (the version gate must run before the field
 * schema, exactly as those two existing decoders already do).
 */
export function readFormatCounter(field: FormatCounterField, value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const found = (value as Record<string, unknown>)[field];
  if (typeof found !== "number" || !Number.isInteger(found)) return null;
  return found;
}

/** The hard §12 gate: `found > supported` is always {@link DataFormatTooNewError}, never a shape complaint. */
export function checkFormatCounter(input: {
  readonly file: string;
  readonly field: FormatCounterField;
  readonly found: number;
  readonly supported: number;
}): DataFormatTooNewError | null {
  if (input.found > input.supported) return new DataFormatTooNewError(input);
  return null;
}

// ---- the migration chain (storage-identity §12) ---------------------------------------

/**
 * THE SHIPPED MIGRATION CHAIN. Empty by design (storage-identity §12) and MUST stay
 * empty until a real migration ships — `registry.test.ts` asserts this array's length
 * directly. Not exported as mutable: appending a migration means editing this literal,
 * not calling a `register()` function at runtime.
 */
export const MIGRATION_CHAIN: readonly MigrationStep[] = [];

/** No registered step walks `kind` from `fromVersion` to `toVersion` in the given chain. */
export class NoMigrationPathError extends errore.createTaggedError({
  name: "NoMigrationPathError",
  message: "no registered migration for $kind from format $fromVersion to $toVersion",
}) {}

/**
 * Resolve the ordered steps from `fromVersion` to `toVersion` for `kind`, walking
 * `chain` (defaults to the shipped {@link MIGRATION_CHAIN}). `fromVersion === toVersion`
 * is always the empty no-op path, even against an empty chain — reading an
 * already-current file needs no migration. `chain` is an explicit parameter, not always
 * the module constant, so a test can prove the walk itself against a synthetic chain
 * without ever populating the shipped one.
 */
export function findMigrationSteps(input: {
  readonly kind: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly chain?: readonly MigrationStep[];
}): NoMigrationPathError | readonly MigrationStep[] {
  const chain = input.chain ?? MIGRATION_CHAIN;
  if (input.fromVersion === input.toVersion) return [];

  const steps: MigrationStep[] = [];
  let cursor = input.fromVersion;
  while (cursor !== input.toVersion) {
    const next = chain.find((step) => step.kind === input.kind && step.fromVersion === cursor);
    if (next === undefined) {
      return new NoMigrationPathError({
        kind: input.kind,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
      });
    }
    steps.push(next);
    cursor = next.toVersion;
  }
  return steps;
}

/** Build a {@link MigrationRegistry} over `chain` (defaults to the shipped, empty {@link MIGRATION_CHAIN}). */
export function createMigrationRegistry(
  chain: readonly MigrationStep[] = MIGRATION_CHAIN,
): MigrationRegistry {
  return {
    chain,
    findSteps: (input) => findMigrationSteps({ ...input, chain }),
    checkNotTooNew: checkFormatCounter,
  };
}

/** THE live, shipped registry: an empty chain, wired through the real gate. */
export const migrationRegistry: MigrationRegistry = createMigrationRegistry();
