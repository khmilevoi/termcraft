import * as errore from "errore";

import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import { formatDesignSystemRef, parseDesignSystemRef } from "entities/design-system-ref";

import type {
  DesignSystemInstallFileV1,
  DesignSystemInstallPort,
  DesignSystemProvenanceRecordV1,
  DesignSystemQuarantinePort,
} from "../design-system-install";
import type { PackageFileV1 } from "../design-system-source";
import type { AssertConforms } from "../index";

/**
 * In-memory {@link DesignSystemQuarantinePort} + {@link DesignSystemInstallPort} fake, combined
 * in one object: both ports exist only to let `core/design-systems/model/install.ts` reach
 * `store` capabilities without `core` importing `store`, and every production caller composes
 * them from the same underlying user-state root / project, so one fake covers both here too.
 *
 * `admit()` is an IDENTITY pass-through by default — it echoes back exactly the files it was
 * given, with a deterministic fake content hash — because this fake has no real quarantine
 * directory to write bytes into and read back. A test that needs to prove the pipeline reads
 * the CANDIDATE's bytes rather than the fetched package's own (§8.3) composes its own thin
 * wrapper around `admit()` rather than this fake growing a rewrite feature it has no other use
 * for — see `core/design-systems/model/install.test.ts`'s own `createFakePorts` helper.
 *
 * `install()` DECODES the `provenanceBytes` it receives (with its own small JSON codec — this
 * fake may not import `store/design-systems`' real `encodeDesignSystemProvenance`, since
 * `core/ports/fakes` is still `core`-side) so a test can assert on the RECORD
 * (`recordedProvenance`), never on opaque bytes. `encodeProvenance()` is this same codec's
 * write half, so a caller's `encodeProvenance` -> `install` round-trip always decodes cleanly.
 */

export type DesignSystemInstallFailableMethod = "admit" | "install" | "readProvenance";

export type FakeDesignSystemInstallCall =
  | { readonly method: "admit"; readonly installId: string; readonly fileCount: number }
  | { readonly method: "discard"; readonly installId: string }
  | {
      readonly method: "install";
      readonly nextFileCount: number;
      readonly removedCount: number;
    }
  | { readonly method: "encodeProvenance"; readonly ref: string }
  | { readonly method: "readProvenance" };

/** One recorded `install()` call's file-shaped input — the exact bytes/paths the transaction would have committed. */
export interface RecordedDesignSystemInstallV1 {
  readonly nextFiles: readonly DesignSystemInstallFileV1[];
  readonly removedTreeRelPaths: readonly string[];
  /** I2 fix: the `expectedTreeRevision` the caller passed — lets a `core`-level test prove `commitDesignSystemInstall` forwards `DesignSystemPreparedInstallV1.treeRevision` verbatim, without this fake modelling any real drift refusal itself (that behavior is `store`'s, real-transaction-only). */
  readonly expectedTreeRevision: string;
}

export interface FakeDesignSystemInstall
  extends DesignSystemQuarantinePort, DesignSystemInstallPort {
  readonly calls: readonly FakeDesignSystemInstallCall[];
  /** Every `discard(installId)` call, in order — including repeats. */
  readonly discarded: readonly string[];
  /** Every SUCCESSFUL `install()` call's file-shaped input, in order. */
  readonly recordedInstalls: readonly RecordedDesignSystemInstallV1[];
  /** Every SUCCESSFUL `install()` call's DECODED provenance record, in order, index-aligned with {@link recordedInstalls}. */
  readonly recordedProvenance: readonly DesignSystemProvenanceRecordV1[];
  failNext(method: DesignSystemInstallFailableMethod, failure: FailureDtoV1): void;
  /** Primes `readProvenance()`'s next non-queued-failure answer (default `null` — "never installed", §8.5). */
  seedProvenance(record: DesignSystemProvenanceRecordV1 | null): void;
}

/** A deterministic, valid-looking 64-hex-char {@link Sha256Hex} derived from a seed — no crypto, no randomness. */
function fakeSha256Hex(seed: string): Sha256Hex {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  const base = (h >>> 0).toString(16).padStart(8, "0");
  return base.repeat(8).slice(0, 64);
}

class FakeProvenanceCodecError extends errore.createTaggedError({
  name: "FakeProvenanceCodecError",
  message: "fake provenance bytes did not decode: $reason",
}) {}

/** This fake's own small, self-consistent codec — never `store/design-systems`' real one (a `core`-side fake may not import `store`). */
function encodeFakeProvenance(record: DesignSystemProvenanceRecordV1): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      ref: formatDesignSystemRef(record.ref),
      contentHash: record.contentHash,
      installedAt: record.installedAt,
    }),
  );
}

function decodeFakeProvenance(
  bytes: Uint8Array,
): FakeProvenanceCodecError | DesignSystemProvenanceRecordV1 {
  const text = errore.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) => new FakeProvenanceCodecError({ reason: "not valid UTF-8", cause }),
  });
  if (text instanceof Error) return text;

  const parsed = errore.try({
    try: () => JSON.parse(text) as Record<string, unknown>,
    catch: (cause) => new FakeProvenanceCodecError({ reason: "not JSON", cause }),
  });
  if (parsed instanceof Error) return parsed;

  const { ref: rawRef, contentHash, installedAt } = parsed;
  if (
    typeof rawRef !== "string" ||
    typeof contentHash !== "string" ||
    typeof installedAt !== "string"
  )
    return new FakeProvenanceCodecError({ reason: "missing or non-string fields" });

  const ref = parseDesignSystemRef(rawRef);
  if (ref instanceof Error)
    return new FakeProvenanceCodecError({ reason: ref.message, cause: ref });

  return { ref, contentHash, installedAt };
}

export function createFakeDesignSystemInstall(): FakeDesignSystemInstall {
  const calls: FakeDesignSystemInstallCall[] = [];
  const discarded: string[] = [];
  const recordedInstalls: RecordedDesignSystemInstallV1[] = [];
  const recordedProvenance: DesignSystemProvenanceRecordV1[] = [];
  let provenanceSeed: DesignSystemProvenanceRecordV1 | null = null;

  const queues: Record<DesignSystemInstallFailableMethod, FailureDtoV1[]> = {
    admit: [],
    install: [],
    readProvenance: [],
  };

  function failNext(method: DesignSystemInstallFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  function seedProvenance(record: DesignSystemProvenanceRecordV1 | null): void {
    provenanceSeed = record;
  }

  async function admit(input: {
    installId: string;
    files: readonly PackageFileV1[];
  }): Promise<FailureDtoV1 | { contentHash: Sha256Hex; files: readonly PackageFileV1[] }> {
    calls.push({ method: "admit", installId: input.installId, fileCount: input.files.length });
    const queued = queues.admit.shift();
    if (queued !== undefined) return queued;
    return { contentHash: fakeSha256Hex(input.installId), files: input.files };
  }

  function discard(installId: string): void {
    calls.push({ method: "discard", installId });
    discarded.push(installId);
  }

  async function install(input: {
    nextFiles: readonly DesignSystemInstallFileV1[];
    removedTreeRelPaths: readonly string[];
    provenanceBytes: Uint8Array;
    expectedTreeRevision: string;
  }): Promise<FailureDtoV1 | undefined> {
    calls.push({
      method: "install",
      nextFileCount: input.nextFiles.length,
      removedCount: input.removedTreeRelPaths.length,
    });
    const queued = queues.install.shift();
    if (queued !== undefined) return queued;

    const decoded = decodeFakeProvenance(input.provenanceBytes);
    if (decoded instanceof Error)
      return {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: `fake install() received undecodable provenance bytes: ${decoded.message}`,
        details: {},
      };

    recordedInstalls.push({
      nextFiles: input.nextFiles,
      removedTreeRelPaths: input.removedTreeRelPaths,
      expectedTreeRevision: input.expectedTreeRevision,
    });
    recordedProvenance.push(decoded);
    return undefined;
  }

  function encodeProvenance(record: DesignSystemProvenanceRecordV1): Uint8Array {
    calls.push({ method: "encodeProvenance", ref: formatDesignSystemRef(record.ref) });
    return encodeFakeProvenance(record);
  }

  async function readProvenance(): Promise<FailureDtoV1 | DesignSystemProvenanceRecordV1 | null> {
    calls.push({ method: "readProvenance" });
    const queued = queues.readProvenance.shift();
    if (queued !== undefined) return queued;
    return provenanceSeed;
  }

  return {
    admit,
    discard,
    install,
    encodeProvenance,
    readProvenance,
    calls,
    discarded,
    recordedInstalls,
    recordedProvenance,
    failNext,
    seedProvenance,
  };
}

type _ConformsQuarantine = AssertConforms<DesignSystemQuarantinePort, FakeDesignSystemInstall>;
type _ConformsInstall = AssertConforms<DesignSystemInstallPort, FakeDesignSystemInstall>;
