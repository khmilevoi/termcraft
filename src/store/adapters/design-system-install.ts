import * as errore from "errore";

import type {
  AssertConforms,
  DesignSystemInstallFileV1,
  DesignSystemInstallPort,
  DesignSystemProvenanceRecordV1,
  DesignSystemQuarantinePort,
  PackageFileV1,
} from "core/ports";
import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import {
  DESIGN_SYSTEM_PROVENANCE_FILENAME,
  DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION,
  DesignSystemPackageTooLargeError,
  admitPackageThroughQuarantine,
  decodeDesignSystemProvenance,
  discardQuarantine,
  encodeDesignSystemProvenance,
  nodeQuarantineFsDeps,
} from "store/design-systems";
import { FsAccessError, StorageLimitExceededError, isNotFound } from "store/safe-fs";

import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";
import { nowIso } from "./types";

/**
 * `createDesignSystemQuarantineAdapter` / `createDesignSystemInstallAdapter` — the
 * `DesignSystemQuarantinePort` / `DesignSystemInstallPort` (`core/ports/design-system-install.ts`)
 * over `store/design-systems`' quarantine (Task 4) and `store`'s
 * `TransactionEngine.installDesignSystem` (Task 5). Both ports' own header comments named this
 * wiring as "composition-root wiring for a later task" — this file, and its composition at
 * `src/entrypoint/model/create-shell.ts` (Task 14), is that later task.
 *
 * Both adapters map their tagged errors through `store/adapters/failure.ts`'s `toFailureDto` —
 * the same relationship `createDesignSystemSourceAdapter` (Task 13) has — with one addition:
 * quarantine's limit refusal gets its own `RESOURCE_LIMIT_EXCEEDED` code (see
 * {@link quarantineFailureDto}), because `toFailureDto`'s own top-level `instanceof` check does
 * not walk a `QuarantineFailedError`'s `cause` chain, and `admitPackageThroughQuarantine` wraps
 * some, but not all, of its underlying `store/safe-fs` faults in one.
 */

/**
 * `StorageLimitExceededError` — the real `design-source` limit budget's own refusal — may arrive
 * bare (`snapshotToCandidate`'s own return, passed straight through `admitPackageThroughQuarantine`
 * unwrapped) or nested in a `QuarantineFailedError`'s `cause` chain (an earlier stage's wrapped io
 * failure). `errore.findCause` checks the error itself before walking `.cause`, so one check
 * covers both shapes; `DesignSystemPackageTooLargeError` is included for the same reason even
 * though the quarantine's OWN admission never raises it (P3's local-source `fetch` boundary does)
 * — the brief's mapping table names it explicitly, and checking for it here costs nothing.
 */
function quarantineFailureDto(error: Error): FailureDtoV1 {
  const limitCause =
    errore.findCause(error, StorageLimitExceededError) ??
    errore.findCause(error, DesignSystemPackageTooLargeError);
  if (limitCause !== undefined) {
    return {
      code: "RESOURCE_LIMIT_EXCEEDED",
      retryable: false,
      safeMessage: error.message,
      details: {},
    };
  }
  return toFailureDto(error);
}

export function createDesignSystemQuarantineAdapter(deps: {
  readonly userStateRoot: string;
}): DesignSystemQuarantinePort {
  const quarantineDeps = { userStateRoot: deps.userStateRoot, fs: nodeQuarantineFsDeps() };

  async function admit(input: {
    readonly installId: string;
    readonly files: readonly PackageFileV1[];
  }): Promise<
    FailureDtoV1 | { readonly contentHash: Sha256Hex; readonly files: readonly PackageFileV1[] }
  > {
    const result = admitPackageThroughQuarantine(quarantineDeps, input);
    if (result instanceof Error) return quarantineFailureDto(result);
    return { contentHash: result.contentHash, files: result.files };
  }

  function discard(installId: string): void {
    discardQuarantine(quarantineDeps, installId);
  }

  return { admit, discard };
}

type _ConformsQuarantine = AssertConforms<
  DesignSystemQuarantinePort,
  ReturnType<typeof createDesignSystemQuarantineAdapter>
>;

export function createDesignSystemInstallAdapter(deps: StoreAdapterDeps): DesignSystemInstallPort {
  const { open } = deps;

  async function install(input: {
    readonly nextFiles: readonly DesignSystemInstallFileV1[];
    readonly removedTreeRelPaths: readonly string[];
    readonly provenanceBytes: Uint8Array;
  }): Promise<FailureDtoV1 | undefined> {
    const result = await open.transactions.installDesignSystem({
      transactionId: deps.uuidv7(),
      actionId: deps.uuidv7(),
      nextFiles: input.nextFiles,
      removedTreeRelPaths: input.removedTreeRelPaths,
      provenanceBytes: input.provenanceBytes,
      createdAt: nowIso(deps.clock),
    });
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  function encodeProvenance(record: DesignSystemProvenanceRecordV1): Uint8Array {
    return encodeDesignSystemProvenance({
      schemaVersion: DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION,
      ref: record.ref,
      contentHash: record.contentHash,
      installedAt: record.installedAt,
    });
  }

  /** `null` for "never installed" (§8.5) — NEVER for a record that exists but fails to decode; a
   *  corrupt record is a distinct fact from an absent one and must surface as a failure. */
  async function readProvenance(): Promise<FailureDtoV1 | DesignSystemProvenanceRecordV1 | null> {
    const bytes = open.safeFs.readFile(DESIGN_SYSTEM_PROVENANCE_FILENAME);
    if (bytes instanceof Error) {
      if (bytes instanceof FsAccessError && isNotFound(bytes)) return null;
      return toFailureDto(bytes);
    }

    const decoded = decodeDesignSystemProvenance(bytes);
    if (decoded instanceof Error) return toFailureDto(decoded);
    return {
      ref: decoded.ref,
      contentHash: decoded.contentHash,
      installedAt: decoded.installedAt,
    };
  }

  return { install, encodeProvenance, readProvenance };
}

type _ConformsInstall = AssertConforms<
  DesignSystemInstallPort,
  ReturnType<typeof createDesignSystemInstallAdapter>
>;
