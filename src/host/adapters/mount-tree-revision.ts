import { computeTreeRevision, createDesignTreeInventory } from "entities/design-tree";
import type { DesignFileEntryV1 } from "entities/design-tree";

import { SupervisorError } from "../supervisor";

/**
 * `HostSessionSpec.treeRevision` for the two ONE-SHOT adapters — smoke and export — whose own
 * port requests (`gate`'s `SmokeRequest`, `core/ports`'s `ExportRenderTaskV1`) carry an
 * inventory but no revision (design-tree phase 2 Task 10).
 *
 * WHY DERIVED HERE AND NOT THREADED THROUGH THOSE PORTS. The preview path takes its revision
 * from `core`'s own `readCanonicalTreeIndex` and threads it down the spec, because there it is
 * the SESSION KEY and must be the very value `core` keyed on. A one-shot mount has no session to
 * key: it spawns, seals one frame and exits, so nothing downstream compares its revision to
 * anything. What the field must still be is TRUE, and it is: `expectedFiles` IS the inventory
 * this mount verifies its bytes against, and {@link computeTreeRevision} over it is by
 * definition that tree's revision. Threading it instead would mean widening `runPage`'s own Gate
 * port and every one of its callers to carry a value only the host would read.
 *
 * `createDesignTreeInventory` — not a bare `{ files }` — because `computeTreeRevision` folds in
 * ARRAY ORDER without sorting: a caller handing over a differently ordered list would otherwise
 * get a different digest for the identical tree. It also REFUSES a duplicate `relPath`, which is
 * propagated rather than folded: picking one of two byte images silently is how a hash comes to
 * describe bytes nobody has (`entities/design-tree`'s own `DuplicateInventoryPathError`).
 *
 * `SPAWN_FAILED` is the honest code for that refusal — the incarnation cannot begin, which is
 * exactly what `host-supervisor.ts`'s `toHostFailureDto` maps that code onto (`HOST_START_FAILED`,
 * "a failure to even begin an incarnation").
 */
export function resolveMountTreeRevision(
  expectedFiles: readonly DesignFileEntryV1[],
): SupervisorError | string {
  const inventory = createDesignTreeInventory(expectedFiles);
  if (inventory instanceof Error) {
    return new SupervisorError({
      code: "SPAWN_FAILED",
      // `String(...)` narrows the tagged error's `string | number` interpolation variable; the
      // value is a `relPath` this function itself handed in, so nothing unknown is coerced.
      reason: `the mount inventory lists "${String(inventory.relPath)}" more than once, so this tree has no single revision`,
      cause: inventory,
    });
  }
  return computeTreeRevision(inventory);
}
