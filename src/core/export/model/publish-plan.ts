import {
  EXPORT_POINTER_TARGET,
  type ExportPointerFileV1,
  type ExportPointerV1,
  type ExportPublishOperationV1,
} from "core/ports";
import type { Sha256Hex } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";

import type { ExportPackageFileV1 } from "./package";

/**
 * `buildExportPublishOperations` (WP-5 Task B2, D-Q2/D-Q5): the PURE translation from an
 * assembled export package's in-memory file list to the `ExportPublishPlanV1.operations`/
 * `.payloads` `core/export/model/publish.ts` hands to `ExportPublishPort.publish` (turn-
 * durability §10 step 4: "every new generation file, then the `current.json` pointer, then
 * old-generation deletes", the exact order this builder emits). No I/O: hashing is the only
 * computation, over bytes already in hand.
 *
 * HASHING: `core` cannot import `store/jsonl`'s `sha256Hex` (module DAG: `core` imports only
 * `entities/` + its own ports/submodules, never `store`), and no shared `entities/
 * infrastructure` byte-hash helper exists yet. `core/protocol/model/canonical-hash.ts`
 * already calls `Bun.CryptoHasher` directly from `core` for ITS OWN (value-canonicalizing)
 * hash, so this file reuses that same Bun-native primitive directly on raw bytes — the
 * identical SHA-256-hex algorithm `store/jsonl`'s `sha256Hex(bytes)` computes, so the two
 * sides agree on every file's digest without either importing the other.
 *
 * THE POINTER'S OWN oldImage (D-Q5): a previous `export/current.json` is not carried on disk
 * as raw bytes by {@link ExportPublishPort.readPointer} (it returns the PARSED
 * {@link ExportPointerV1}), so this builder re-serializes it through the exact same
 * {@link serializeExportPointer} that produces every NEW pointer's bytes. Both sides being
 * canonical (sorted `files` keys, fixed field order) means re-serializing a previously-read
 * pointer reproduces the identical bytes the last publish actually wrote, so the
 * transaction's CAS precondition (`store/adapters/export-publish.ts`'s `buildPrecondition`)
 * matches — this is exactly why D-Q2 requires canonical serialization, not merely a
 * consistent decode.
 *
 * OLD-GENERATION CLEANUP (D-Q5): every file listed in `previousPointer.files` gets a
 * `delete` operation, built straight from that manifest's own sha256/size — the immutable-
 * generation invariant (a generation's files never change after publish) is exactly what
 * makes that manifest entry still a valid `oldImage` at delete time.
 */

export interface BuildExportPublishOperationsInputV1 {
  readonly files: readonly ExportPackageFileV1[];
  readonly generationId: string;
  /** `null` for a project's first-ever publish (no old pointer, hence no deletes). */
  readonly previousPointer: ExportPointerV1 | null;
}

export interface BuildExportPublishOperationsResultV1 {
  /** Caller-ordered (§10 step 4): every new generation file, then `current.json`, then old-generation deletes. */
  readonly operations: readonly ExportPublishOperationV1[];
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}

function sha256HexOfBytes(bytes: Uint8Array): Sha256Hex {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function generationTarget(generationId: string, relPath: string): string {
  return `export/generations/${generationId}/${relPath}`;
}

/**
 * Canonical, deterministic encode of an {@link ExportPointerV1}: sorted `files` keys, fixed
 * top-level field order (D-Q2). The write side (this module) and the read side
 * (`store/adapters/export-publish.ts`'s `readPointer`) both decode/encode through this one
 * shape so a reader and a writer built in parallel cannot silently diverge.
 */
export function serializeExportPointer(pointer: ExportPointerV1): Uint8Array {
  const sortedFiles: Record<string, ExportPointerFileV1> = {};
  for (const relPath of Object.keys(pointer.files).sort()) {
    const entry = pointer.files[relPath];
    if (entry === undefined) continue; // unreachable: relPath comes from Object.keys(pointer.files) itself
    sortedFiles[relPath] = entry;
  }
  const canonical = {
    schemaVersion: pointer.schemaVersion,
    generationId: pointer.generationId,
    files: sortedFiles,
  };
  return new TextEncoder().encode(JSON.stringify(canonical));
}

/** Builds the `replace` operation for every new generation file, in `files` order. Returns each file's own manifest entry alongside so the pointer build below can reuse it without re-hashing. */
function buildFileOperations(
  files: readonly ExportPackageFileV1[],
  generationId: string,
): {
  readonly operations: ExportPublishOperationV1[];
  readonly payloads: Map<string, Uint8Array>;
  readonly manifest: Record<string, ExportPointerFileV1>;
} {
  const operations: ExportPublishOperationV1[] = [];
  const payloads = new Map<string, Uint8Array>();
  const manifest: Record<string, ExportPointerFileV1> = {};

  files.forEach((file, index) => {
    const target = generationTarget(generationId, file.relPath);
    const sha256 = sha256HexOfBytes(file.bytes);
    const size = file.bytes.byteLength;
    const payloadId = uuidv7();

    operations.push({
      index,
      target,
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256, size },
      payloadId,
    });
    payloads.set(payloadId, file.bytes);
    manifest[target] = { sha256, size };
  });

  return { operations, payloads, manifest };
}

/** The `replace` operation for `export/current.json` itself, plus its payload and payload id. */
function buildPointerOperation(input: {
  readonly index: number;
  readonly newPointer: ExportPointerV1;
  readonly previousPointer: ExportPointerV1 | null;
}): {
  readonly operation: ExportPublishOperationV1;
  readonly payload: Uint8Array;
  readonly payloadId: string;
} {
  const bytes = serializeExportPointer(input.newPointer);
  const payloadId = uuidv7();
  const oldImage =
    input.previousPointer === null
      ? ({ state: "absent" } as const)
      : (() => {
          const previousBytes = serializeExportPointer(input.previousPointer);
          return {
            state: "file" as const,
            sha256: sha256HexOfBytes(previousBytes),
            size: previousBytes.byteLength,
          };
        })();

  return {
    operation: {
      index: input.index,
      target: EXPORT_POINTER_TARGET,
      mode: "replace",
      oldImage,
      newImage: { state: "file", sha256: sha256HexOfBytes(bytes), size: bytes.byteLength },
      payloadId,
    },
    payload: bytes,
    payloadId,
  };
}

/** One `delete` operation per file the previous generation owned (D-Q5), sorted by target for determinism regardless of the input manifest's own key order. */
function buildDeleteOperations(
  previousPointer: ExportPointerV1 | null,
  startIndex: number,
): ExportPublishOperationV1[] {
  if (previousPointer === null) return [];
  return Object.keys(previousPointer.files)
    .sort()
    .map((target, offset): ExportPublishOperationV1 | null => {
      const entry = previousPointer.files[target];
      if (entry === undefined) {
        // Unreachable: `target` comes from `Object.keys(previousPointer.files)` itself.
        console.warn(
          `core/export/model/publish-plan: previous pointer manifest lost its own key "${target}" — skipped`,
        );
        return null;
      }
      return {
        index: startIndex + offset,
        target,
        mode: "delete",
        oldImage: { state: "file", sha256: entry.sha256, size: entry.size },
        newImage: { state: "absent" },
      };
    })
    .filter((op): op is ExportPublishOperationV1 => op !== null);
}

/** Builds the full publish plan's operations/payloads from an assembled package (WP-5 Task B2). */
export function buildExportPublishOperations(
  input: BuildExportPublishOperationsInputV1,
): BuildExportPublishOperationsResultV1 {
  const {
    operations: fileOps,
    payloads,
    manifest,
  } = buildFileOperations(input.files, input.generationId);

  const newPointer: ExportPointerV1 = {
    schemaVersion: 1,
    generationId: input.generationId,
    files: manifest,
  };
  const {
    operation: pointerOp,
    payload: pointerPayload,
    payloadId: pointerPayloadId,
  } = buildPointerOperation({
    index: fileOps.length,
    newPointer,
    previousPointer: input.previousPointer,
  });
  payloads.set(pointerPayloadId, pointerPayload);

  const deleteOps = buildDeleteOperations(input.previousPointer, fileOps.length + 1);

  return { operations: [...fileOps, pointerOp, ...deleteOps], payloads };
}
