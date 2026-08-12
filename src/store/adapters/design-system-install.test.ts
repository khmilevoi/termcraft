import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PackageFileV1 } from "core/ports";
import { parseDesignSystemRef } from "entities/design-system-ref";
import { log } from "infrastructure/debug-log";
import { uuidv7 } from "infrastructure/uuid";
import { sha256Hex } from "store/jsonl";

import {
  createDesignSystemInstallAdapter,
  createDesignSystemQuarantineAdapter,
} from "./design-system-install";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";

afterEach(cleanupScratchRoots);

const scratchDirs: string[] = [];
function freshScratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const REF = parseDesignSystemRef("local:midnight@1.0.0");
if (REF instanceof Error) throw new Error(`fixture bug: ${REF.message}`);

describe("createDesignSystemQuarantineAdapter — contract test (real quarantine)", () => {
  test("maps a limit refusal to RESOURCE_LIMIT_EXCEEDED", async () => {
    const adapter = createDesignSystemQuarantineAdapter({
      userStateRoot: freshScratch("tc-quarantine-userstate-"),
    });
    // Exceeds NAMESPACE_LIMITS["design-source"].perFileBytes (2 MiB) — the real budget
    // `createDesignSourceAdmission`/`snapshotToCandidate` apply, never `allowAllPackageAdmission`.
    const oversized: PackageFileV1 = {
      relPath: "design-system.json",
      bytes: new Uint8Array(3 * 1024 * 1024),
    };
    const result = await adapter.admit({ installId: uuidv7(), files: [oversized] });
    expect(result).toHaveProperty("code", "RESOURCE_LIMIT_EXCEEDED");
  });

  test("maps any other fault to PERSISTENCE_FAILED", async () => {
    const adapter = createDesignSystemQuarantineAdapter({
      userStateRoot: freshScratch("tc-quarantine-userstate-"),
    });
    // A package-relative path that would escape the package root once joined — refused by
    // `admitPackageThroughQuarantine`'s own containment check, not a limit fault.
    const escaping: PackageFileV1 = { relPath: "../escape.json", bytes: bytesOf("{}") };
    const result = await adapter.admit({ installId: uuidv7(), files: [escaping] });
    expect(result).toHaveProperty("code", "PERSISTENCE_FAILED");
  });

  test("M1: an ordinary QuarantineFailedError is a KNOWN store error — no unmapped-error warn", async () => {
    // `failure.ts`'s own header: "a KNOWN store error must never reach" the final unmapped-error
    // branch, which logs `console.warn` on every hit — an ordinary, expected quarantine refusal
    // (a package path escaping the package root, exactly like the test above) must not be logged
    // as if it were a surprise. This reproduces the SAME scenario as "maps any other fault to
    // PERSISTENCE_FAILED" above, but asserts the warn side effect too, not just the DTO code.
    const warnSpy = spyOn(log, "warn");
    warnSpy.mockClear();
    try {
      const adapter = createDesignSystemQuarantineAdapter({
        userStateRoot: freshScratch("tc-quarantine-userstate-"),
      });
      const escaping: PackageFileV1 = { relPath: "../escape.json", bytes: bytesOf("{}") };
      const result = await adapter.admit({ installId: uuidv7(), files: [escaping] });
      expect(result).toHaveProperty("code", "PERSISTENCE_FAILED");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("admits a well-formed package and reads its bytes back through the candidate", async () => {
    const adapter = createDesignSystemQuarantineAdapter({
      userStateRoot: freshScratch("tc-quarantine-userstate-"),
    });
    const file: PackageFileV1 = {
      relPath: "design-system.json",
      bytes: bytesOf('{"id":"midnight"}'),
    };
    const result = await adapter.admit({ installId: uuidv7(), files: [file] });
    if ("code" in result) throw new Error(`fixture bug: ${result.safeMessage}`);
    expect(result.files).toEqual([file]);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("discard is best-effort and never throws, even for an unknown installId", () => {
    const adapter = createDesignSystemQuarantineAdapter({
      userStateRoot: freshScratch("tc-quarantine-userstate-"),
    });
    expect(() => adapter.discard(uuidv7())).not.toThrow();
  });
});

describe("createDesignSystemInstallAdapter — contract test (real project)", () => {
  test("writes design/system/** and the provenance record in one transaction", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createDesignSystemInstallAdapter(deps);
      const provenanceBytes = adapter.encodeProvenance({
        ref: REF,
        contentHash: sha256Hex(bytesOf("stub-package-bytes")),
        installedAt: "2026-08-12T00:00:00Z",
      });

      const result = await adapter.install({
        nextFiles: [
          { treeRelPath: "system/design-system.json", bytes: bytesOf('{"id":"midnight"}') },
        ],
        removedTreeRelPaths: [],
        provenanceBytes,
      });
      expect(result).toBeUndefined();

      const written = open.safeFs.readFile("design/system/design-system.json");
      if (written instanceof Error) throw new Error(`fixture bug: ${written.message}`);
      expect(new TextDecoder().decode(written)).toBe('{"id":"midnight"}');

      const provenance = await adapter.readProvenance();
      if (provenance === null || "code" in provenance) {
        throw new Error("fixture bug: expected a decoded provenance record");
      }
      expect(provenance.ref).toEqual(REF);
    } finally {
      await open.close();
    }
  });

  test("readProvenance returns null for a project that never installed — NOT an error", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createDesignSystemInstallAdapter(deps);
      expect(await adapter.readProvenance()).toBeNull();
    } finally {
      await open.close();
    }
  });

  test("readProvenance surfaces a CORRUPT record as a failure, never as null", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      // A corrupt record is not the same fact as an absent one: reporting it as "no source"
      // would silently retract a claim the project made.
      const provenancePath = path.join(open.root, ".termcraft", "design-system-source.json");
      fs.writeFileSync(provenancePath, "{ not json");

      const adapter = createDesignSystemInstallAdapter(deps);
      const result = await adapter.readProvenance();
      expect(result).toHaveProperty("code");
    } finally {
      await open.close();
    }
  });
});
