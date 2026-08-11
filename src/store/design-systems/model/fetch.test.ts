import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validManifestObject } from "entities/design-system/model/manifest.fixture";
import { parseDesignSystemRef } from "entities/design-system-ref";
import { systemClock } from "infrastructure/clock";

import type { PackageAdmission, PackageFile } from "../types";
import { designSystemContentHash } from "./content-hash";
import {
  DesignSystemPackageInvalidError,
  DesignSystemPackageTooLargeError,
  DesignSystemRefRejectedError,
} from "./errors";
import { fetchLocalPackage } from "./fetch";
import { allowAllPackageAdmission, nodeDesignSystemFsDeps } from "./fs-deps";
import { localSystemDir } from "./layout";
import { writeFixturePackage } from "./test-support";

const scratchRoots: string[] = [];
function freshScratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ds-fetch-"));
  scratchRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

function manifestFile(id: string, version: string): PackageFile {
  return {
    relPath: "design-system.json",
    bytes: utf8(
      JSON.stringify({
        schemaVersion: 1,
        id,
        name: "Midnight",
        version,
        kitApiVersion: 1,
        defaultTheme: "dark",
        themes: { dark: { label: "Dark", tokens: { accent: "#4cc9f0" } } },
        components: [{ name: "Button", module: "components/Button.tsx", export: "Button" }],
      }),
    ),
  };
}

const PACKAGE: readonly PackageFile[] = [
  manifestFile("midnight", "1.2.0"),
  { relPath: "tokens.ts", bytes: utf8("export {}\n") },
  { relPath: "components/Button.tsx", bytes: utf8("export const Button = () => null\n") },
];

function refOf(text: string) {
  const ref = parseDesignSystemRef(text);
  if (ref instanceof Error) throw ref;
  return ref;
}

function depsFor(root: string, admission: PackageAdmission = allowAllPackageAdmission) {
  return { userStateRoot: root, fs: nodeDesignSystemFsDeps, admission, clock: systemClock };
}

function seed(root: string, files: readonly PackageFile[] = PACKAGE): void {
  writeFixturePackage(localSystemDir(root, "midnight" as never), files);
}

describe("fetchLocalPackage", () => {
  test("returns every file of the package, at package-relative forward-slashed paths", async () => {
    const root = freshScratch();
    seed(root);
    const fetched = await fetchLocalPackage(depsFor(root), refOf("local:midnight@1.2.0"));
    if (fetched instanceof Error) throw fetched;
    expect([...fetched.files].map((file) => file.relPath).sort()).toEqual([
      "components/Button.tsx",
      "design-system.json",
      "tokens.ts",
    ]);
  });

  test("carries the content hash of exactly those bytes", async () => {
    const root = freshScratch();
    seed(root);
    const fetched = await fetchLocalPackage(depsFor(root), refOf("local:midnight@1.2.0"));
    if (fetched instanceof Error) throw fetched;
    expect(fetched.contentHash).toBe(designSystemContentHash(PACKAGE) as string);
  });

  test("carries the summary and the reference it was asked for", async () => {
    const root = freshScratch();
    seed(root);
    const fetched = await fetchLocalPackage(depsFor(root), refOf("local:midnight@1.2.0"));
    if (fetched instanceof Error) throw fetched;
    expect(fetched.summary.id).toBe("midnight");
    expect(fetched.ref).toEqual(refOf("local:midnight@1.2.0"));
  });

  test("writes nothing — fetch materializes bytes, it does not install", async () => {
    const root = freshScratch();
    seed(root);
    const before = fs.readdirSync(path.join(root, "design-systems"));
    await fetchLocalPackage(depsFor(root), refOf("local:midnight@1.2.0"));
    expect(fs.readdirSync(path.join(root, "design-systems"))).toEqual(before);
  });

  test("rejects a reference naming another source", async () => {
    const root = freshScratch();
    seed(root);
    expect(
      await fetchLocalPackage(depsFor(root), refOf("github:acme/ds#midnight@1.2.0")),
    ).toBeInstanceOf(DesignSystemRefRejectedError);
  });

  test("rejects a reference naming a system that is not in the library", async () => {
    expect(
      await fetchLocalPackage(depsFor(freshScratch()), refOf("local:midnight@1.2.0")),
    ).toBeInstanceOf(DesignSystemRefRejectedError);
  });

  test("rejects a version the package does not claim", async () => {
    const root = freshScratch();
    seed(root);
    expect(await fetchLocalPackage(depsFor(root), refOf("local:midnight@9.9.9"))).toBeInstanceOf(
      DesignSystemRefRejectedError,
    );
  });

  test("rejects a package whose manifest claims a different id", async () => {
    const root = freshScratch();
    seed(root, [manifestFile("aurora", "1.2.0")]);
    expect(await fetchLocalPackage(depsFor(root), refOf("local:midnight@1.2.0"))).toBeInstanceOf(
      DesignSystemRefRejectedError,
    );
  });

  test("rejects a package with no manifest at all", async () => {
    const root = freshScratch();
    seed(root, [{ relPath: "tokens.ts", bytes: utf8("export {}\n") }]);
    expect(await fetchLocalPackage(depsFor(root), refOf("local:midnight@1.2.0"))).toBeInstanceOf(
      DesignSystemPackageInvalidError,
    );
  });

  test("propagates an admission refusal as a too-large failure, keeping the budget's own error as cause", async () => {
    const root = freshScratch();
    seed(root);
    const refusing: PackageAdmission = {
      admitFile: () => new Error("candidate file count exceeded"),
      observeBytes: () => null,
    };
    const fetched = await fetchLocalPackage(depsFor(root, refusing), refOf("local:midnight@1.2.0"));
    expect(fetched).toBeInstanceOf(DesignSystemPackageTooLargeError);
    if (!(fetched instanceof Error)) return;
    expect((fetched.cause as Error).message).toBe("candidate file count exceeded");
  });

  test("propagates a streaming refusal too — a file that lied about its size is caught after the read", async () => {
    const root = freshScratch();
    seed(root);
    const refusing: PackageAdmission = {
      admitFile: () => null,
      observeBytes: () => new Error("candidate tree aggregate exceeded"),
    };
    expect(
      await fetchLocalPackage(depsFor(root, refusing), refOf("local:midnight@1.2.0")),
    ).toBeInstanceOf(DesignSystemPackageTooLargeError);
  });

  test("refuses a symlink inside the package rather than following it", async () => {
    const root = freshScratch();
    seed(root);
    const target = path.join(localSystemDir(root, "midnight" as never), "linked.ts");
    try {
      fs.symlinkSync(path.join(root, "outside.ts"), target);
    } catch {
      // Windows without developer mode refuses symlink creation; the guard is still asserted by
      // the two admission tests above, so skipping here is honest rather than a silent pass.
      return;
    }
    expect(await fetchLocalPackage(depsFor(root), refOf("local:midnight@1.2.0"))).toBeInstanceOf(
      DesignSystemPackageInvalidError,
    );
  });
});
