import * as errore from "errore";

import type { DesignFileEntryV1, DesignTreeInventoryV1 } from "../types";

/**
 * Two entries claim the same tree-relative path. Refused rather than normalized: `new Map`
 * would keep the last one and silently pick a hash, and the whole point of the inventory is
 * that a tree-relative path names exactly one byte image.
 */
export class DuplicateInventoryPathError extends errore.createTaggedError({
  name: "DuplicateInventoryPathError",
  message: "the design tree inventory lists $relPath more than once",
}) {}

/**
 * Build the canonical inventory: sorted by `relPath`, duplicate-free. Sorting here rather
 * than at each hash site is what makes `computeTreeRevision` independent of enumeration
 * order — a directory walk's order is a filesystem detail, and a revision that changed with
 * it would invalidate every cache on an unrelated machine.
 */
export function createDesignTreeInventory(
  files: readonly DesignFileEntryV1[],
): DuplicateInventoryPathError | DesignTreeInventoryV1 {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.relPath)) return new DuplicateInventoryPathError({ relPath: file.relPath });
    seen.add(file.relPath);
  }
  const sorted = [...files].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  return { files: sorted };
}

/** A membership predicate over the inventory, in the shape `resolveDesignSpecifier` asks for. */
export function inventoryHas(inventory: DesignTreeInventoryV1): (relPath: string) => boolean {
  const set = new Set(inventory.files.map((file) => file.relPath));
  return (relPath) => set.has(relPath);
}

/** A hash lookup over the inventory; `null` for a path the inventory does not carry. */
export function inventorySha256(
  inventory: DesignTreeInventoryV1,
): (relPath: string) => string | null {
  const map = new Map(inventory.files.map((file) => [file.relPath, file.sha256]));
  return (relPath) => map.get(relPath) ?? null;
}
