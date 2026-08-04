import { describe, expect, test } from "bun:test";

import { computeTreeRevision, createDesignTreeInventory } from "entities/design-tree";

import { SupervisorError } from "../supervisor";
import { resolveMountTreeRevision } from "./mount-tree-revision";

const A = { relPath: "pages/home.tsx", sha256: "a".repeat(64) };
const B = { relPath: "shared/labels.ts", sha256: "b".repeat(64) };

describe("resolveMountTreeRevision (design-tree phase 2 Task 10)", () => {
  test("is the canonical treeRevision of the inventory it is given", () => {
    const canonical = createDesignTreeInventory([A, B]);
    if (canonical instanceof Error) throw canonical;
    expect(resolveMountTreeRevision([A, B])).toBe(computeTreeRevision(canonical));
  });

  /**
   * `computeTreeRevision` folds in ARRAY order without sorting, so a helper that handed its
   * input straight through would answer differently for the same tree read in a different
   * order — the exact "filesystem-enumeration artifact rather than an identity" this project's
   * `createDesignTreeInventory` exists to prevent.
   */
  test("does not depend on the order the caller listed the files in", () => {
    expect(resolveMountTreeRevision([B, A])).toBe(resolveMountTreeRevision([A, B]));
  });

  test("distinguishes two trees that differ only in a NON-entry file", () => {
    const edited = { ...B, sha256: "c".repeat(64) };
    expect(resolveMountTreeRevision([A, edited])).not.toBe(resolveMountTreeRevision([A, B]));
  });

  /**
   * Refused, never folded: keeping one of two byte images for the same path would make the
   * revision describe bytes nobody has. `SPAWN_FAILED` because the incarnation cannot begin —
   * the code `host-supervisor.ts`'s `toHostFailureDto` maps onto `HOST_START_FAILED`.
   */
  test("refuses a duplicate tree-relative path rather than picking one of its two hashes", () => {
    const result = resolveMountTreeRevision([A, { ...A, sha256: "d".repeat(64) }]);
    expect(result).toBeInstanceOf(SupervisorError);
    if (!(result instanceof SupervisorError)) throw new Error("expected a SupervisorError");
    expect(result.code).toBe("SPAWN_FAILED");
    expect(result.message).toContain("pages/home.tsx");
  });
});
