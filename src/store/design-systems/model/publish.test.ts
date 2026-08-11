import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validManifestObject } from "entities/design-system/model/manifest.fixture";
import { parseDesignSystemId, parseDesignSystemVersion } from "entities/design-system-ref";
import { systemClock } from "infrastructure/clock";

import type { PackageAdmission, PackageFile } from "../types";
import { DuplicatePackageFileError, designSystemContentHash } from "./content-hash";
import { DesignSystemPackageInvalidError, DesignSystemPackageTooLargeError } from "./errors";
import { fetchLocalPackage } from "./fetch";
import { allowAllPackageAdmission, nodeDesignSystemFsDeps } from "./fs-deps";
import { localSystemDir } from "./layout";
import { publishLocalPackage } from "./publish";

const scratchRoots: string[] = [];
function freshScratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ds-publish-"));
  scratchRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

function systemId(raw: string) {
  const id = parseDesignSystemId(raw);
  if (id instanceof Error) throw id;
  return id;
}
function version(raw: string) {
  const v = parseDesignSystemVersion(raw);
  if (v instanceof Error) throw v;
  return v;
}

// `readDesignSystemSummary` now decodes through `entities/design-system`'s decoder (project-
// design-systems §10.1 sync point 1), which enforces materially more than a picker used to need —
// every core token role, cross-theme parity, lowercase-hex values. `validManifestObject` is the
// one shared manifest the decoder actually accepts (see its own doc), overridden here per system.
function manifestFile(id: string, ver: string): PackageFile {
  return {
    relPath: "design-system.json",
    bytes: utf8(
      JSON.stringify({ ...validManifestObject(), id, name: "Midnight", version: ver, components: [] }),
    ),
  };
}

const FILES: readonly PackageFile[] = [
  manifestFile("midnight", "1.2.0"),
  { relPath: "components/Button.tsx", bytes: utf8("export const Button = () => null\n") },
];

function depsFor(root: string, admission: PackageAdmission = allowAllPackageAdmission) {
  return { userStateRoot: root, fs: nodeDesignSystemFsDeps, admission, clock: systemClock };
}

const PKG = { systemId: systemId("midnight"), version: version("1.2.0"), files: FILES };

describe("publishLocalPackage", () => {
  test("writes every file under local/<systemId>/ and returns a receipt at its address", async () => {
    const root = freshScratch();
    const receipt = await publishLocalPackage(depsFor(root), PKG);
    if (receipt instanceof Error) throw receipt;

    expect(receipt.ref).toEqual({
      sourceId: "local",
      systemId: "midnight",
      version: "1.2.0",
    } as never);
    expect(receipt.contentHash).toBe(designSystemContentHash(FILES) as string);
    expect(receipt.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const target = localSystemDir(root, systemId("midnight"));
    expect(fs.readFileSync(path.join(target, "design-system.json"), "utf8")).toContain("midnight");
    expect(fs.existsSync(path.join(target, "components", "Button.tsx"))).toBe(true);
  });

  test("what publish wrote is what fetch reads back, hash for hash", async () => {
    const root = freshScratch();
    const receipt = await publishLocalPackage(depsFor(root), PKG);
    if (receipt instanceof Error) throw receipt;
    const fetched = await fetchLocalPackage(depsFor(root), receipt.ref);
    if (fetched instanceof Error) throw fetched;
    expect(fetched.contentHash).toBe(receipt.contentHash);
  });

  test("replaces an existing system wholesale — a file the new package lacks does not survive", async () => {
    const root = freshScratch();
    expect(await publishLocalPackage(depsFor(root), PKG)).not.toBeInstanceOf(Error);

    const replacement = {
      systemId: systemId("midnight"),
      version: version("1.3.0"),
      files: [manifestFile("midnight", "1.3.0")],
    };
    expect(await publishLocalPackage(depsFor(root), replacement)).not.toBeInstanceOf(Error);

    const target = localSystemDir(root, systemId("midnight"));
    expect(fs.existsSync(path.join(target, "components", "Button.tsx"))).toBe(false);
    expect(fs.readFileSync(path.join(target, "design-system.json"), "utf8")).toContain("1.3.0");
  });

  test("leaves no staging directory behind on success", async () => {
    const root = freshScratch();
    expect(await publishLocalPackage(depsFor(root), PKG)).not.toBeInstanceOf(Error);
    const library = fs.readdirSync(path.join(root, "design-systems", "local"));
    expect(library).toEqual(["midnight"]);
  });

  test("rejects a package whose manifest contradicts the address it is published at", async () => {
    const root = freshScratch();
    expect(
      await publishLocalPackage(depsFor(root), {
        systemId: systemId("midnight"),
        version: version("9.9.9"),
        files: FILES,
      }),
    ).toBeInstanceOf(DesignSystemPackageInvalidError);
  });

  test("rejects a package with no manifest", async () => {
    const root = freshScratch();
    expect(
      await publishLocalPackage(depsFor(root), {
        systemId: systemId("midnight"),
        version: version("1.2.0"),
        files: [{ relPath: "tokens.ts", bytes: utf8("export {}\n") }],
      }),
    ).toBeInstanceOf(DesignSystemPackageInvalidError);
  });

  test("applies admission to the package it was handed", async () => {
    const root = freshScratch();
    const refusing: PackageAdmission = {
      admitFile: () => new Error("candidate tree aggregate exceeded"),
      observeBytes: () => null,
    };
    expect(await publishLocalPackage(depsFor(root, refusing), PKG)).toBeInstanceOf(
      DesignSystemPackageTooLargeError,
    );
    expect(fs.existsSync(localSystemDir(root, systemId("midnight")))).toBe(false);
  });

  test("refuses a package path that escapes the package root", async () => {
    const root = freshScratch();
    expect(
      await publishLocalPackage(depsFor(root), {
        systemId: systemId("midnight"),
        version: version("1.2.0"),
        files: [manifestFile("midnight", "1.2.0"), { relPath: "../escape.ts", bytes: utf8("x") }],
      }),
    ).toBeInstanceOf(DesignSystemPackageInvalidError);
  });

  test("refuses a package listing two spellings of the same path via a repeated separator", async () => {
    // Regression for the review finding: `a/b.ts` and `a//b.ts` used to survive as two distinct
    // relPaths through the content hash while `path.join` silently collapsed them into ONE file
    // on disk — publish "succeeded" with a receipt whose hash described bytes that did not match
    // what a subsequent fetch would read back. `normalizePackageRelPath` now collapses repeated
    // separators, so this is caught as an ordinary duplicate-file refusal instead.
    const root = freshScratch();
    expect(
      await publishLocalPackage(depsFor(root), {
        systemId: systemId("midnight"),
        version: version("1.2.0"),
        files: [
          manifestFile("midnight", "1.2.0"),
          { relPath: "a/b.ts", bytes: utf8("one") },
          { relPath: "a//b.ts", bytes: utf8("two") },
        ],
      }),
    ).toBeInstanceOf(DuplicatePackageFileError);
    expect(fs.existsSync(localSystemDir(root, systemId("midnight")))).toBe(false);
  });
});
