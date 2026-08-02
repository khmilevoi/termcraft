import * as errore from "errore";

import type {
  AppendBaseV1,
  FileImageV1,
  ReadSetFileSnapshotV1,
  StagedTurnReadSetV1,
  TurnReadSetV1,
} from "core/ports";

/**
 * The 1:1 translation from the staging-time read set to the finalize-time one
 * (decision C6; `store/sandbox`'s own header says this translation "is the caller's job",
 * and the caller is the Kernel).
 *
 * Two shapes exist because the two moments ask different questions. Staging CAPTURES what
 * was on disk when the turn was admitted, so it uses `null` for "no such file" and a plain
 * array keyed by page. Finalization COMPARES that capture against disk under the
 * project-write mutex (turn-durability §7.5), so it wants an explicit `{state:"absent"}`
 * image and map lookup by slug.
 *
 * This function is the only place the two meet, which makes its two failure modes worth
 * naming:
 *
 * 1. A DROPPED ENTRY silently weakens the CAS — the drifted file is simply never compared,
 *    and apply proceeds over a change it was supposed to catch. So the translation is
 *    total: every array element becomes a map entry, and `null` becomes an explicit
 *    absent image rather than an omission. "I checked and it was absent" and "I never
 *    checked" must not collapse into the same value.
 * 2. A DUPLICATE SLUG is silently normalized by `new Map(pairs)`, which keeps the last
 *    occurrence and discards the rest. If the duplicates disagreed, the CAS would compare
 *    against whichever happened to be last; if they agreed, the input was already
 *    malformed. Either way it is returned as an error rather than smoothed over.
 */

/** The staged read set could not be translated without losing or inventing information. */
export class ReadSetTranslationError extends errore.createTaggedError({
  name: "ReadSetTranslationError",
  message: "cannot translate the staged read set: $reason",
}) {}

/** `null` (staging: no such file) becomes an explicit absent image (finalization). */
function toFileImage(snapshot: ReadSetFileSnapshotV1 | null): FileImageV1 {
  if (snapshot === null) return { state: "absent" };
  return { state: "file", sha256: snapshot.sha256, size: snapshot.size };
}

/**
 * Builds a map from keyed entries, refusing to silently collapse a duplicate key. Generic
 * over the key type: `designFiles` keys by TREE-relative `relPath` (a plain `string`, design
 * §7), `pins` still keys by `PageSlug` — one function, two call sites below, each inferring
 * its own key type from `keyOf`'s return type.
 */
function toMap<Entry, Key, Value>(
  entries: readonly Entry[],
  label: string,
  keyOf: (entry: Entry) => Key,
  valueOf: (entry: Entry) => Value,
): ReadSetTranslationError | ReadonlyMap<Key, Value> {
  const map = new Map<Key, Value>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (map.has(key)) {
      return new ReadSetTranslationError({ reason: `${label} lists "${key}" more than once` });
    }
    map.set(key, valueOf(entry));
  }
  return map;
}

/** Translates a staged read set into the shape the finalization CAS compares against. */
export function toFinalizeReadSet(
  staged: StagedTurnReadSetV1,
): ReadSetTranslationError | TurnReadSetV1 {
  const designFiles = toMap(
    staged.designFiles,
    "designFiles",
    (entry) => entry.relPath,
    (entry): FileImageV1 => toFileImage(entry.snapshot),
  );
  if (designFiles instanceof Error) return designFiles;

  const pins = toMap(
    staged.pins,
    "pins",
    (entry) => entry.pageSlug,
    (entry): AppendBaseV1 => ({ length: entry.base.length, prefixSha256: entry.base.prefixSha256 }),
  );
  if (pins instanceof Error) return pins;

  return {
    manifest: toFileImage(staged.manifest),
    designFiles,
    // Copied field by field rather than passed through by reference: the staged set came
    // from a port and nothing guarantees the caller stopped holding it.
    chat: { length: staged.chat.length, prefixSha256: staged.chat.prefixSha256 },
    pins,
  };
}
