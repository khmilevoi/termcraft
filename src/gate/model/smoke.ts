import type { DesignFileEntryV1 } from "entities/design-tree";

import type { SmokeRenderer, SmokeRequest } from "../ports/smoke-renderer";
import { smokeResultToErrors } from "../ports/smoke-renderer";
import type { GateError, PageDescriptor } from "../types";

/**
 * The lowercase-hex SHA-256 the host's `computeSourceHash` computes over the same
 * staged file's bytes (`src/host/session/model/source-mount.ts:42-44`). Computed
 * locally — never by importing `host` (module DAG: the dependency points from host
 * to the gate's `SmokeRenderer` port, never the reverse) — over the exact UTF-8
 * bytes `TextEncoder` produces for `source`, which is what a UTF-8-written staged
 * file's bytes are. Parity with the host's hash is pinned by a dedicated test that
 * uses the host helper only as a test-only oracle (never called from here).
 */
function hashSource(source: string): string {
  return new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(source)).digest("hex");
}

/**
 * The tree coordinates one smoke render mounts from (design §6, §9.2) — closed over by
 * {@link createSmokeRender} exactly the way the single staged `sourcePath` used to be.
 *
 * WHY ALL THREE, and why they come from the caller. A candidate page is its whole closure now,
 * so a smoke render that mounted only the entry would pass a page whose shared module throws on
 * import. The host derives the closure itself and hash-verifies every member against
 * `expectedFiles`, which is the STAGED candidate's own inventory — the caller
 * (`core/turns/model/validation.ts`) holds it because `StagingService.snapshotToCandidate`
 * returned it, so nothing here re-reads or re-hashes a disk this module never staged.
 */
export interface SmokeTreeContextV1 {
  /** The ABSOLUTE `…/design` directory of the staged candidate tree. */
  readonly treeRoot: string;
  /** The staged candidate tree's inventory: `(relPath, sha256)` for every file under `treeRoot`. */
  readonly expectedFiles: readonly DesignFileEntryV1[];
}

/**
 * Build the gate's `smokeRender` port (phase-3 T6, host-supervision §11.3) from an
 * injected `SmokeRenderer`. Mirrors `createTypeChecker`'s factory shape
 * (`type-check.ts:242-253`): close over the renderer + the candidate's staged tree
 * coordinates, and return the plain port function `runGate` calls. Per call:
 * compute the source hash, assemble the `SmokeRequest` from the parsed
 * descriptor's `meta` (`size` is the candidate's declared minimum — §11.3 smoke-
 * renders at the minimum, never a larger size), render once, and map the typed
 * result through `smokeResultToErrors`.
 *
 * `entryRelPath` is per-call rather than closed over because one `runGate` invocation validates
 * one page and the entry is that page's own manifest binding — never derived from its slug.
 */
export function createSmokeRender(
  renderer: SmokeRenderer,
  context: SmokeTreeContextV1,
  entryRelPath: string,
): (descriptor: PageDescriptor, source: string) => Promise<GateError[]> {
  return async (descriptor, source) => {
    const request: SmokeRequest = {
      treeRoot: context.treeRoot,
      entryRelPath,
      expectedFiles: context.expectedFiles,
      sourceHash: hashSource(source),
      size: descriptor.meta.minSize,
      kitApiVersion: descriptor.meta.kitApiVersion,
    };
    const result = await renderer.render(request);
    return smokeResultToErrors(result);
  };
}
