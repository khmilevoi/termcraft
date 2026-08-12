import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import type { DesignSystemRef } from "entities/design-system-ref";

import type { PackageFileV1 } from "./design-system-source";

/**
 * `DesignSystemQuarantinePort` / `DesignSystemInstallPort`: what happens BETWEEN a source's
 * `fetch` and a project's committed `design/system/**` (project-design-systems design §8.3,
 * §8.5, §10.1 Wave 3 / P10). `./design-system-source.ts`'s own header says it declares "only
 * where packages come from and where they go"; this file declares what happens between.
 *
 * `core` MAY NOT IMPORT `store` (docs/architecture/code-structure.md §7), so both capabilities
 * this file names are reached as ports, exactly like every other store capability the Kernel
 * consumes:
 *
 * - QUARANTINE (decision D4). `store/design-systems`' `admitPackageThroughQuarantine`
 *   materializes a fetched package under the user-state root (never inside the project),
 *   applies the real `design-source` safe-fs limit budget and the no-follow walk through
 *   `snapshotToCandidate`, and reads the immutable candidate's bytes back exactly ONCE.
 * - INSTALL (decision D11). `store`'s `TransactionEngine.installDesignSystem` commits every
 *   incoming `system/**` file, every removed tree-relative path, and the provenance record in
 *   ONE recoverable `project-mutation`, so a crash anywhere cannot leave a half-replaced system.
 *
 * NEITHER PORT IS IMPLEMENTED HERE. The real adapters over `store/design-systems` and
 * `store`'s `TransactionEngine` are composition-root wiring for a later task; this file is the
 * contract `core/design-systems/model/install.ts` programs against, and `core/ports/fakes/
 * design-system-install.ts` is the in-memory double that exercises it until then.
 */

/** One file of the incoming design system, TREE-relative (`system/design-system.json`) — the shape `store/transaction`'s `DesignSystemInstallFile` mirrors on the other side of this port. */
export interface DesignSystemInstallFileV1 {
  readonly treeRelPath: string;
  readonly bytes: Uint8Array;
}

export interface DesignSystemQuarantinePort {
  /**
   * Materializes `input.files` into quarantine, applies the safe-fs limits, and reads the
   * immutable candidate's bytes back exactly ONCE (D4, D5) — `files` in the answer are the
   * bytes the Gate must check AND the bytes the transaction must write; nothing upstream of
   * this port may read the package a second time.
   */
  admit(input: {
    readonly installId: string;
    readonly files: readonly PackageFileV1[];
  }): Promise<
    FailureDtoV1 | { readonly contentHash: Sha256Hex; readonly files: readonly PackageFileV1[] }
  >;
  /** Best-effort and idempotent — quarantine is disposable by construction, so a failure to clear it is litter, not a fault. Never fails. */
  discard(installId: string): void;
}

/**
 * The project's record of WHERE its design system came from (§8.5): the reference AND the
 * content hash, so a later re-fetch of the same address is checked against the bytes actually
 * installed, not just trusted by version string.
 */
export interface DesignSystemProvenanceRecordV1 {
  readonly ref: DesignSystemRef;
  readonly contentHash: Sha256Hex;
  /** RFC 3339 UTC. */
  readonly installedAt: string;
}

export interface DesignSystemInstallPort {
  /**
   * Commits every incoming `system/**` file, every TREE-relative path the outgoing system had
   * that the incoming one does not, and the provenance record in ONE transaction (D11) — a
   * crash anywhere is rolled forward or discarded by the recovery scan `openProject` already
   * runs, never a half-replaced system.
   *
   * `expectedTreeRevision` (I2 fix): the whole design tree's `treeRevision`
   * (`entities/design-tree`'s `computeTreeRevision`) AT THE MOMENT the Gate pass that produced
   * this preview ran — `core/design-systems/model/install.ts`'s `DesignSystemPreparedInstallV1
   * .treeRevision`, forwarded verbatim. The real adapter re-verifies it INSIDE the write permit,
   * immediately before writing, and refuses (a tagged drift error, surfaced through this method's
   * ordinary `FailureDtoV1` return) rather than install over a tree that changed since — the same
   * "checked first, inside the permit" CAS discipline `store`'s `renamePageTitle`/`reorderPages`/
   * `removePage` already apply to `design/pages.json` and one page's own entry.
   */
  install(input: {
    readonly nextFiles: readonly DesignSystemInstallFileV1[];
    readonly removedTreeRelPaths: readonly string[];
    readonly provenanceBytes: Uint8Array;
    readonly expectedTreeRevision: string;
  }): Promise<FailureDtoV1 | undefined>;
  encodeProvenance(record: DesignSystemProvenanceRecordV1): Uint8Array;
  /** `null` when the project has never installed from a source — NOT an error (§8.5). */
  readProvenance(): Promise<FailureDtoV1 | DesignSystemProvenanceRecordV1 | null>;
}
