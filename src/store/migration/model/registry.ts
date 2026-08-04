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
// 2. The migration chain itself (design-tree §12.3): the LIVE infrastructure holding one or more
//    registered steps for any shipped migration. `findMigrationSteps` is the real lookup a
//    migration caller walks, wired against `MIGRATION_CHAIN` directly. As of the multi-file
//    design tree, one step lives here: the portable manifest's format 1 -> 2 migration
//    (the flat `pages/<slug>/page.tsx` layout becoming the `design/` tree). Landing a future
//    migration means appending an entry to `MIGRATION_CHAIN`, never inventing a second
//    lookup mechanism. Each `MigrationStep` is a DECLARATION (not a transform) — it says
//    a path exists between two versions of one artifact family; `model/v1-to-v2.ts` holds
//    the planner, and `store/model/factory.ts`'s `migrateProject` drives the transform.

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
 * The `kind` naming `project.toml`'s own format counter. A `MigrationStep`'s `kind` is a plain
 * string (see `types.ts`), so the one place the literal lives is here.
 */
export const PROJECT_TOML_MIGRATION_KIND = "project.toml";

/**
 * THE SHIPPED MIGRATION CHAIN. One step as of the multi-file design tree (design §12.3): the
 * portable manifest's format 1 -> 2, i.e. the flat `pages/<slug>/page.tsx` layout with an ordered
 * `pages` array in `project.toml` becoming the `design/` tree with `design/pages.json`.
 *
 * A `MigrationStep` is a DECLARATION, not a transform: it says a path exists between two versions
 * of one artifact family, and `findMigrationSteps` walks it. The transform itself is
 * `model/v1-to-v2.ts` plus `store/model/factory.ts`'s `migrateProject` driver. Appending a future
 * migration means editing this literal, not calling a `register()` function at runtime.
 */
export const MIGRATION_CHAIN: readonly MigrationStep[] = [
  { kind: PROJECT_TOML_MIGRATION_KIND, fromVersion: 1, toVersion: 2 },
];

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

/** Build a {@link MigrationRegistry} over `chain` (defaults to the shipped {@link MIGRATION_CHAIN} with one step: `project.toml` 1 → 2). */
export function createMigrationRegistry(
  chain: readonly MigrationStep[] = MIGRATION_CHAIN,
): MigrationRegistry {
  return {
    chain,
    findSteps: (input) => findMigrationSteps({ ...input, chain }),
    checkNotTooNew: checkFormatCounter,
  };
}

/** THE live, shipped registry: one `project.toml` 1 → 2 step in the chain, wired through the real gate. */
export const migrationRegistry: MigrationRegistry = createMigrationRegistry();
