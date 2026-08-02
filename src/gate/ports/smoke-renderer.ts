import type { DesignFileEntryV1 } from "entities/design-tree";
import type { Size } from "entities/page";

import type { GateError } from "../types";

/**
 * One smoke-render request the gate makes for a candidate (host-supervision §11.3).
 * The host mounts the exact candidate bytes once at the declared minimum size,
 * seals one full frame + geometry, reports metadata + runtime warnings, and exits.
 *
 * `treeRoot`/`entryRelPath`/`expectedFiles` REPLACED a single `sourcePath` in task 15 (design
 * §6, §9.2). A candidate page spans its whole closure, and a smoke render that mounted only the
 * entry would prove nothing about the page the user will actually see: the shared module it
 * imports is what would fail. `sourceHash` stays the ENTRY's own hash — the smoke session's
 * identity, not a verification input.
 */
export interface SmokeRequest {
  /** The ABSOLUTE `…/design` directory of the STAGED candidate tree. */
  readonly treeRoot: string;
  /** TREE-relative — the `entry` the candidate's own `pages.json` binds to this page. */
  readonly entryRelPath: string;
  /** The staged candidate tree's inventory: `(relPath, sha256)` for every file under `treeRoot`. */
  readonly expectedFiles: readonly DesignFileEntryV1[];
  readonly sourceHash: string;
  /** The candidate's `meta.minSize` — smoke renders at the declared minimum (§11.3). */
  readonly size: Size;
  readonly kitApiVersion: number;
}

/**
 * The typed outcome of a smoke render (§11.3). Success means the host sealed one
 * frame and exited cleanly; a failure names the candidate's compile/import/contract/
 * duplicate-id/mount/render fault with a stable code + bounded plain-text message.
 */
export type SmokeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * The gate-facing smoke-render port (code-structure §5). The gate DECLARES it; the
 * `host` implements it via the 2D-4 one-shot smoke session (`runOneShotSession`),
 * and the composition root injects the adapter. Kept here so the gate never imports
 * `host` — the dependency points from host to this port, not the reverse.
 */
export interface SmokeRenderer {
  render(request: SmokeRequest): Promise<SmokeResult>;
}

/**
 * Map a smoke result to the gate's fatal errors (§11.3): a clean render adds none;
 * a failure is one `smoke`-kind `GateError` naming the candidate's fault. It does
 * NOT trigger a preview fallback and cannot alter a canonical source.
 */
export function smokeResultToErrors(result: SmokeResult): GateError[] {
  if (result.ok) return [];
  return [{ kind: "smoke", code: result.code, message: result.message }];
}
