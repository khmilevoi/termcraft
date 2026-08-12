import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PackageFile } from "../types";
import { designSystemContentHash } from "./content-hash";
import type { AdmittedPackage, QuarantineDeps } from "./quarantine";
import {
  admitPackageThroughQuarantine,
  discardQuarantine,
  nodeQuarantineFsDeps,
  quarantineInstallDir,
} from "./quarantine";

const INSTALL_ID = "01926a5b-19c2-7c31-9e3a-abc123456789";
const MANIFEST_TEXT = '{"id":"midnight","version":"1.2.0"}';

const encode = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

describe("admitPackageThroughQuarantine", () => {
  let userStateRoot: string;
  let deps: QuarantineDeps;

  beforeEach(() => {
    userStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-quarantine-"));
    deps = { userStateRoot, fs: nodeQuarantineFsDeps() };
  });

  afterEach(() => {
    fs.rmSync(userStateRoot, { recursive: true, force: true });
  });

  function quarantineDirFor(installId: string): string {
    return quarantineInstallDir(userStateRoot, installId);
  }

  test("materializes the package under design/system/ and returns it read back from the candidate", () => {
    const admitted = admitPackageThroughQuarantine(deps, {
      installId: INSTALL_ID,
      files: [
        { relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) },
        { relPath: "components/Button.tsx", bytes: encode("export const Button = () => null;\n") },
      ],
    });
    expect(admitted).not.toBeInstanceOf(Error);
    const value = admitted as AdmittedPackage;
    expect(value.files.map((f) => f.relPath).sort()).toEqual([
      "components/Button.tsx",
      "design-system.json",
    ]);
    const manifest = value.files.find((f) => f.relPath === "design-system.json");
    expect(manifest).toBeDefined();
    expect(decode(manifest!.bytes)).toBe(MANIFEST_TEXT);
  });

  test("the content hash equals designSystemContentHash over the same files", () => {
    const files: PackageFile[] = [{ relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) }];
    const admitted = admitPackageThroughQuarantine(deps, { installId: INSTALL_ID, files });
    expect((admitted as AdmittedPackage).contentHash).toBe(
      designSystemContentHash(files) as string,
    );
  });

  test("§11: a package exceeding the safe-fs limits is REJECTED BEFORE it reaches the candidate", () => {
    const oversize = new Uint8Array(3 * 1024 * 1024); // per-file cap is 2 MiB
    const admitted = admitPackageThroughQuarantine(deps, {
      installId: INSTALL_ID,
      files: [
        { relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) },
        { relPath: "components/Huge.tsx", bytes: oversize },
      ],
    });
    expect(admitted).toBeInstanceOf(Error);
    // The candidate directory must not exist — the limits ran before it was created.
    expect(fs.existsSync(path.join(quarantineDirFor(INSTALL_ID), "candidate"))).toBe(false);
  });

  test("§11: a package past the 512-file cap is rejected before the candidate", () => {
    const files: PackageFile[] = [
      { relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) },
      ...Array.from({ length: 600 }, (_unused, index) => ({
        relPath: `components/C${index}.tsx`,
        bytes: encode("export const C = () => null;\n"),
      })),
    ];
    expect(admitPackageThroughQuarantine(deps, { installId: INSTALL_ID, files })).toBeInstanceOf(
      Error,
    );
    expect(fs.existsSync(path.join(quarantineDirFor(INSTALL_ID), "candidate"))).toBe(false);
  });

  test("a path escaping the package root is refused", () => {
    expect(
      admitPackageThroughQuarantine(deps, {
        installId: INSTALL_ID,
        files: [{ relPath: "../outside.tsx", bytes: encode("x") }],
      }),
    ).toBeInstanceOf(Error);
  });

  test("quarantine lives under the user-state root, never inside a project", () => {
    admitPackageThroughQuarantine(deps, {
      installId: INSTALL_ID,
      files: [{ relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) }],
    });
    expect(quarantineDirFor(INSTALL_ID).startsWith(userStateRoot)).toBe(true);
  });

  test("discardQuarantine removes the whole install directory and is idempotent", () => {
    admitPackageThroughQuarantine(deps, {
      installId: INSTALL_ID,
      files: [{ relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) }],
    });
    discardQuarantine(deps, INSTALL_ID);
    expect(fs.existsSync(quarantineDirFor(INSTALL_ID))).toBe(false);
    discardQuarantine(deps, INSTALL_ID); // no throw, no error
  });

  test("a second install with the same id is a collision, never a silent reuse", () => {
    const files: PackageFile[] = [{ relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) }];
    expect(
      admitPackageThroughQuarantine(deps, { installId: INSTALL_ID, files }),
    ).not.toBeInstanceOf(Error);
    expect(admitPackageThroughQuarantine(deps, { installId: INSTALL_ID, files })).toBeInstanceOf(
      Error,
    );
  });
});
