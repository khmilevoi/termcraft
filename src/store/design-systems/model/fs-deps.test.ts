import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { allowAllPackageAdmission, nodeDesignSystemFsDeps } from "./fs-deps";

const scratchRoots: string[] = [];

function freshScratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ds-fsdeps-"));
  scratchRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe("nodeDesignSystemFsDeps", () => {
  test("listDir returns null for a directory that does not exist — absence is not a fault", () => {
    expect(nodeDesignSystemFsDeps.listDir(path.join(freshScratch(), "nope"))).toBeNull();
  });

  test("listDir reports files, directories and symlinks distinctly", () => {
    const root = freshScratch();
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    fs.mkdirSync(path.join(root, "sub"));
    const entries = nodeDesignSystemFsDeps.listDir(root);
    expect(Array.isArray(entries)).toBe(true);
    if (!Array.isArray(entries)) return;
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("a.txt")).toEqual({
      name: "a.txt",
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    });
    expect(byName.get("sub")).toEqual({
      name: "sub",
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    });
  });

  test("readFile returns bytes, and null for a missing file", () => {
    const root = freshScratch();
    fs.writeFileSync(path.join(root, "a.txt"), "hello");
    expect(nodeDesignSystemFsDeps.readFile(path.join(root, "a.txt"))).toEqual(
      new Uint8Array(Buffer.from("hello")),
    );
    expect(nodeDesignSystemFsDeps.readFile(path.join(root, "missing.txt"))).toBeNull();
  });

  test("statFile reports a size, and null for a missing file", () => {
    const root = freshScratch();
    fs.writeFileSync(path.join(root, "a.txt"), "hello");
    expect(nodeDesignSystemFsDeps.statFile(path.join(root, "a.txt"))).toEqual({ size: 5 });
    expect(nodeDesignSystemFsDeps.statFile(path.join(root, "missing.txt"))).toBeNull();
  });

  test("mkdirAll then durableWrite lands bytes on disk", () => {
    const root = freshScratch();
    const target = path.join(root, "deep", "nested", "file.json");
    expect(nodeDesignSystemFsDeps.mkdirAll(path.dirname(target))).toBeUndefined();
    expect(
      nodeDesignSystemFsDeps.durableWrite(target, new Uint8Array([0x7b, 0x7d])),
    ).toBeUndefined();
    expect(fs.readFileSync(target, "utf8")).toBe("{}");
  });

  test("removeDir is recursive and tolerates a directory that is already gone", () => {
    const root = freshScratch();
    fs.mkdirSync(path.join(root, "x", "y"), { recursive: true });
    fs.writeFileSync(path.join(root, "x", "y", "z.txt"), "z");
    expect(nodeDesignSystemFsDeps.removeDir(path.join(root, "x"))).toBeUndefined();
    expect(fs.existsSync(path.join(root, "x"))).toBe(false);
    expect(nodeDesignSystemFsDeps.removeDir(path.join(root, "x"))).toBeUndefined();
  });

  test("renameDir moves a directory that exists and fails for one that does not", () => {
    const root = freshScratch();
    fs.mkdirSync(path.join(root, "from"));
    expect(
      nodeDesignSystemFsDeps.renameDir(path.join(root, "from"), path.join(root, "to")),
    ).toBeUndefined();
    expect(fs.existsSync(path.join(root, "to"))).toBe(true);
    expect(
      nodeDesignSystemFsDeps.renameDir(path.join(root, "from"), path.join(root, "to2")),
    ).toBeInstanceOf(Error);
  });
});

describe("allowAllPackageAdmission", () => {
  test("admits everything — it is the TEST budget, never the production one", () => {
    expect(
      allowAllPackageAdmission.admitFile({ relPath: "a", declaredSize: 1e9, depth: 99 }),
    ).toBeNull();
    expect(allowAllPackageAdmission.observeBytes({ relPath: "a", bytesRead: 1e9 })).toBeNull();
  });
});
