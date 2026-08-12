import { createLimitBudget } from "store/safe-fs";

import type { PackageAdmission } from "../types";

/**
 * The REAL package budget (design §8.3, §13: "safe-fs limits sit between `fetch` and the
 * candidate"). P3 declared `PackageAdmission` REQUIRED and defaultless precisely so this could
 * not be forgotten; this is the function that satisfies it in production.
 *
 * `createLimitBudget("candidate")` is the root row an install's bytes are admitted under, and the
 * namespace is pinned to `"design-source"` — the one namespace a design system's files can ever
 * occupy (512 files, 64 MiB aggregate, depth 8, 2 MiB per file). `PackageAdmission` deliberately
 * carries no namespace, so it is supplied here rather than asked of every caller.
 *
 * A FRESH BUDGET PER CALL, never a module-level singleton: the aggregate counters are stateful,
 * and a shared instance would make the second fetch in one session fail because of the first.
 *
 * `observeBytes` maps `bytesRead` onto `LimitBudget`'s `bytesSoFar`. The two names differ because
 * `store/design-systems` reads whole files at once while `store/safe-fs` streams chunks; for a
 * whole-file read the running total IS the file's length, so the mapping is exact.
 */
export function createDesignSourceAdmission(): PackageAdmission {
  const budget = createLimitBudget("candidate");
  return {
    admitFile(input) {
      return budget.admitFile({
        relPath: input.relPath,
        namespace: "design-source",
        declaredSize: input.declaredSize,
        depth: input.depth,
      });
    },
    observeBytes(input) {
      return budget.observeBytes({
        relPath: input.relPath,
        namespace: "design-source",
        bytesSoFar: input.bytesRead,
      });
    },
  };
}
