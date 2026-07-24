import { describe, expect, test } from "bun:test";

import { EXPORT_POINTER_TARGET, type ExportPointerV1 } from "core/ports";
import { isCanonicalUuidv7 } from "infrastructure/uuid";

import type { ExportPackageFileV1 } from "./package";
import { buildExportPublishOperations, serializeExportPointer } from "./publish-plan";

const GENERATION_ID = "019789ab-cdef-7000-8000-000000000001";

const FILES: readonly ExportPackageFileV1[] = [
  { relPath: "design-prompt.md", bytes: new TextEncoder().encode("prompt") },
  { relPath: "layout/home.json", bytes: new TextEncoder().encode('{"80x24":{}}') },
];

function findOp(
  operations: ReturnType<typeof buildExportPublishOperations>["operations"],
  target: string,
) {
  const op = operations.find((entry) => entry.target === target);
  if (op === undefined) throw new Error(`fixture bug: no operation for target "${target}"`);
  return op;
}

describe("buildExportPublishOperations", () => {
  test("emits one replace op per file, at export/generations/<generationId>/<relPath>, oldImage absent", () => {
    const { operations } = buildExportPublishOperations({
      files: FILES,
      generationId: GENERATION_ID,
      previousPointer: null,
    });

    for (const file of FILES) {
      const op = findOp(operations, `export/generations/${GENERATION_ID}/${file.relPath}`);
      expect(op.mode).toBe("replace");
      expect(op.oldImage).toEqual({ state: "absent" });
      expect(op.newImage.state).toBe("file");
      if (op.newImage.state !== "file") throw new Error("unreachable");
      expect(op.newImage.size).toBe(file.bytes.byteLength);
      expect(op.newImage.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("every replace op's payloadId is a canonical UUIDv7 key present in payloads, with the exact declared bytes", () => {
    const { operations, payloads } = buildExportPublishOperations({
      files: FILES,
      generationId: GENERATION_ID,
      previousPointer: null,
    });

    const replaceOps = operations.filter((op) => op.mode === "replace");
    expect(replaceOps.length).toBe(FILES.length + 1); // every file plus the pointer itself

    const payloadIds = new Set<string>();
    for (const op of replaceOps) {
      expect(op.payloadId).toBeDefined();
      if (op.payloadId === undefined) continue;
      expect(isCanonicalUuidv7(op.payloadId)).toBe(true);
      payloadIds.add(op.payloadId);
      const bytes = payloads.get(op.payloadId);
      expect(bytes).toBeDefined();
      if (op.newImage.state !== "file" || bytes === undefined) throw new Error("unreachable");
      expect(bytes.byteLength).toBe(op.newImage.size);
    }
    expect(payloadIds.size).toBe(replaceOps.length); // every payloadId is unique
    expect(payloads.size).toBe(replaceOps.length);
  });

  test("a delete op never carries payloadId", () => {
    const previousPointer: ExportPointerV1 = {
      schemaVersion: 1,
      generationId: "019789ab-cdef-7000-8000-000000000000",
      files: {
        "export/generations/019789ab-cdef-7000-8000-000000000000/design-prompt.md": {
          sha256: "a".repeat(64),
          size: 6,
        },
      },
    };
    const { operations } = buildExportPublishOperations({
      files: FILES,
      generationId: GENERATION_ID,
      previousPointer,
    });

    const deleteOps = operations.filter((op) => op.mode === "delete");
    expect(deleteOps.length).toBe(1);
    expect(deleteOps[0]?.payloadId).toBeUndefined();
  });

  test("the current.json op's newImage is the canonical ExportPointerV1 bytes, oldImage absent on a first publish", () => {
    const { operations, payloads } = buildExportPublishOperations({
      files: FILES,
      generationId: GENERATION_ID,
      previousPointer: null,
    });

    const pointerOp = findOp(operations, EXPORT_POINTER_TARGET);
    expect(pointerOp.mode).toBe("replace");
    expect(pointerOp.oldImage).toEqual({ state: "absent" });
    expect(pointerOp.newImage.state).toBe("file");
    if (pointerOp.newImage.state !== "file" || pointerOp.payloadId === undefined) {
      throw new Error("unreachable");
    }

    const bytes = payloads.get(pointerOp.payloadId);
    if (bytes === undefined) throw new Error("fixture bug: pointer payload missing");
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as ExportPointerV1;
    expect(decoded.schemaVersion).toBe(1);
    expect(decoded.generationId).toBe(GENERATION_ID);
    expect(Object.keys(decoded.files).sort()).toEqual(
      FILES.map((f) => `export/generations/${GENERATION_ID}/${f.relPath}`).sort(),
    );
  });

  test("the current.json op's oldImage is the previous pointer's own re-serialized image when one exists", () => {
    const previousPointer: ExportPointerV1 = {
      schemaVersion: 1,
      generationId: "019789ab-cdef-7000-8000-000000000000",
      files: {},
    };
    const previousBytes = serializeExportPointer(previousPointer);

    const { operations } = buildExportPublishOperations({
      files: FILES,
      generationId: GENERATION_ID,
      previousPointer,
    });

    const pointerOp = findOp(operations, EXPORT_POINTER_TARGET);
    expect(pointerOp.oldImage).toEqual({
      state: "file",
      sha256: new Bun.CryptoHasher("sha256").update(previousBytes).digest("hex"),
      size: previousBytes.byteLength,
    });
  });

  test("one delete op per file in the previous pointer's manifest, oldImage taken from it, newImage absent", () => {
    const previousPointer: ExportPointerV1 = {
      schemaVersion: 1,
      generationId: "019789ab-cdef-7000-8000-000000000000",
      files: {
        "export/generations/019789ab-cdef-7000-8000-000000000000/design-prompt.md": {
          sha256: "a".repeat(64),
          size: 6,
        },
        "export/generations/019789ab-cdef-7000-8000-000000000000/layout/home.json": {
          sha256: "b".repeat(64),
          size: 4,
        },
      },
    };
    const { operations } = buildExportPublishOperations({
      files: FILES,
      generationId: GENERATION_ID,
      previousPointer,
    });

    const deleteOps = operations.filter((op) => op.mode === "delete");
    expect(deleteOps.length).toBe(2);
    for (const target of Object.keys(previousPointer.files)) {
      const op = deleteOps.find((entry) => entry.target === target);
      if (op === undefined) throw new Error(`fixture bug: no delete op for "${target}"`);
      const manifestEntry = previousPointer.files[target];
      if (manifestEntry === undefined) throw new Error("fixture bug: missing manifest entry");
      expect(op.oldImage).toEqual({ state: "file", ...manifestEntry });
      expect(op.newImage).toEqual({ state: "absent" });
    }
  });

  test("operation ordering: every new-gen file, then current.json, then every old-gen delete (§10 step 4)", () => {
    const previousPointer: ExportPointerV1 = {
      schemaVersion: 1,
      generationId: "019789ab-cdef-7000-8000-000000000000",
      files: {
        "export/generations/019789ab-cdef-7000-8000-000000000000/design-prompt.md": {
          sha256: "a".repeat(64),
          size: 6,
        },
      },
    };
    const { operations } = buildExportPublishOperations({
      files: FILES,
      generationId: GENERATION_ID,
      previousPointer,
    });

    const kinds = operations.map((op) =>
      op.target === EXPORT_POINTER_TARGET
        ? "pointer"
        : op.mode === "replace"
          ? "new-file"
          : "delete",
    );
    expect(kinds).toEqual(["new-file", "new-file", "pointer", "delete"]);
    // `index` is contiguous, starting at 0, matching the emitted order.
    expect(operations.map((op) => op.index)).toEqual(operations.map((_op, i) => i));
  });

  test("no previous pointer means no delete operations at all", () => {
    const { operations } = buildExportPublishOperations({
      files: FILES,
      generationId: GENERATION_ID,
      previousPointer: null,
    });

    expect(operations.some((op) => op.mode === "delete")).toBe(false);
  });

  test("is deterministic across two builds: every operation's target/mode/image is byte-identical (payloadId aside)", () => {
    const build = () =>
      buildExportPublishOperations({
        files: FILES,
        generationId: GENERATION_ID,
        previousPointer: null,
      });
    const first = build();
    const second = build();

    const strip = (ops: typeof first.operations) =>
      ops.map(({ payloadId: _payloadId, ...rest }) => rest);
    expect(strip(first.operations)).toEqual(strip(second.operations));
  });
});

describe("serializeExportPointer", () => {
  test("sorts files keys canonically regardless of input object key order", () => {
    const a: ExportPointerV1 = {
      schemaVersion: 1,
      generationId: "g",
      files: { b: { sha256: "b".repeat(64), size: 1 }, a: { sha256: "a".repeat(64), size: 2 } },
    };
    const b: ExportPointerV1 = {
      schemaVersion: 1,
      generationId: "g",
      files: { a: { sha256: "a".repeat(64), size: 2 }, b: { sha256: "b".repeat(64), size: 1 } },
    };
    expect(serializeExportPointer(a)).toEqual(serializeExportPointer(b));
  });
});
